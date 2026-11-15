"""CLI 持续注入必须覆盖新窗口，且单个窗口失败不能阻塞其他窗口。"""
import contextlib
import importlib.util
import io
import pathlib
import unittest
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('retry_cli', ROOT / 'codex-inject.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class StopWatching(Exception):
    pass


class FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def target(name):
    return {'id': name, 'type': 'page', 'url': f'app://-/{name}', 'webSocketDebuggerUrl': f'ws://{name}'}


class CliWatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_watch_continues_after_a_failed_window(self):
        original, broken, new = map(target, ('original', 'broken', 'new'))
        # 原窗口关闭后同时出现两个新窗口；其中一个失败，另一个仍必须注入。
        installer = AsyncMock(side_effect=['OK original', RuntimeError('窗口已关闭'), 'OK new'])
        with patch.object(cli, 'WATCH', True), \
             patch.object(cli, 'app_exe', return_value=pathlib.Path('ChatGPT.exe')), \
             patch.object(cli, 'http_json', side_effect=[[original], [broken, new]]), \
             patch.object(cli.aiohttp, 'ClientSession', return_value=FakeSession()), \
             patch.object(cli, 'inject_into', installer), \
             patch.object(cli.asyncio, 'sleep', AsyncMock(side_effect=StopWatching)), \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(StopWatching):
                await cli.run()
        self.assertEqual([call.args[1]['id'] for call in installer.await_args_list], ['original', 'broken', 'new'])
        self.assertEqual(installer.await_args_list[-1].kwargs, {'force': False})

    async def test_initial_injection_failure_returns_a_failure(self):
        with patch.object(cli, 'app_exe', return_value=pathlib.Path('ChatGPT.exe')), \
             patch.object(cli, 'http_json', return_value=[target('broken')]), \
             patch.object(cli.aiohttp, 'ClientSession', return_value=FakeSession()), \
             patch.object(cli, 'inject_into', AsyncMock(side_effect=RuntimeError('调试接口失败'))), \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                await cli.run()
        self.assertIn('注入失败', str(result.exception))


if __name__ == '__main__':
    unittest.main()
