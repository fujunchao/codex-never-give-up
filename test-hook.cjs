const assert = require('node:assert');
const { makeBrain, CFG, IDLE_RESET_MS } = require('./codex-retry-hook.js');

let t = 1000;
const brain = makeBrain(CFG, () => t);
const OVER = 'localConversation.serverOverloaded.retry';

// 白名單外一律不按
for (const k of ['localConversation.usageLimit.retry',
                 'localConversation.turnRenderError.retry',
                 'localConversation.summaryPanelRenderError.retry',
                 'localTaskRow.resumeConfigError',
                 'someRandom.key']) {
  assert.strictEqual(brain.decide(k).click, false, k);
}

// 過載那條：無限次，但要吃 gapMs
let d = brain.decide(OVER); assert.ok(d.click); d.commit();
assert.match(brain.decide(OVER).why, /cooldown/);             // 同一毫秒內，被間隔擋住
t += 2000;                                                    // 要大於 GLOBAL_GAP_MS
d = brain.decide(OVER); assert.ok(d.click, 'gap 過了就該放行'); d.commit();

// 連按 500 次都不該被上限擋住（Infinity）
for (let i = 0; i < 500; i++) { t += 2000; const x = brain.decide(OVER); assert.ok(x.click, `i=${i}`); x.commit(); }

// 有限上限的那條要真的擋
const WC = 'localConversation.writerConflict.retry';
const b2 = makeBrain(CFG, () => t);
for (let i = 0; i < CFG[WC].max; i++) { t += 5000; const x = b2.decide(WC); assert.ok(x.click, `wc i=${i}`); x.commit(); }
t += 5000;
assert.match(b2.decide(WC).why, /cap 30 reached/);

// 安靜夠久要歸零（等於這回合成功了）
t += IDLE_RESET_MS + 1;
assert.ok(b2.decide(WC).click, '閒置後應該重新計數');

console.log('ok  (whitelist / infinite cap / finite cap / cooldown / idle-reset)');

// --- 全域間隔：同一次失敗長出兩顆不同的鈕，只該按到一顆 ---
{
  const { GLOBAL_GAP_MS } = require('./codex-retry-hook.js');
  let tt = 500000;
  const b = makeBrain(CFG, () => tt);
  const COUNTDOWN = 'localConversation.serverOverloaded.retryCountdown';
  const PLAIN     = 'localConversation.serverOverloaded.retry';

  let x = b.decide(COUNTDOWN); assert.ok(x.click); x.commit();
  tt += 23;                                        // 實測就是 23ms
  const y = b.decide(PLAIN);
  assert.strictEqual(y.click, false, '23ms 後不同 key 也該被全域間隔擋住');
  assert.strictEqual(y.why, 'global cooldown');

  tt += GLOBAL_GAP_MS;                             // 過了全域間隔就放行
  const z = b.decide(PLAIN);
  assert.ok(z.click, '過了全域間隔應該放行'); z.commit();

  // 全域間隔不該把 per-key 的計數搞亂
  assert.strictEqual(b.stats()[COUNTDOWN].n, 1);
  assert.strictEqual(b.stats()[PLAIN].n, 1);
  console.log(`ok  (全域間隔 ${GLOBAL_GAP_MS}ms，擋掉 23ms 的重複送出)`);
}

// --- rateLimitExceeded（Azure TPM 429，實錄自 rollout 的 codex_error_info）---
{
  const { IPC_CFG, GLOBAL_GAP_MS } = require('./codex-retry-hook.js');
  const RL = 'ipc:rateLimitExceeded';
  assert.strictEqual(IPC_CFG.rateLimitExceeded.retry, true, 'IPC 分類要放行');
  assert.strictEqual(CFG[RL].max, Infinity, '上限要無限');
  let tt = 900000;
  const b = makeBrain(CFG, () => tt);
  // 實際節奏由 per-key gapMs 與全域間隔兩者的較大者決定
  const step = Math.max(CFG[RL].gapMs, GLOBAL_GAP_MS) + 1;
  for (let i = 0; i < 300; i++) { tt += step; const x = b.decide(RL); assert.ok(x.click, `rl i=${i}`); x.commit(); }
  // 配額那條依然刻意不重試，別被順手打開
  assert.strictEqual(IPC_CFG.usageLimitExceeded.retry, false);
  assert.strictEqual('ipc:usageLimitExceeded' in CFG, false);
  console.log('ok  (rateLimitExceeded 可重試且無上限；usageLimitExceeded 維持不重試)');
}
// --- 26.1103：429 的終態是 responseTooManyFailedAttempts，不是 rateLimitExceeded ---
// 實錄 rollout-…-01a1bf8e….jsonl：
//   task_complete.error = {message:'exceeded retry limit, last status: 429 Too Many Requests',
//                          codex_error_info:{response_too_many_failed_attempts:{http_status_code:429}}}
// 舊版 IPC_CFG 沒有這個變體 → 只記一行「未分類，不動作」，工具在最該出手的地方靜默失效。
{
  const { IPC_CFG, CFG, ALL_ERROR_VARIANTS, decideRetry, GLOBAL_GAP_MS } = require('./codex-retry-hook.js');
  const RL429 = 'responseTooManyFailedAttempts';
  const msg = 'exceeded retry limit, last status: 429 Too Many Requests';

  // 1. 每個 app-server 的 CodexErrorInfo 變體都要有分類，一個都不能漏（漏了就是靜默失效）
  for (const v of ALL_ERROR_VARIANTS) {
    assert.ok(IPC_CFG[v], `IPC_CFG 少了變體 ${v}`);
  }
  // 反過來也不該有表裡沒有的鍵（打錯字會讓整條路徑失效）
  for (const k of Object.keys(IPC_CFG)) {
    assert.ok(ALL_ERROR_VARIANTS.includes(k), `IPC_CFG 有未知鍵 ${k}`);
  }

  // 2. 429 終態要真的被放行，而且走自己那條無限路徑
  const d = decideRetry(IPC_CFG[RL429], RL429, { msg });
  assert.strictEqual(d.retry, true, '429 終態必須重試');
  assert.strictEqual(d.cfgKey, 'ipc:' + RL429);
  assert.strictEqual(CFG[d.cfgKey].max, Infinity, '上限要無限');
  let tt = 1000;
  const b = makeBrain(CFG, () => tt);
  const step = Math.max(CFG[d.cfgKey].gapMs, GLOBAL_GAP_MS) + 1;
  for (let i = 0; i < 200; i++) { tt += step; const x = b.decide(d.cfgKey); assert.ok(x.click, `429 i=${i}`); x.commit(); }

  // 3. 永久性錯誤維持不重試（不能為了救 429 把這些順手打開）
  for (const v of ['usageLimitExceeded', 'contextWindowExceeded', 'sessionBudgetExceeded',
                   'misalignmentPolicyViolation', 'cyberPolicy', 'bioPolicy',
                   'unauthorized', 'badRequest', 'invalidPrompt', 'sandboxError',
                   'modelNotFound', 'interrupted', 'activeTurnNotSteerable']) {
    assert.strictEqual(decideRetry(IPC_CFG[v], v, { msg }).retry, false, `${v} 不該重試`);
    assert.ok(!(`ipc:${v}` in CFG), `${v} 不該有背景重送設定`);
  }

  console.log('ok  (429 終態 responseTooManyFailedAttempts 可重試且無上限；全表無漏、無錯字、永久性維持不重試)');
}

// --- 未分類的新變體：看訊息，暫時性才試，而且有上限 ---
{
  const { IPC_CFG, CFG, decideRetry, shouldRetryByMessage, GLOBAL_GAP_MS } = require('./codex-retry-hook.js');

  // 真正未知的變體（不在 ALL_ERROR_VARIANTS 裡）
  const unknown = decideRetry(undefined, 'someBrandNewFailure', { msg: 'upstream returned 503' });
  assert.strictEqual(unknown.retry, true, '未知變體但訊息是 503 → 該試');
  assert.strictEqual(unknown.cfgKey, 'ipc:__unknown');
  assert.strictEqual(CFG['ipc:__unknown'].max, 5, '未知變體的重試必須有上限，不能無限空轉');

  const unknown429 = decideRetry(undefined, 'someBrandNewFailure', { msg: 'exceeded retry limit, last status: 429 Too Many Requests' });
  assert.strictEqual(unknown429.retry, true, '訊息含 429 → 該試');

  // 永久性字眼優先：配額用完的訊息即使含 "429" 也不該被當成限流重試
  const quota = decideRetry(undefined, 'someBrandNewFailure', { msg: '429 usage limit reached for this billing period' });
  assert.strictEqual(quota.retry, false, '永久性字眼要優先');
  const ctx = decideRetry(undefined, 'x', { msg: 'context window exceeded, 950000 tokens' });
  assert.strictEqual(ctx.retry, false);
  // 什麼訊號都沒有 → 不動（寧可不試，也不要對未知錯誤空轉）
  assert.strictEqual(shouldRetryByMessage('').retry, false);
  assert.strictEqual(shouldRetryByMessage('something odd happened').retry, false);
  // 'other' 是 catch-all，也走同一套判斷
  assert.strictEqual(decideRetry(IPC_CFG.other, 'other', { msg: 'stream timed out' }).retry, true);
  assert.strictEqual(decideRetry(IPC_CFG.other, 'other', { msg: 'policy violation' }).retry, false);

  // 上限要真的擋得住（不是只有設定值好看）
  let tt = 2000000;
  const b = makeBrain(CFG, () => tt);
  const step = Math.max(CFG['ipc:__unknown'].gapMs, GLOBAL_GAP_MS) + 1;
  for (let i = 0; i < CFG['ipc:__unknown'].max; i++) { tt += step; const x = b.decide('ipc:__unknown'); assert.ok(x.click, `u i=${i}`); x.commit(); }
  tt += step;
  assert.match(b.decide('ipc:__unknown').why, /cap 5 reached/);

  console.log('ok  (未分類變體看訊息判斷；永久性優先；ipc:__unknown 上限 5 次真的擋得住)');
}
