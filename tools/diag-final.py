"""最終診斷：hook 眼中的錯誤 thread、模板庫、以及 DOM 目前有沒有掛著重試按鈕。"""
import asyncio, json, sys, urllib.request
import aiohttp

PORT = 9333

JS = r"""
(() => {
  const h = window.__codexRetryHook;
  if (!h) return JSON.stringify({err: 'no hook'});
  // DOM 上有沒有掛著任何 retry 類按鈕（当前對話）
  function fiberOf(el){for(const k in el){if(k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'))return el[k];}return null;}
  const retryBtns = [...document.querySelectorAll('button:not([disabled]),[role=button]')]
    .filter(b => b.offsetParent !== null)
    .map(b => {
      let id = null;
      let f = fiberOf(b), d = 0;
      while (f && d++ < 6 && !id) {
        id = f.memoizedProps && f.memoizedProps.id;
        f = f.child || null;
      }
      return id ? [id, (b.innerText||'').trim().slice(0,20)] : null;
    })
    .filter(x => x && /retry|resume/i.test(x[0]));
  return JSON.stringify({
    stats: h.stats(),
    health: h.health(),
    threadsWithErrors: h.threads(),
    templateCount: Object.keys(h.templates()).length,
    templateIds: Object.keys(h.templates()).map(s => s.slice(0, 8)),
    retryButtonsInDom: retryBtns
  });
})()
"""

def get_targets():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=3) as r:
        try:
            data = json.loads(r.read())
        except ValueError as e:
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
