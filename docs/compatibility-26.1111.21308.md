# Codex 26.1111.21308 兼容性检查

检查日期：2026-11-15（北京时间）。仓库基线：`9f01dd1`。

## 结论

**主注入方案仍然适用，v1.5.0 已完成本次发现的兼容性修复。**

新版仍会在不带 `Retry-After` 的 HTTP 429 后结束回合；本项目继续接手这类已放弃的暂时性错误。
修复后覆盖当前协议全部 23 个错误并保留 3 个旧版错误，当前窗口已热换为新版脚本。
备用 ASAR 补丁已通过真实安装包的只读定位及隔离修改、还原测试。

本次实际热换了脚本，没有重启或重载当前 Codex，也没有写入安装包。
真实故障后的生产重试未单独触发，完整自动重试由隔离回放验证。

## 修复计划与落实

| 修复项 | 实施结果 | 验证 |
|---|---|---|
| 新增错误分类 | Flex 资源不足按 30 秒间隔无限重试，保留服务层级；两种明确拒绝不重试 | 真实协议覆盖检查、决策及分片回放通过 |
| 旧脚本升级 | GUI、CLI、热换共用注入与实际版本校验；旧实例停止后不再发送排队重试 | 升级、重载、同版本刷新与停用回放通过 |
| 窗口生命周期 | 原窗口关闭后新窗口可补注入，同一窗口重载后缺失的实例可恢复 | Python 注入测试通过 |
| CLI 持续注入 | 实现 `--watch`，单个新窗口失败时继续处理其他窗口 | CLI 持续注入与失败退出测试通过 |
| 备用补丁 | 按 ASAR 文件边界配对倒计时数组与 getter，支持变量名变化、多个副本与中断补齐 | 当前安装包识别四处位置，隔离还原逐字节一致 |
| 发布校验 | 构建前运行协议及注入测试，构建后核对 EXE 版本与完整内嵌源码，生成 SHA-256 | 本地 EXE 自检及完整源码核验通过 |

## 检查对象

| 项目 | 实际值 |
|---|---|
| 桌面版应用版本 | `26.1111.21308`，构建号 `27194` |
| Windows MSIX 包版本 | `26.1111.2228.0` |
| 桌面版内置 Codex | `codex-cli 0.169.0-alpha.11.1` |
| 修复后的脚本版本 | `2026-11-15.codex-26.1111-v1` |
| 目标发布版本 | `v1.5.0` |
| 更新检查 | `up_to_date`，当前更新通道没有待安装更新 |

应用版本由桌面版更新接口与安装包 `package.json` 交叉确认；内置 Codex 版本直接读取
当前运行安装目录下的 `app/resources/codex.exe`，没有使用 PATH 中可能不同版本的 CLI。

## 核心功能验证

| 检查项 | 结果 |
|---|---|
| 注入连接 | `127.0.0.1:9333` 可连接，`electronBridge.sendMessageFromView` 仍可调用 |
| React 按钮识别 | 热换后的当前页面可见按钮均有 fiber，诊断成功解析 21 个 i18n key；新版包中仍有原重试按钮 key |
| 会话读取 | 实际调用只读的 `thread/read`，返回会话路径、工作目录和 `canAcceptDirectInput` |
| 会话设置恢复 | 实际调用 `fs/readFile` 读取本次会话记录，最新版解析器成功恢复模型、协作模式与工作目录 |
| 大消息分片 | 用隔离的 6,000,371 字节测试文件读取，实际收到 1 个 `start`、15 个 `chunk`、1 个 `end`，完整组装，零解码错误 |
| 重试请求格式 | 用本次会话设置生成 `turn/start` 参数，对照本机内置 Codex 导出的实验性 JSON Schema 验证，零错误 |
| 重试参数约束 | `input` 仍为空数组，七个既有空值字段均为 `null` |
| 错误分类 | 真实协议的 23 个错误全部显式分类，缺失列表为空；保留 3 个旧版错误 |
| 自动重试回放 | 429 对象错误及分片通知可重试，Flex 保留服务层级与计划模式，两种拒绝不发送请求 |
| 停用约束 | 排队与模板恢复期间调用 `stop()` 后，不再发送 `turn/start` |
| 测试与构建 | 四项 Node 测试、Python 注入及 CLI 测试、GUI 与备用补丁自检、打包 EXE 自检均通过 |

大文件测试通过真实 Codex IPC 读取，使用修复后的解码函数；模板恢复与请求格式验证均基于本次实际会话。
这次只读探针仅调用 `thread/read` 和 `fs/readFile`，没有点击重试按钮或发起回合。

## 新版仍会在裸 429 后结束

使用桌面版内置二进位、独立 `CODEX_HOME`、本地假上游与虚拟凭证测试。
上游固定返回 HTTP 429，不带 `Retry-After`；测试没有访问真实模型服务。

| 配置 | 实际请求数 | 结果 |
|---|---:|---|
| 默认重试配置 | 1 | 回合失败，进程退出码 1 |
| `request_max_retries = 50`、`stream_max_retries = 50` | 1 | 回合失败，进程退出码 1 |

两次均返回 `exceeded retry limit, last status: 429 Too Many Requests`。
隔离会话记录里的错误仍是 `response_too_many_failed_attempts`，`http_status_code` 为 429；
新版协议将其发送为 `responseTooManyFailedAttempts`。
仓库源码已支持这个错误，因此 Codex 更新没有消除本项目处理此类故障的必要性。

这项结论限定于上述裸 429 场景；不能据此声称所有模型、服务层级和其他错误都没有原生重试。
新版 renderer 仍保留 `[10,30,120,300]` 的倒计时分支，但该分支也受 `capacityErrorRetries` 能力开关影响。

## 新版错误分类的修复

本机内置 Codex 导出的 `ErrorNotification.json` 新增三项，检查时在旧源码中没有显式分类。
修复后的策略如下：

- `flexUnavailable`：Flex 资源暂时不足，默认无限重试，重试间隔至少 30 秒，保留原服务层级。
- `inferenceHookDenied`：协议明确说明工作区推理 hook 拒绝请求，不重试。
- `tooManyDenials`：拒绝次数过多，不重试；需要先处理拒绝原因。

官方 [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing)
将资源不足描述为可稍后重试的 429。切换标准服务层级可能改变费用，因此本工具保留原来的 `serviceTier`。
30 秒是本项目的默认间隔，不是官方强制值。

两种拒绝类型即使消息包含 429、503 或暂时性错误文字也不重试。
`test-protocol.cjs` 直接读取独立的真实协议样本，避免只比较自己维护的两张表。
样本已保存在 `tests/fixtures/codex-26.1111-error-notification.json`；本次也传入新导出的原始协议核验通过。
旧版 `bioPolicy`、`invalidPrompt`、`interrupted` 仍保留原来的不重试行为。

## 当前窗口已升级

| 项目 | 修复前窗口 | 热换后窗口与仓库 |
|---|---:|---:|
| 脚本版本标记 | 缺失 | `2026-11-15.codex-26.1111-v1` |
| CFG 规则数 | 13 | 17 |
| IPC 分类数 | 8 | 26 |

执行 `python tools/hotswap.py` 后，用 `python tools/check-hook.py` 核对版本、分类数和配置数，退出码为 0。
同一诊断工具在升级前返回非零退出码，明确报告旧实例缺失版本标记与分类不一致。
GUI 也会显示实际版本，将旧实例标记为需要重新注入。

本地重新构建了标准的 `dist/codex-never-give-up.exe`，资源版本为
`2026-11-15.codex-26.1111-v1`，完整内嵌源码与仓库一致，打包程序 `--selftest` 通过。
另保留了原来的 `dist/codex-never-give-up-26.1106-fix.exe`；它内嵌的旧版本会被新版打包校验明确拒绝。

后续源码更新后，可在已有调试端口的情况下直接热换，并核对运行版本：

```powershell
python tools/hotswap.py
python tools/check-hook.py
```

使用 EXE 时需要重新打包或下载新发布文件；修改仓库源码不会改变已有 EXE。
`tools/verify-package.py` 同时核对版本与完整源码，只忽略 CRLF/LF 行尾差异，并输出 EXE 的 SHA-256。

## 备用安装包补丁已恢复定位

旧补丁绑定 `LDr`，在当前安装包中的匹配数为 0。修复后只读执行
`python alternatives/patch-codex-retry.py`，退出码为 0，识别两个 renderer 文件：

| 文件 | 识别到的原始表达式 |
|---|---|
| `webview/assets/async/394912.241a9343a8.js` | `q=[10,30,120,300]` 与 `return q[a]??null` |
| `webview/assets/async/478806.1fcc90f6a3.js` | `Z=[10,30,120,300]` 与 `return Z[i]??null` |

合计四处等长修改位置。实际 ASAR 大小为 783,750,654 字节，本次仅只读检查，未修改安装包。
隔离自检覆盖旧、新及特殊变量名、多个副本、部分写入补齐、精确还原，以及无关或歧义代码的拒绝。
主注入方案继续作为默认路径；备用补丁识别仍依赖可确认的上下文，未来变化无法确认时会拒绝修改。

## 取证与复现

本次原始只读探针、生成协议、大文件测试样本和结果位于项目内忽略的目录：
`.workbuddy/compatibility-26.1111.21308/`。
主要结果为 `live-probe.json`、`schema-validation.json` 和 `native-429-results.json`。

可随源码复现的回归与打包检查如下：

```powershell
node test-hook.cjs
node test-build.cjs
node test-runtime.cjs
node test-protocol.cjs
python -m unittest discover -s tests -p 'test_*.py' -v
python codex_retry_gui.pyw --selftest
python alternatives/patch-codex-retry.py --selftest
python tools/verify-package.py dist/codex-never-give-up.exe
```

官方 [Codex 更新日志](https://learn.chatgpt.com/docs/changelog) 未提供此次桌面版精确版本的内部 IPC 保证；
上述兼容性判断以本机安装包、内置二进位导出的协议和当前实测为依据。
