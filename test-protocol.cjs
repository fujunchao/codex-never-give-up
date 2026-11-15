// 默认协议样本由 Codex 26.1111 内置的 0.169.0-alpha.11.1 导出，独立于 hook 分类表。
// 也可传入新版 app-server generate-json-schema 生成的 ErrorNotification.json。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IPC_CFG, ALL_ERROR_VARIANTS } = require('./codex-retry-hook.js');

const file = process.argv[2] || path.join(__dirname, 'tests/fixtures/codex-26.1111-error-notification.json');
const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
const errorInfo = schema.definitions?.CodexErrorInfo;
assert.ok(errorInfo?.anyOf, '协议必须包含 CodexErrorInfo 定义，不能误读其他文件');
const variants = errorInfo.anyOf.flatMap(item => [...(item.enum || []), ...(item.required || [])]);
assert.ok(variants.length > 0, '协议样本没有错误变体，无法确认覆盖范围');
const missing = variants.filter(kind => !Object.hasOwn(IPC_CFG, kind) || !ALL_ERROR_VARIANTS.includes(kind));
assert.deepEqual(missing, [], `新版协议存在未分类错误：${missing.join(', ')}`);
assert.equal(new Set(ALL_ERROR_VARIANTS).size, ALL_ERROR_VARIANTS.length, '兼容列表不能重复计数');
for (const kind of ['bioPolicy', 'invalidPrompt', 'interrupted']) {
  assert.equal(IPC_CFG[kind]?.retry, false, `旧版错误 ${kind} 仍须保留原行为`);
}
console.log(`ok  (真实协议的 ${variants.length} 个错误全部分类；保留旧版错误兼容)`);
