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
