"""GUI、命令行与热换工具共用的注入和版本校验。"""
import asyncio
import json
import re


def hook_version(source):
    match = re.search(r'\bconst\s+HOOK_VERSION\s*=\s*"([^"]+)"', source)
    if not match:
        raise ValueError("注入脚本缺少 HOOK_VERSION 版本标记")
    return match.group(1)


def install_source(source, force=False):
    """只替换版本不同的脚本；页面重载时也执行同样的检查。"""
    version = json.dumps(hook_version(source))
    keep_current = "" if force else f"if (previous && previous.version === {version}) return;"
    return (
        "(() => { const previous = window.__codexRetryHook;"
        + keep_current +
        "if (previous) {"
        "if (typeof previous.setBackgroundSend === 'function') previous.setBackgroundSend(false);"
        "if (typeof previous.setRecovery === 'function') previous.setRecovery(false);"
        "if (typeof previous.stop === 'function') previous.stop();"
        "delete window.__codexRetryHook; }\n" + source + "\n})()"
    )


async def install_hook(session, target, source, force=True):
    expected = hook_version(source)
    wrapped = install_source(source)
    async with session.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0, timeout=15) as ws:
        call_id = 0

        async def call(method, params=None):
            nonlocal call_id
            call_id += 1
            await ws.send_json({"id": call_id, "method": method, "params": params or {}})
            while True:
                reply = json.loads(await asyncio.wait_for(ws.receive_str(), timeout=15))
                if reply.get("id") == call_id:
                    if reply.get("error"):
                        raise RuntimeError(f"调试接口失败：{reply['error']}")
                    return reply.get("result", {})

        await call("Page.enable")
        await call("Page.addScriptToEvaluateOnNewDocument", {"source": wrapped})
        result = await call("Runtime.evaluate", {"expression": install_source(source, force=force)})
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"].get("text", "注入脚本执行失败"))
        result = await call("Runtime.evaluate", {
            "expression": "window.__codexRetryHook && window.__codexRetryHook.version",
            "returnByValue": True,
        })
        actual = result.get("result", {}).get("value")
        if actual != expected:
            raise RuntimeError(f"注入版本不一致：预期 {expected}，实际 {actual or '无版本标记'}")
        return actual
