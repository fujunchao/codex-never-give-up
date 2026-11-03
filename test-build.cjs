// buildRetryRequest 的檢查：送出去的每個欄位都必須是實錄過的形狀
const assert = require('node:assert');
const h = require('./codex-retry-hook.js');

let n = 0;
const uuid = () => 'uuid-' + (++n);
const NOW = 1700000000000;
const now = () => NOW;

const tpl = {
  hostId: 'local',
  cwd: 'C:\\work\\myproject',
  runtimeWorkspaceRoots: ['C:\\work\\myproject', 'C:\\Users\\me\\.codex/visualizations/a'],
  collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', developer_instructions: null } },
  responsesapiClientMetadata: { workspace_kind: 'desktop' },
  multiAgentMode: 'explicitRequestOnly',
  summary: 'detailed',
  personality: 'friendly',
  serviceTier: 'default',
  // 模板裡有這個，但重送絕對不該把它帶出去（實錄的重試是送 null）
  permissions: ':danger-full-access',
};

const m = h.buildRetryRequest('TH-1', tpl, uuid, now);

// 信封
assert.strictEqual(m.type, 'mcp-request');
assert.strictEqual(m.hostId, 'local');
assert.strictEqual(m.priority, 'critical');
assert.strictEqual(m.source, 'turn');
assert.strictEqual(m.retainResponse, true);
assert.strictEqual(m.timeoutMs, 30000);
assert.strictEqual(m.expiresAtMs, NOW + 30000);
assert.strictEqual(m.request.method, 'turn/start');

const p = m.request.params;
assert.strictEqual(p.threadId, 'TH-1');
assert.strictEqual(p.turnTrigger, 'capacity_retry_manual');
assert.strictEqual(p.turnTrigger, h.RETRY_TRIGGER);

// 最重要的兩條：不重送使用者內容、不外帶 policy
assert.deepStrictEqual(p.input, [], 'input 必須是空陣列');
for (const k of h.NULL_FIELDS) {
  assert.strictEqual(p[k], null, `${k} 必須是 null（實錄的重試就是送 null）`);
}
assert.strictEqual(p.permissions, null, ':danger-full-access 不可被帶出去');

// per-thread 欄位要原封照抄
assert.strictEqual(p.cwd, tpl.cwd);
assert.deepStrictEqual(p.runtimeWorkspaceRoots, tpl.runtimeWorkspaceRoots);
assert.deepStrictEqual(p.collaborationMode, tpl.collaborationMode);
assert.deepStrictEqual(p.responsesapiClientMetadata, tpl.responsesapiClientMetadata);
assert.strictEqual(p.serviceTier, 'default');

// 兩個 id 必須是不同的新 uuid
assert.notStrictEqual(p.clientUserMessageId, m.request.id);
assert.match(p.clientUserMessageId, /^uuid-/);
assert.match(m.request.id, /^uuid-/);

// 缺料就拒絕，不要瞎送
assert.throws(() => h.buildRetryRequest('TH-2', null, uuid, now), /no template/);
assert.throws(() => h.buildRetryRequest(null, tpl, uuid, now), /no threadId/);

// 模板沒有某欄位時就不要無中生有
const thin = { hostId: 'local', cwd: 'C:\\p' };
const m2 = h.buildRetryRequest('TH-3', thin, uuid, now);
assert.ok(!('collaborationMode' in m2.request.params), '模板沒有的欄位不該憑空補上');
assert.strictEqual(m2.request.params.cwd, 'C:\\p');

// 背景重送的上限：serverOverloaded 無限
assert.strictEqual(h.CFG['ipc:serverOverloaded'].max, Infinity);
assert.ok(!h.CFG['ipc:usageLimitExceeded'], '配額類不該有背景重送設定');

console.log('ok  buildRetryRequest：信封 / 觸發器 / 空 input / policy 全 null / 模板照抄 / id 唯一 / 缺料拒絕');

// --- 最小參數退路：只能有讀到的欄位，不可編造 ---
{
  const m3 = h.buildMinimalRetryRequest('TH-9', {cwd: 'C:\proj', model: 'gpt-6-astra',
                                                 reasoningEffort: 'medium'}, uuid, now);
  const q = m3.request.params;
  assert.strictEqual(q.threadId, 'TH-9');
  assert.strictEqual(q.turnTrigger, h.RETRY_TRIGGER);
  assert.deepStrictEqual(q.input, []);
  assert.strictEqual(q.cwd, 'C:\proj');
  for (const k of h.NULL_FIELDS) assert.strictEqual(q[k], null, k);
  // 這些讀不到，就絕對不能出現
  for (const k of ['collaborationMode', 'runtimeWorkspaceRoots', 'multiAgentMode',
                   'summary', 'personality', 'responsesapiClientMetadata']) {
    assert.ok(!(k in q), `${k} 讀不到就不該被編造出來`);
  }
  // model/effort 讀得到也不該塞進去（實錄的重試是送 null，由 server 解）
  assert.strictEqual(q.model, null);
  assert.strictEqual(q.effort, null);
  assert.strictEqual(m3._minimal, true);
  assert.throws(() => h.buildMinimalRetryRequest('T', null, uuid, now), /no threadInfo/);
  console.log('ok  buildMinimalRetryRequest：只填讀到的欄位，不編造 collaborationMode');
}

// --- 模板落地的修剪邏輯：熱換/重開不能把模板弄丟，但也不能無限長大 ---
{
  const NOWMS = 1700000000000;
  const day = 86400000;
  const e = (id, ageDays) => [id, {at: NOWMS - ageDays * day, cwd: "/p/" + id}];
  // 過期的要丟
  let out = h.pruneTemplates([e('a', 1), e('b', 40), e('c', 2)], NOWMS, 50, h.TPL_TTL_MS);
  assert.deepStrictEqual(out.map(x => x[0]), ['a', 'c'], '40 天前的該被丟掉');
  // 新的排前面
  out = h.pruneTemplates([e('old', 5), e('new', 0)], NOWMS, 50, h.TPL_TTL_MS);
  assert.strictEqual(out[0][0], 'new');
  // 超量砍最舊
  const many = Array.from({length: 80}, (_, i) => e('t' + i, i * 0.1));
  out = h.pruneTemplates(many, NOWMS, h.TPL_MAX, h.TPL_TTL_MS);
  assert.strictEqual(out.length, h.TPL_MAX);
  assert.strictEqual(out[0][0], 't0', '最新的要留著');
  // 壞資料不能炸
  assert.deepStrictEqual(h.pruneTemplates([['x', null], ['y', {}], e('z', 0)],
                                          NOWMS, 50, h.TPL_TTL_MS).map(x => x[0]), ['z']);
  assert.deepStrictEqual(h.pruneTemplates([], NOWMS, 50, h.TPL_TTL_MS), []);
  console.log(`ok  pruneTemplates：TTL ${h.TPL_TTL_MS / day} 天 / 上限 ${h.TPL_MAX} 筆 / 壞資料不炸`);
}

// --- 模板救援：從 rollout 的 thread_settings_applied 重建（新版唯一來源）---
{
  const line = (o) => JSON.stringify(o);
  const settingsEvent = (ts, roots, extra) => ({timestamp: '2026-11-03T01:24:22.246Z', type: 'event_msg',
    payload: {type: 'thread_settings_applied', thread_id: 'TH-1',
      thread_settings: {model: 'gpt-6.1-sol', model_provider_id: 'custom', service_tier: 'default',
        approval_policy: 'never', approvals_reviewer: 'user',
        permission_profile: {type: 'disabled'}, active_permission_profile: {id: ':danger-full-access'},
        cwd: 'D:\\augment-projects\\zcode2api-plus', runtime_workspace_roots: roots,
        reasoning_effort: 'max', reasoning_summary: 'detailed', personality: 'friendly',
        collaboration_mode: {mode: 'default', settings: {model: 'gpt-6.1-sol',
          reasoning_effort: 'max', developer_instructions: '<collab>...(長文)...'}},
        disabled_plugin_ids: [], ...(extra || {})}}});

  // 1. 取最後一筆（前面的 turn 可能設定不同，重試要照最近那一筆）
  const text = [line({payload: {type: 'task_started'}}),
                line(settingsEvent(1, ['D:\\p'])),
                line({payload: {type: 'token_count'}}),
                line(settingsEvent(2, ['D:\\p', 'C:\\vis']))].join('\n');
  const s = h.settingsFromRollout(text);
  assert.deepStrictEqual(s.runtime_workspace_roots, ['D:\\p', 'C:\\vis'], '要取最後一筆');
  assert.strictEqual(s.collaboration_mode.mode, 'default');

  // 2. 壞行 / 空字串 / 沒有事件 -> null，不炸
  assert.strictEqual(h.settingsFromRollout(''), null);
  assert.strictEqual(h.settingsFromRollout('not json\n{broken'), null);
  assert.strictEqual(h.settingsFromRollout(line({payload: {type: 'token_count'}})), null);
  assert.strictEqual(h.settingsFromRollout('{"payload":{"type":"thread_settings_applied"}}'), null,
                     '沒有 thread_settings 就不算');

  // 3. settings -> 模板：只放 TEMPLATE_FIELDS 認得的欄位
  const tpl = h.templateFromSettings(s, {hostId: 'local', cwd: 'IGNORED', runtimeWorkspaceRoots: ['X']});
  assert.strictEqual(tpl.hostId, 'local');
  assert.strictEqual(tpl.cwd, 'D:\\augment-projects\\zcode2api-plus', 'settings 的 cwd 優先');
  // cwd 不在 roots 裡時補回去（實測 app 續跑會掉）；已在裡面就不重複
  assert.deepStrictEqual(tpl.runtimeWorkspaceRoots,
    ['D:\\augment-projects\\zcode2api-plus', 'D:\\p', 'C:\\vis']);
  const tplDedup = h.templateFromSettings({cwd: 'D:\\p', runtime_workspace_roots: ['D:\\p', 'C:\\vis'],
                                           collaboration_mode: {mode: 'default'}}, null);
  assert.deepStrictEqual(tplDedup.runtimeWorkspaceRoots, ['D:\\p', 'C:\\vis'], 'cwd 已在 roots 就不重複');
  assert.strictEqual(tpl.collaborationMode.mode, 'default');
  assert.strictEqual(tpl.personality, 'friendly');
  assert.strictEqual(tpl.serviceTier, 'default');
  for (const k of ['responsesapiClientMetadata', 'multiAgentMode', 'summary']) {
    assert.ok(!(k in tpl), `rollout 沒有 ${k} 就不該編造`);
  }
  // 模板裡絕不可出現 policy / permission 類欄位
  for (const k of ['permissions', 'approvalPolicy', 'sandboxPolicy', 'model', 'effort']) {
    assert.ok(!(k in tpl), `模板不該帶 ${k}`);
  }

  // 4. 沒 settings 時退回 thread/read 的 cwd（但仍然沒有 collaborationMode -> 呼叫端會擋）
  const tpl2 = h.templateFromSettings(null, {hostId: 'local', cwd: 'C:\\only-cwd'});
  assert.strictEqual(tpl2.cwd, 'C:\\only-cwd');
  assert.ok(!tpl2.collaborationMode, '沒有來源就不該有 collaborationMode');
  assert.strictEqual(h.templateFromSettings(null, null), null, '什麼都沒有就回 null');

  // 5. 救回來的模板送出去，仍然必須是「空 input + policy 全 null」
  const m4 = h.buildRetryRequest('TH-1', tpl, uuid, now);
  const q4 = m4.request.params;
  assert.deepStrictEqual(q4.input, []);
  for (const k of h.NULL_FIELDS) assert.strictEqual(q4[k], null, k);
  assert.strictEqual(q4.turnTrigger, h.RETRY_TRIGGER);
  assert.deepStrictEqual(q4.collaborationMode, tpl.collaborationMode);
  assert.strictEqual(q4.serviceTier, 'default');

  // 6. personality/serviceTier 是 null 也算有值（不能因為 falsy 被吃掉）
  const tpl3 = h.templateFromSettings({cwd: '/p', collaboration_mode: {mode: 'plan'},
                                       personality: null, service_tier: null}, null);
  assert.ok('personality' in tpl3 && tpl3.personality === null);
  assert.ok('serviceTier' in tpl3 && tpl3.serviceTier === null);

  console.log('ok  settingsFromRollout / templateFromSettings：取最後一筆 / 壞行不炸 / 只抄認得的欄位 / 不編造 / 空 input + policy 全 null');
}

