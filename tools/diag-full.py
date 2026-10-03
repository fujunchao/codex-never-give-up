import asyncio, json, urllib.request
import aiohttp
PORT = 9333
E = r"""
(() => {
  const h = window.__codexRetryHook;
  if (!h) return JSON.stringify({hook: false});
  const out = {
    page: location.href.slice(-40),
    hook: true,
    rl: h.ipcCfg ? h.ipcCfg.rateLimitExceeded : undefined,
    rlKey: h.cfg ? Object.hasOwn(h.cfg, 'ipc:rateLimitExceeded') : undefined,
    stats: h.stats ? h.stats() : null,
    log: h.log ? h.log().slice(-60) : null,
    threads: h.threads ? h.threads() : null,
  };
  return JSON.stringify(out);
})()
"""
async def main():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=5) as r:
        tg = [t for t in json.loads(r.read())
              if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
    lines = []
    for t in tg:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(t['webSocketDebuggerUrl'], max_msg_size=0) as ws:
                    await ws.send_json({'id': 1, 'method': 'Runtime.evaluate',
                                        'params': {'expression': E, 'returnByValue': True}})
                    while True:
                        m = json.loads(await ws.receive_str())
                        if m.get('id') == 1:
                            break
            v = (m.get('result') or {}).get('result', {}).get('value')
            if not v:
                continue
            d = json.loads(v)
            if not d.get('hook'):
                lines.append(f"--- {d.get('page')} hook=False")
                continue
            lines.append(f"=== page {d['page']}")
            lines.append("rateLimitExceeded 分类: " + json.dumps(d.get('rl'), ensure_ascii=False)
                         + f"  CFG键存在: {d.get('rlKey')}")
            lines.append("stats: " + json.dumps(d.get('stats'), ensure_ascii=False))
            for l in (d.get('log') or []):
                lines.append(f"  log> {l}")
            th = d.get('threads')
            if th:
                lines.append("threads-with-error:")
                for tid, info in th.items():
                    lines.append("  " + tid[:8] + " " + json.dumps(info, ensure_ascii=False)[:400])
            else:
                lines.append("threads-with-error: (none)")
        except Exception as e:
            lines.append(f"--- {t.get('url','?')[-40:]} ERR {e}")
    with open('diag-out.jsonl', 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f"wrote diag-out.jsonl, {len(lines)} lines")
asyncio.run(main())
