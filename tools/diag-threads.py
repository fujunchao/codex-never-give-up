"""拉出 live hook 的完整 log 與統計，找出所有 thread id 與被跳過的原因。"""
import asyncio, json, sys, urllib.request
import aiohttp

PORT = 9333

JS = r"""
(() => {
  const h = window.__codexRetryHook;
  if (!h) return JSON.stringify({err: 'no hook'});
  const log = h.log();
  const ids = {};
  for (const l of log) {
    const m = l.match(/\(([0-9a-f]{8})\)/g) || [];
    for (const x of m) {
      const k = x.slice(1, -1);
      ids[k] = (ids[k] || 0) + 1;
    }
  }
  return JSON.stringify({
    stats: h.stats(),
    health: h.health(),
    logLines: log.length,
    threadIds: ids,
    skips: log.filter(l => /略過|不動作|刻意|未分類|失敗|無模板|不可用|已停用/.test(l)).slice(-30),
    lastLog: log.slice(-20)
  });
})()
"""

def get_targets():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=3) as r:
        try:
            data = json.loads(r.read())
        except (ValueError, OSError) as e:
            raise RuntimeError(f'/json/list 回應不是合法 JSON: {e}') from e
    return [t for t in data
            if t.get('type') == 'page' and 'avatar' not in t.get('url', '')
            and t.get('webSocketDebuggerUrl')]

async def probe(session, t):
    async with session.ws_connect(t['webSocketDebuggerUrl'], max_msg_size=0) as ws:
        await ws.send_json({'id': 1, 'method': 'Runtime.evaluate',
                            'params': {'expression': JS, 'returnByValue': True}})
        while True:
            msg = await ws.receive()
            if msg.type != aiohttp.WSMsgType.TEXT:
                return None
            try:
                m = json.loads(msg.data)
            except ValueError:
                continue
            if m.get('id') == 1:
                return (m.get('result') or {}).get('result', {}).get('value')

async def main():
    try:
        targets = get_targets()
    except Exception as e:
        sys.exit(f'debug port {PORT} 不通: {e}')
    async with aiohttp.ClientSession() as s:
        for t in targets:
            try:
                val = await probe(s, t)
                d = json.loads(val) if val else {'err': 'no response'}
            except Exception as e:
                d = {'err': str(e)}
            print(f"--- {t.get('url', '?')[:70]}")
            print(json.dumps(d, ensure_ascii=False, indent=1))

asyncio.run(main())
