#!/usr/bin/env python
"""备用安装包补丁：识别 Codex 的过载倒计时表，等长修改并支持还原。

默认只读检查；--apply 写入，--revert 还原，--selftest 运行隔离测试。
识别压缩后的变量名与对应 getter，不再绑定 LDr，也支持多个 renderer 副本。
"""

import ctypes
import json
import mmap
import os
import pathlib
import re
import struct
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

BEFORE_STEPS = b'[10,30,120,300]'
AFTER_STEPS = b'[1,1,2,2,3,3,4]'
assert len(BEFORE_STEPS) == len(AFTER_STEPS)
IDENT = rb'[A-Za-z_$][A-Za-z0-9_$]*'
ARRAY_RE = re.compile(
    rb'(?<![A-Za-z0-9_$])(?P<table>' + IDENT +
    rb')=(?P<steps>\[(?:10,30,120,300|1,1,2,2,3,3,4)\])'
)
STATE = pathlib.Path(os.environ['LOCALAPPDATA']) / 'codex-retry-patch.json'


def find_asar():
    result = subprocess.run(
        ['powershell', '-NoProfile', '-Command',
         "(Get-AppxPackage -Name 'OpenAI.Codex').InstallLocation"],
        capture_output=True, text=True, creationflags=0x08000000)
    location = result.stdout.strip()
    if not location:
        sys.exit('找不到 OpenAI.Codex 套件')
    path = pathlib.Path(location) / 'app' / 'resources' / 'app.asar'
    if not path.is_file():
        sys.exit(f'找不到 {path}')
    return path


def renderer_sections(mm):
    """读取 ASAR 文件边界，避免跨文件配对或修改非 renderer 代码。"""
    if len(mm) < 16:
        raise ValueError('ASAR 文件头不完整')
    magic, header_size, _, json_size = struct.unpack('<4I', mm[:16])
    start = 8 + header_size
    if magic != 4 or header_size < 8 or json_size > header_size - 8 or start > len(mm):
        raise ValueError('ASAR 文件头无效')
    header = json.loads(mm[16:16 + json_size])

    def walk(node, prefix=''):
        for name, entry in node['files'].items():
            relative = prefix + name
            if 'files' in entry:
                yield from walk(entry, relative + '/')
            elif (relative.startswith('webview/') and relative.endswith('.js')
                  and 'offset' in entry and not entry.get('unpacked')):
                offset = start + int(entry['offset'])
                end = offset + int(entry['size'])
                if offset < start or end < offset or end > len(mm):
                    raise ValueError(f'ASAR 文件边界无效：{relative}')
                yield relative, offset, end

    yield from walk(header)


def survey(path, revert):
    todo, done, bad = [], [], []
    recognized = 0
    with open(path, 'rb') as file:
        with mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            try:
                for relative, start, end in renderer_sections(mm):
                    # 按钮标识与 failed/codexErrorInfo 循环共同确认这是过载倒计时 getter。
                    if (mm.find(b'localConversation.serverOverloaded.retry', start, end) < 0
                            or mm.find(b'localConversation.serverOverloaded.retryCountdown', start, end) < 0):
                        continue
                    body = mm[start:end]
                    for array in ARRAY_RE.finditer(body):
                        table = array.group('table')
                        scope = body[array.end():array.end() + 2400]
                        if (table + b'.length' not in scope or b'codexErrorInfo' not in scope
                                or b'"failed"' not in scope):
                            bad.append(f'{relative}: 倒计时表 {table.decode()} 的上下文无法确认')
                            continue
                        returns = list(re.finditer(
                            rb'\breturn ' + re.escape(table) + rb'\[(?P<index>' + IDENT +
                            rb')(?P<cycle>%7)?\](?P<tail>\?\?null|\|\|1;)', scope))
                        if len(returns) != 1:
                            bad.append(f'{relative}: {table.decode()} 的返回表达式匹配 {len(returns)} 处，预期 1 处')
                            continue
                        result = returns[0]
                        if bool(result.group('cycle')) != (result.group('tail') == b'||1;'):
                            bad.append(f'{relative}: 返回表达式不是完整的原版或补丁版')
                            continue
                        recognized += 1
                        index = result.group('index')
                        before_return = b'return ' + table + b'[' + index + b']??null'
                        after_return = b'return ' + table + b'[' + index + b'%7]||1;'
                        pairs = [
                            (start + array.start('steps'), array.group('steps'), BEFORE_STEPS, AFTER_STEPS),
                            (start + array.end() + result.start(), result.group(), before_return, after_return),
                        ]
                        for offset, current, before, after in pairs:
                            assert len(before) == len(after), '补丁长度不一致'
                            src, dst = (after, before) if revert else (before, after)
                            description = f'{relative}: {src.decode()} -> {dst.decode()}'
                            if current == src:
                                todo.append((offset, dst, description))
                            elif current == dst:
                                done.append(description)
                            else:
                                bad.append(f'{relative}: offset {offset} 的内容与预期不一致')
            except (ValueError, KeyError, TypeError, struct.error) as error:
                bad.append(str(error))
    if not recognized:
        bad.append('没有找到可确认的 Codex 过载倒计时 getter，拒绝修改')
    return todo, done, bad


def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def write_all(path, todo):
    target = str(path)
    subprocess.run(['takeown', '/F', target], capture_output=True, creationflags=0x08000000)
    subprocess.run(['icacls', target, '/grant', 'Administrators:F'],
                   capture_output=True, creationflags=0x08000000)
    try:
        with open(path, 'r+b') as file:
            for offset, data, _ in todo:
                file.seek(offset)
                file.write(data)
    finally:
        subprocess.run(['icacls', target, '/setowner', r'NT SERVICE\TrustedInstaller'],
                       capture_output=True, creationflags=0x08000000)
        subprocess.run(['icacls', target, '/remove:g', 'Administrators'],
                       capture_output=True, creationflags=0x08000000)


def main():
    apply_, revert = '--apply' in sys.argv, '--revert' in sys.argv
    asar = find_asar()
    print(f'app.asar : {asar}')
    print(f'大小     : {asar.stat().st_size} bytes')
    todo, done, bad = survey(asar, revert)
    for description in done:
        print(f'已完成   : {description}')
    for problem in bad:
        print(f'异常     : {problem}')
    if bad:
        sys.exit('\n无法唯一确认补丁位置，未修改安装包。')
    if not todo:
        print('\n已经是目标状态。')
        return
    for offset, _, description in todo:
        print(f'待写入   : offset {offset} ({offset:#x})  {description}')
    if not (apply_ or revert):
        print('\n只读检查通过；实际写入需要以管理员身份使用 --apply。')
        return
    if not is_admin():
        sys.exit('\n实际写入需要管理员权限。')
    size_before = asar.stat().st_size
    write_all(asar, todo)
    if asar.stat().st_size != size_before:
        sys.exit('写入后文件大小变化，请还原或重新安装 Codex。')
    remaining, _, problems = survey(asar, revert)
    if remaining or problems:
        sys.exit(f'写入后验证失败：{problems or remaining}')
    STATE.write_text(json.dumps({
        'asar': str(asar), 'state': 'reverted' if revert else 'patched',
        'offsets': [offset for offset, _, _ in todo],
    }), encoding='utf-8')
    print(f'\n完成 {len(todo)} 处等长修改；重启 Codex 后生效。')


def selftest():
    import tempfile

    def getter(table, index):
        return (
            b'const labels=["localConversation.serverOverloaded.retry",'
            b'"localConversation.serverOverloaded.retryCountdown"];let ' + table + b'=' + BEFORE_STEPS +
            b';function delay(n){let ' + index + b'=0;for(let e=n.length-1;e>0&&' + index +
            b'<' + table + b'.length;e--){let a=n[e];if(a.status!=="failed"||!a.codexErrorInfo)break;'
            + index + b'+=1}return ' + table + b'[' + index + b']??null}'
        )

    def archive(bodies):
        files = {}
        offset = 0
        for index, body in enumerate(bodies):
            files[f'retry-{index}.js'] = {'size': len(body), 'offset': str(offset)}
            offset += len(body)
        header = {'files': {'webview': {'files': {'assets': {'files': files}}}}}
        data = json.dumps(header, separators=(',', ':')).encode()
        padded = (len(data) + 3) // 4 * 4
        return struct.pack('<4I', 4, 8 + padded, 4 + padded, len(data)) + data + b'\0' * (padded - len(data)) + b''.join(bodies)

    scratch = (pathlib.Path.cwd() / '.workbuddy' / 'patch-selftest').resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='codex-retry-', dir=scratch) as directory:
        # TemporaryDirectory 清理前确认目标位于本测试的专用目录。
        assert pathlib.Path(directory).resolve().is_relative_to(scratch)
        path = pathlib.Path(directory) / 'app.asar'
        for bodies in [[getter(b'LDr', b'r')], [getter(b'q', b'a'), getter(b'Z', b'i')], [getter(b'$d', b'_r')]]:
            original = archive(bodies)
            path.write_bytes(original)
            todo, done, bad = survey(path, False)
            assert not done and not bad and len(todo) == 2 * len(bodies), (todo, done, bad)
            # 模拟只写入一处后中断，后续检查仍能补齐；不用触碰 WindowsApps。
            offset, data, _ = todo[0]
            with path.open('r+b') as file:
                file.seek(offset)
                file.write(data)
            remaining, done, bad = survey(path, False)
            assert not bad and len(done) == 1 and len(remaining) == len(todo) - 1
            with path.open('r+b') as file:
                for offset, data, _ in remaining:
                    file.seek(offset)
                    file.write(data)
            assert path.stat().st_size == len(original)
            remaining, done, bad = survey(path, False)
            assert not remaining and not bad and len(done) == 2 * len(bodies)
            back, _, bad = survey(path, True)
            assert not bad and len(back) == 2 * len(bodies)
            with path.open('r+b') as file:
                for offset, data, _ in back:
                    file.seek(offset)
                    file.write(data)
            assert path.read_bytes() == original, '还原后必须逐字节一致'

        unrelated = archive([b'let q=[10,30,120,300];function x(a){return q[a]??null}'])
        path.write_bytes(unrelated)
        assert survey(path, False)[2] and path.read_bytes() == unrelated
        ambiguous = archive([getter(b'q', b'a') + b';function other(a){return q[a]??null}'])
        path.write_bytes(ambiguous)
        assert survey(path, False)[2] and path.read_bytes() == ambiguous
        path.write_bytes(b'not an asar')
        assert survey(path, False)[2]
    print('ok  (旧新变量名 / 多份 renderer / 等长写入 / 中断补齐 / 精确还原 / 无关与歧义拒绝)')


if __name__ == '__main__':
    selftest() if '--selftest' in sys.argv else main()
