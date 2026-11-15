"""版本升级、页面重载与 GUI 旧脚本状态的回归测试。"""
import importlib.machinery
import importlib.util
import json
import pathlib
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

from codex_hook import hook_version, install_hook, install_source

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = (ROOT / 'codex-retry-hook.js').read_text(encoding='utf-8')
VERSION = hook_version(SOURCE)
loader = importlib.machinery.SourceFileLoader('retry_gui', str(ROOT / 'codex_retry_gui.pyw'))
spec = importlib.util.spec_from_loader(loader.name, loader)
gui = importlib.util.module_from_spec(spec)
loader.exec_module(gui)


class VersionLifecycleTests(unittest.TestCase):
    def test_upgrade_reload_and_manual_refresh(self):
        # 真实 hook 在隔离 JavaScript 环境中运行，不向任何 Codex 会话发送请求。
        javascript = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
function page() {
  return vm.createContext({
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], documentElement: {} },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID: () => 'test-id' }, console: { log() {} },
  });
}
for (const oldVersion of [null, '2026-11-13.chunked-ipc-v1']) {
  const context = page();
  let stops = 0;
  context.window.__codexRetryHook = { version: oldVersion, stop() { stops++; } };
  vm.runInContext(input.wrapped, context);
  const current = context.window.__codexRetryHook;
  assert.equal(current.version, input.version);
  assert.equal(stops, 1);
  current.cfg['ipc:flexUnavailable'].gapMs = 43210;
  vm.runInContext(input.wrapped, context);
  assert.equal(context.window.__codexRetryHook, current, '重复注册不能重置当前实例');
  vm.runInContext(input.forced, context);
  assert.equal(context.window.__codexRetryHook.cfg['ipc:flexUnavailable'].gapMs, 30000,
               '手动重新注入必须应用同版本中的配置编辑');
}
// 模拟页面重载时先执行旧注册脚本，随后执行最新注册脚本。
const reloaded = page();
vm.runInContext('window.__codexRetryHook={stop(){},version:"old"}', reloaded);
vm.runInContext(input.wrapped, reloaded);
assert.equal(reloaded.window.__codexRetryHook.version, input.version);
"""
        result = subprocess.run(['node', '-e', javascript], input=json.dumps({
            'wrapped': install_source(SOURCE), 'forced': install_source(SOURCE, force=True), 'version': VERSION,
        }), text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_source_version_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'HOOK_VERSION'):
            install_source('window.__codexRetryHook = {};')


class FakeSocket:
    def __init__(self, version):
        self.version = version
        self.messages = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def send_json(self, message):
        self.messages.append(message)
        result = {}
        if message['method'] == 'Runtime.evaluate' and message['params'].get('returnByValue'):
            result = {'result': {'value': self.version}}
        self.reply = json.dumps({'id': message['id'], 'result': result})

    async def receive_str(self):
        return self.reply


class FakeSession:
    def __init__(self, version):
        self.socket = FakeSocket(version)

    def ws_connect(self, *args, **kwargs):
        return self.socket


class InstallProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_runtime_version_is_required(self):
        target = {'webSocketDebuggerUrl': 'ws://test'}
        with self.assertRaisesRegex(RuntimeError, '版本不一致'):
            await install_hook(FakeSession(None), target, SOURCE)
        session = FakeSession(VERSION)
        self.assertEqual(await install_hook(session, target, SOURCE), VERSION)
        registrations = [m for m in session.socket.messages if m['method'] == 'Page.addScriptToEvaluateOnNewDocument']
        self.assertEqual(len(registrations), 1)
        self.assertEqual(registrations[0]['params']['source'], install_source(SOURCE))


class GuiPollingTests(unittest.IsolatedAsyncioTestCase):
    def worker(self):
        worker = gui.Worker()
        worker.exe = 'test-codex.exe'
        return worker

    def state(self, worker):
        messages = []
        while not worker.out.empty():
            messages.append(worker.out.get_nowait())
        return [m for m in messages if m['kind'] == 'state'][-1]

    async def test_unmanaged_legacy_hook_is_reported_without_silent_upgrade(self):
        worker = self.worker()
        with patch.object(gui, 'page_targets', return_value=[{'id': 'legacy'}]), \
             patch.object(gui, 'cdp_eval', AsyncMock(return_value=json.dumps({'stats': {}, 'log': []}))), \
             patch.object(gui, 'cdp_install', AsyncMock()) as installer:
            await worker.do_poll(None)
        self.assertEqual(self.state(worker)['state'], 'outdated')
        installer.assert_not_awaited()

    async def test_managed_legacy_hook_is_recovered(self):
        worker = self.worker()
        worker.injected.add('managed')
        values = [json.dumps({'version': None}), json.dumps({'version': VERSION})]
        with patch.object(gui, 'page_targets', return_value=[{'id': 'managed'}]), \
             patch.object(gui, 'cdp_eval', AsyncMock(side_effect=values)), \
             patch.object(gui, 'cdp_install', AsyncMock(return_value=True)) as installer:
            await worker.do_poll(None)
        installer.assert_awaited_once()
        self.assertEqual(self.state(worker)['state'], 'on')

    async def test_new_window_is_injected_after_original_window_closes(self):
        worker = self.worker()
        worker.injected.add('closed-window')
        with patch.object(gui, 'page_targets', return_value=[{'id': 'new-window'}]), \
             patch.object(gui, 'cdp_eval', AsyncMock(return_value=json.dumps({'version': VERSION}))), \
             patch.object(gui, 'cdp_install', AsyncMock(return_value=True)) as installer:
            await worker.do_poll(None)
        installer.assert_awaited_once()
        self.assertIn('new-window', worker.injected)
        self.assertEqual(self.state(worker)['state'], 'on')

    async def test_managed_window_recovers_a_missing_hook_after_reload(self):
        worker = self.worker()
        worker.injected.add('reloaded-window')
        with patch.object(gui, 'page_targets', return_value=[{'id': 'reloaded-window'}]), \
             patch.object(gui, 'cdp_eval', AsyncMock(side_effect=[None, json.dumps({'version': VERSION})])), \
             patch.object(gui, 'cdp_install', AsyncMock(return_value=True)) as installer:
            await worker.do_poll(None)
        installer.assert_awaited_once()
        self.assertEqual(self.state(worker)['state'], 'on')


if __name__ == '__main__':
    unittest.main()
