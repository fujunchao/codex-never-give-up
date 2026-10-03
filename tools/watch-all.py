"""盯 hook 的完整 log()，把每一行新日志（含 ipc <kind> 分类行）落盘到 rate-watch.log。"""
import asyncio, json, time, urllib.request
import aiohttp

PORT = 9333
OUT = "rate-watch.log"
EXPR = ("(()=>{const h=window.__codexRetryHook;"
        "return h?JSON.stringify({log:h.log(),stats:h.stats()}):'NOHOOK';})()")
seen = set()

async def once():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=5) as r:
            tg = [t for t in json.loads(r.read())
                  if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
    except Exception:
        return
    async with aiohttp.ClientSession() as s:
        for t in tg:
            try:
                async with s.ws_connect(t['webSocketDebuggerUrl'], max_msg_size=0,
                                        timeout=10) as ws:
                    await ws.send_json({'id': 1, 'method': 'Runtime.evaluate',
                                        'params': {'expression': EXPR, 'returnByValue': True}})
                    while True:
                        m = json.loads(await ws.receive_str())
                        if m.get('id') == 1:
                            break
            except Exception:
                continue
            v = (m.get('result') or {}).get('result', {}).get('value')
            if not v or v == 'NOHOOK':
                continue
            d = json.loads(v)
            fresh = [l for l in d.get('log', []) if l not in seen and not l.endswith('筆模板')]
            for l in fresh:
                seen.add(l)
            if fresh:
                with open(OUT, 'a', encoding='utf-8') as f:
                    f.write('\n'.join(f"[{time.strftime('%H:%M:%S')}] {l}" for l in fresh) + '\n')

async def main():
    with open(OUT, 'a', encoding='utf-8') as f:
        f.write(f"\n[{time.strftime('%H:%M:%S')}] === watcher started ===\n")
    while True:
        await once()
        await asyncio.sleep(5)

asyncio.run(main())
