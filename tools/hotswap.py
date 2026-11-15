"""将当前脚本热换进 Codex，并核对版本；无需重启应用。"""
import asyncio
import json
import pathlib
import sys
import urllib.request

import aiohttp

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from codex_hook import install_hook

PORT = 9333


async def main():
    source = (ROOT / 'codex-retry-hook.js').read_text(encoding='utf-8')
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=5) as response:
        targets = [t for t in json.load(response) if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
    if not targets:
        raise RuntimeError('调试接口中没有可注入的 Codex 页面')
    async with aiohttp.ClientSession() as session:
        for target in targets:
            version = await install_hook(session, target, source)
            print(f"  {target.get('url', '?')[:60]}  已核对脚本版本：{version}")


if __name__ == '__main__':
    asyncio.run(main())
