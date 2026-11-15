#!/usr/bin/env python
"""核对 PyInstaller EXE 内嵌的完整 hook 源码，并输出发布文件的 SHA-256。"""
import argparse
import hashlib
import json
import pathlib
import sys

from PyInstaller.archive.readers import CArchiveReader

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from codex_hook import hook_version


def normalize_source(data):
    # Git 的 Windows checkout 可能转换行尾；只忽略 CRLF/LF 差异。
    return data.decode('utf-8').replace('\r\n', '\n')


def verify_package(executable, source):
    archive = CArchiveReader(str(executable))
    names = [name for name in archive.toc
             if pathlib.PurePosixPath(name.replace('\\', '/')).name == 'codex-retry-hook.js']
    if len(names) != 1:
        raise ValueError(f'EXE 中的 hook 资源应有且只有一份，实际 {len(names)} 份')
    expected = normalize_source(source.read_bytes())
    embedded = normalize_source(archive.extract(names[0]))
    expected_version, actual_version = hook_version(expected), hook_version(embedded)
    if actual_version != expected_version:
        raise ValueError(f'EXE 脚本版本不一致：预期 {expected_version}，实际 {actual_version}')
    if embedded != expected:
        raise ValueError('EXE 脚本版本相同，但完整源码与仓库不一致，需要重新打包')
    checksum = hashlib.sha256()
    with executable.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            checksum.update(block)
    return {
        'executable': str(executable.resolve()),
        'bytes': executable.stat().st_size,
        'sha256': checksum.hexdigest(),
        'hookVersion': actual_version,
        'hookSha256': hashlib.sha256(embedded.encode('utf-8')).hexdigest(),
        'sourceMatches': True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=pathlib.Path)
    parser.add_argument('--source', type=pathlib.Path, default=ROOT / 'codex-retry-hook.js')
    parser.add_argument('--sha256-file', type=pathlib.Path, help='另存可随 EXE 发布的校验文件')
    args = parser.parse_args()
    try:
        result = verify_package(args.executable, args.source)
        if args.sha256_file:
            args.sha256_file.write_text(
                f"{result['sha256']}  {args.executable.name}\n", encoding='utf-8')
    except Exception as error:
        print(f'打包校验失败：{error}', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
