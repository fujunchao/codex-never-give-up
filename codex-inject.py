#!/usr/bin/env python
"""把 codex-retry-hook.js 注入 Codex 桌面版的 renderer。

用 Chromium 的 remote debugging 介面注入，不改 app.asar：
不用管理員、不用重寫 285MB、Codex 更新也不會被蓋掉。

  python codex-inject.py            注入（Codex 已開著就叫你先關）
  python codex-inject.py --force    自動關掉再重開並注入
  python codex-inject.py --watch    注入後持續盯新開的視窗
  python codex-inject.py --port N   換 debug port（預設 9333）

注入後在 Codex 的 DevTools console 可以查：
  __codexRetryHook.stats()   每條路徑按了幾次
  __codexRetryHook.log()     動作紀錄
  __codexRetryHook.stop()    停掉
"""
import asyncio, json, pathlib, subprocess, sys, time, urllib.error, urllib.request

import aiohttp
from codex_hook import hook_version, install_hook

HOOK = pathlib.Path(__file__).with_name('codex-retry-hook.js')
PORT = 9333
for i, a in enumerate(sys.argv):
    if a == '--port' and i + 1 < len(sys.argv):
        PORT = int(sys.argv[i + 1])
FORCE = '--force' in sys.argv
WATCH = '--watch' in sys.argv

def ps(cmd):
    return subprocess.run(['powershell', '-NoProfile', '-Command', cmd],
                          capture_output=True, text=True).stdout.strip()

def activate_msix(aumid, args):
    """Store/MSIX 不能 CreateProcess（WinError 5），要用 IApplicationActivationManager。"""
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = (('Data1', wintypes.DWORD),
                    ('Data2', wintypes.WORD),
                    ('Data3', wintypes.WORD),
                    ('Data4', wintypes.BYTE * 8))

        def __init__(self, s):
            super().__init__()
            ctypes.oledll.ole32.CLSIDFromString(s, ctypes.byref(self))

    ole32 = ctypes.oledll.ole32
    try:
        ole32.CoInitializeEx(None, 0x2)
    except OSError:
        pass
    clsid = GUID('{45BA127D-10A8-46EA-8AB7-56EA9078943C}')
    iid = GUID('{2e941141-7f97-4756-ba1d-9decde894a3d}')
    mgr = ctypes.c_void_p()
    ole32.CoCreateInstance(ctypes.byref(clsid), None, 4, ctypes.byref(iid),
                           ctypes.byref(mgr))
    vtbl = ctypes.cast(mgr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    ActivateApplication = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, wintypes.LPCWSTR, wintypes.LPCWSTR,
        ctypes.c_int, ctypes.POINTER(wintypes.DWORD)
    )(vtbl[3])
    pid = wintypes.DWORD()
    hr = ActivateApplication(mgr, aumid, args or '', 0, ctypes.byref(pid))
    if hr < 0:
        raise OSError(None, 'ActivateApplication failed', None, hr & 0xFFFFFFFF)
    if not pid.value:
        raise RuntimeError('ActivateApplication 沒有回傳 pid')
    return pid.value

def launch_codex(port):
    fam = ps("(Get-AppxPackage -Name 'OpenAI.Codex').PackageFamilyName")
    if not fam:
        sys.exit('找不到 OpenAI.Codex PackageFamilyName')
    args = (f'--remote-debugging-port={port} '
            '--remote-debugging-address=127.0.0.1 '
            '--remote-allow-origins=*')
    return activate_msix(f'{fam}!App', args)

def app_exe():
    loc = ps("(Get-AppxPackage -Name 'OpenAI.Codex').InstallLocation")
    if not loc:
        sys.exit('找不到 OpenAI.Codex 套件')
    exe = pathlib.Path(loc) / 'app' / 'ChatGPT.exe'
    if not exe.exists():
        sys.exit(f'找不到 {exe}')
    return exe

def live_pids():
    out = ps("(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | "
             "Where-Object { $_.Path -like '*OpenAI.Codex*' }).Id -join ','")
    return [p for p in out.split(',') if p.strip()]

def http_json(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}{path}', timeout=3) as r:
        return json.loads(r.read())

async def inject_into(session, target, src, force=True):
    version = await install_hook(session, target, src, force=force)
    return f"OK   {target.get('url','?')}  (版本={version})"

async def run():
    src = HOOK.read_text(encoding='utf-8')
    version = hook_version(src)
    exe = app_exe()

    try:
        targets = [t for t in http_json('/json/list')
                   if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        targets = []

    if not targets:
        pids = live_pids()
        if pids:
            if not FORCE:
                sys.exit(f'Codex 正在跑（pid {",".join(pids)}）。Chromium 只在啟動時吃 '
                         f'--remote-debugging-port，要先關掉。\n'
                         f'確定可以關就加 --force 重跑。')
            print(f'關掉現有的 Codex（pid {",".join(pids)}）...')
            ps("Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | "
               "Where-Object { $_.Path -like '*OpenAI.Codex*' } | Stop-Process -Force")
            for _ in range(30):
                if not live_pids():
                    break
                time.sleep(0.5)

        print(f'啟動 {exe.name} --remote-debugging-port={PORT}（AppX）')
        pid = launch_codex(PORT)
        print(f'已啟動 pid {pid}')

        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                targets = [t for t in http_json('/json/list')
                           if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
                if targets:
                    break
            except (urllib.error.URLError, OSError, json.JSONDecodeError):
                pass
            time.sleep(1)
        if not targets:
            sys.exit(f'等不到 debug port {PORT} 上的頁面 — 這個版本可能不吃這個參數。')

    print(f'找到 {len(targets)} 個頁面')
    async with aiohttp.ClientSession() as session:
        seen, failed = set(), 0
        for t in targets:
            try:
                print('  ' + await inject_into(session, t, src))
                seen.add(t['id'])
            except Exception as e:
                failed += 1
                print(f'  ERR {t.get("url","?")}: {type(e).__name__}: {e}')
        if failed:
            sys.exit(f'有 {failed} 个页面注入失败，请查看上述错误。')
        print(f'\n注入完成，脚本版本 {version}。')
        if WATCH:
            print('持续检查新窗口；按 Ctrl+C 停止。')
            while True:
                try:
                    current = [t for t in http_json('/json/list')
                               if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
                    for t in current:
                        if t['id'] not in seen:
                            try:
                                print('  ' + await inject_into(session, t, src, force=False))
                                seen.add(t['id'])
                            except Exception as e:
                                print(f'新窗口 {t.get("url", "?")} 注入失败：{e}')
                except Exception as e:
                    print(f'检查新窗口失败：{e}')
                await asyncio.sleep(2)

if __name__ == '__main__':
    if not HOOK.exists():
        sys.exit(f'找不到 {HOOK}')
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
