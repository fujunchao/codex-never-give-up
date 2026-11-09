/* Codex 桌面版 — 對話內重試按鈕的單一入口。
 *
 * 凡是會在對話裡長出重試按鈕的狀態，一律換成「按鈕已被按下」的行為。
 * 上限與間隔全部由下面的 CFG 決定，不再吃 app 內建的 4 次 / 5 次 / 10 次。
 *
 * 分類靠 React fiber 上的 i18n key，不靠按鈕文字 —
 * serverOverloaded / writerConflict / sharedTaskUnavailable 三者的按鈕
 * 文字都是「重試」，靠文字無法分辨。
 */
(() => {
  if (typeof window !== "undefined" && window.__codexRetryHook) return; // 已安裝過

  // max: Infinity = 不設上限。gapMs = 同一條路徑兩次自動按之間至少隔多久。
  const CFG = {
    // 429 / 伺服器過載 —— 就是你要的那條，無限重送
    "localConversation.serverOverloaded.retry": { max: Infinity, gapMs: 1000 },
    "localConversation.serverOverloaded.retryCountdown": {
      max: Infinity,
      gapMs: 1000,
    },
    // 其他確實是暫時性的，給有限次數
    "localConversation.writerConflict.retry": { max: 30, gapMs: 2000 },
    "localConversation.sharedTaskUnavailable.retry": { max: 10, gapMs: 3000 },
    "localConversation.threadHandoff.error.retry": { max: 10, gapMs: 3000 },
    "localConversation.retryHistoryLoad": { max: 10, gapMs: 2000 },
    "localTaskRow.resumeError.retry": { max: 30, gapMs: 2000 },
    "localTaskRow.resumeLiveWriterError": { max: 30, gapMs: 2000 },
    // 背景重送（直接送 RPC，不經 DOM）的上限，key 是 'ipc:' + codexErrorInfo
    "ipc:serverOverloaded": { max: Infinity, gapMs: 1000 },
    "ipc:internalServerError": { max: Infinity, gapMs: 2000 },
    "ipc:httpConnectionFailed": { max: Infinity, gapMs: 1000 },
    "ipc:responseStreamDisconnected": { max: Infinity, gapMs: 1000 },
    // Azure/OpenAI 的 token rate limit（TPM，分鐘級窗口）→ codexErrorInfo: rateLimitExceeded。
    // 實錄自 rollout-…-01a0ffba….jsonl 的 task_complete error。和 usageLimitExceeded（帳號配額，
    // 等重置）不同，這種分鐘級限流等一下就通，值得無限重試。反正無限重試，間隔與過載同為 1s。
    "ipc:rateLimitExceeded": { max: Infinity, gapMs: 1000 },
    // 26.1103 起 429 不會直接變成 rateLimitExceeded，而是先被 Codex 自己退避重試到
    // 「exceeded retry limit, last status: 429 Too Many Requests」才以
    // responseTooManyFailedAttempts 終止（實錄 rollout-…-01a1bf8e….jsonl）。
    "ipc:responseTooManyFailedAttempts": { max: Infinity, gapMs: 1000 },
    "ipc:responseStreamConnectionFailed": { max: Infinity, gapMs: 1000 },
    // 未分類的新變體：靠訊息判斷是暫時性錯誤時走這條，有上限（5 次、間隔 30s），
    // 免得對真正的永久錯誤無限空轉 —— 但至少不會靜默停手。
    "ipc:__unknown": { max: 5, gapMs: 30000 },

    // 故意不自動按，理由寫在這裡免得以後有人手癢加回去：
    //   localConversation.usageLimit.retry            配額用完，重按只是空敲，等重置才有用
    //   localConversation.turnRenderError.retry       UI 渲染失敗，重按會無限空轉
    //   localConversation.summaryPanelRenderError.retry  同上
    //   localTaskRow.resumeConfigError                config.toml 有錯，重按會無限空轉
  };

  // IPC 層的錯誤分類：app-server 的 error 通知直接給 codexErrorInfo，
  // 比按鈕的 i18n key 精確（按鈕文字三種錯誤都是「重試」）。
  // 只有 willRetry:false 才是我們該接手的時機 —— app-server 自己說它放棄了。
  //
  // 這張表必須覆蓋 CodexErrorInfo 的全部變體。26.1103 新增了
  // responseTooManyFailedAttempts（Codex 自己退避重試到超過上限的終態，例如
  // 「exceeded retry limit, last status: 429 Too Many Requests」），舊版表沒有它，
  // 於是 429 只記一行「未分類，不動作」——工具就在最該出手的地方靜默失效。
  // 全表抄自 26.1103.4239.0 的 app-server 二進位（字串在裡面是相鄰排列的）：
  //   context_window_exceeded / session_budget_exceeded / usage_limit_exceeded /
  //   rate_limit_exceeded / server_overloaded / model_not_found /
  //   policy_capacity_unavailable / cyber_policy / bio_policy /
  //   misalignment_policy_violation / http_connection_failed /
  //   response_stream_connection_failed / internal_server_error / unauthorized /
  //   bad_request / invalid_prompt / sandbox_error / response_stream_disconnected /
  //   response_too_many_failed_attempts / active_turn_not_steerable /
  //   thread_rollback_failed / interrupted / other
  // wire 上是 camelCase（rollout 裡才是 snake_case）。新增變體時三處要一起改：
  // 這張表、ALL_ERROR_VARIANTS、test-hook.cjs 的終態清單。
  const IPC_CFG = {
    // —— 可重試：暫時性，等一下就通 ——
    serverOverloaded: { retry: true, gapMs: 1000, note: "伺服器/模型滿載" },
    rateLimitExceeded: { retry: true, gapMs: 1000, note: "TPM/速率限流（分鐘級窗口，等一下就通）" },
    // 本工具存在的理由：Codex 自己重試 >10 分鐘（實測 1068 秒、TTFT 367 秒）後
    // 丟出這個終態並把 willRetry 設 false —— 它放棄了，輪到我們接手。
    responseTooManyFailedAttempts: {
      retry: true,
      gapMs: 1000,
      note: "Codex 內部重試用完（最後一次多半還是 429/5xx）",
    },
    internalServerError: { retry: true, gapMs: 2000, note: "上游 5xx" },
    httpConnectionFailed: { retry: true, gapMs: 1000, note: "連線失敗" },
    responseStreamConnectionFailed: {
      retry: true,
      gapMs: 1000,
      note: "串流建立失敗（26.1103 才出現的名字）",
    },
    responseStreamDisconnected: { retry: true, gapMs: 1000, note: "串流中斷" },
    // other 是 catch-all：看訊息決定（429 / 5xx / 限流字眼才試），見 shouldRetryByMessage
    other: { retry: "auto", note: "未說明的錯誤，依訊息判斷" },

    // —— 刻意不重試：重按只是空轉或燒配額，理由寫在這裡免得以後有人手癢加回去 ——
    contextWindowExceeded: { retry: false, note: "context 爆了，重試無用" },
    sessionBudgetExceeded: { retry: false, note: "本次會話的預算用完，等新會話" },
    usageLimitExceeded: { retry: false, note: "配額用完，等重置才有用" },
    modelNotFound: { retry: false, note: "模型不存在或沒權限，要改設定" },
    policyCapacityUnavailable: { retry: false, note: "帳號層級的政策容量不足" },
    cyberPolicy: { retry: false, note: "安全政策拒絕" },
    bioPolicy: { retry: false, note: "安全政策拒絕" },
    misalignmentPolicyViolation: { retry: false, note: "政策拒絕，重試無用" },
    unauthorized: { retry: false, note: "認證失效，要用戶重新登入" },
    badRequest: { retry: false, note: "請求本身有問題，重送只會再錯一次" },
    invalidPrompt: { retry: false, note: "輸入被拒，重送無用" },
    sandboxError: { retry: false, note: "沙箱環境問題，重試無用" },
    activeTurnNotSteerable: { retry: false, note: "該 turn 不允許 steer，與重試無關" },
    threadRollbackFailed: { retry: false, note: "thread 回滾失敗" },
    interrupted: { retry: false, note: "用戶主動中斷，不要背著人重跑" },
  };

  // 上面那張表的權威來源（測試會逐一檢查有沒有漏）。順序就是二進位裡 enum 的順序。
  const ALL_ERROR_VARIANTS = [
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "rateLimitExceeded",
    "serverOverloaded",
    "modelNotFound",
    "policyCapacityUnavailable",
    "cyberPolicy",
    "bioPolicy",
    "misalignmentPolicyViolation",
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "invalidPrompt",
    "sandboxError",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "activeTurnNotSteerable",
    "threadRollbackFailed",
    "interrupted",
    "other",
  ];

  /* ---------- 未分類變體的退路 ----------
   * Codex 每次更新都可能加新變體（26.1103 就加了兩個），而「未分類 → 不動作」
   * 是最糟的失敗方式：使用者只看到卡住，工具什麼都沒說。所以未知變體先看訊息：
   * 明確的 429 / 5xx / 限流 / 斷線字眼才試，而且走有上限的 'ipc:__unknown'
   * （5 次，間隔 30 秒），絕不無限空轉。永久性字眼優先，避免把配額錯誤當限流。
   */
  const TRANSIENT_RE =
    /\b(429|500|502|503|504|rate[ _-]?limit|too many requests|overloaded|at capacity|temporarily unavailable|time[ _-]?out|timed out|connection (reset|refused|closed)|econnreset|etimedout|network error)\b/i;
  const PERMANENT_RE =
    /\b(usage limit|quota|context window|context length|token budget|max(imum)? tokens|policy|unauthori[sz]ed|forbidden|invalid|not found|sandbox|compaction)\b/i;

  // 純函式：未分類錯誤的訊息到底該不該重試（永久性字眼優先）
  function shouldRetryByMessage(msg) {
    const s = String(msg || "");
    if (PERMANENT_RE.test(s)) return { retry: false, why: "訊息像永久性錯誤" };
    if (TRANSIENT_RE.test(s)) return { retry: true, why: "訊息是明確的暫時性訊號" };
    return { retry: false, why: "訊息沒有暫時性訊號" };
  }

  // 純函式：把「錯誤變體 + 訊息」變成「要不要重試、走哪條 CFG 路徑、理由」。
  // 這三件事以前散在 onIpc 的 if/else 裡，未分類變體直接落進「不動作」，
  // 使用者只看到卡住 —— 現在未分類會看訊息，最多試 'ipc:__unknown' 的上限次數。
  // why 不含變體名（呼叫端統一用 'ipc <kind>: <why>' 組字，免得同一個名字印兩次）。
  function decideRetry(cfg, kind, state) {
    const msg = (state && state.msg) || "";
    if (!cfg) {
      const guess = shouldRetryByMessage(msg);
      if (guess.retry)
        return {
          retry: true,
          cfgKey: "ipc:__unknown",
          why: `未分類變體，但${guess.why}`,
        };
      return { retry: false, why: `未分類變體，${guess.why}，不動作` };
    }
    if (cfg.retry === "auto") {
      const guess = shouldRetryByMessage(msg);
      if (guess.retry)
        return { retry: true, cfgKey: "ipc:__unknown", why: guess.why };
      return { retry: false, why: `${guess.why}，不動作` };
    }
    if (!cfg.retry) return { retry: false, why: `${cfg.note}，刻意不重試` };
    return { retry: true, cfgKey: "ipc:" + kind, why: cfg.note };
  }

  // 背景重送用的常數 —— 全部來自實錄的真實 turn/start，不是推測。
  // 錄到的重試把所有 policy 欄位送 null（app-server 會從 thread 既有狀態解），
  // 所以照抄這個行為，不去複製 permissions/sandboxPolicy 這類東西。
  const RETRY_TRIGGER = "capacity_retry_manual";
  const NULL_FIELDS = [
    "approvalPolicy",
    "approvalsReviewer",
    "sandboxPolicy",
    "permissions",
    "model",
    "effort",
    "outputSchema",
  ];
  // per-thread，必須從該 thread 自己送過的 turn/start 抄
  const TEMPLATE_FIELDS = [
    "cwd",
    "runtimeWorkspaceRoots",
    "collaborationMode",
    "responsesapiClientMetadata",
    "multiAgentMode",
    "summary",
    "personality",
    "serviceTier",
  ];
  let backgroundSend = true;

  const IDLE_RESET_MS = 60_000; // 一條路徑安靜這麼久就把它的次數歸零（等於「這回合成功了」）
  // 全域間隔：gapMs 是 per-key 的，擋不住「同一次失敗連續長出兩顆不同的鈕」。
  // 實測過 retryCountdown 和 retry 相隔 23ms 都被按下 —— 那會送出重複的 turn。
  const GLOBAL_GAP_MS = 1500;
  const KEY_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

  /* ---------- 組出背景重送請求（純函式，可單獨測試） ---------- */
  function buildRetryRequest(threadId, tpl, uuid, now) {
    if (!threadId) throw new Error("no threadId");
    if (!tpl) throw new Error("no template for thread");
    const params = {
      threadId,
      turnTrigger: RETRY_TRIGGER,
      clientUserMessageId: uuid(),
      input: [],
    };
    for (const k of NULL_FIELDS) params[k] = null;
    for (const k of TEMPLATE_FIELDS) if (k in tpl) params[k] = tpl[k];
    return {
      type: "mcp-request",
      hostId: tpl.hostId || "local",
      retainResponse: true,
      priority: "critical",
      source: "turn",
      timeoutMs: 30000,
      expiresAtMs: now() + 30000,
      request: { id: uuid(), method: "turn/start", params },
    };
  }

  // 沒有模板時的退路：只放「thread/read 真的讀到的欄位」，缺的一律省略。
  // 特別是 collaborationMode —— 讀不到就不送，寧可被 app-server 拒絕（會記在 log），
  // 也不要編一個 {mode:'default'} 把人家的 Plan mode 偷偷切掉。
  function buildMinimalRetryRequest(threadId, threadInfo, uuid, now) {
    if (!threadId) throw new Error("no threadId");
    if (!threadInfo) throw new Error("no threadInfo");
    const params = {
      threadId,
      turnTrigger: RETRY_TRIGGER,
      clientUserMessageId: uuid(),
      input: [],
    };
    for (const k of NULL_FIELDS) params[k] = null;
    if (threadInfo.cwd) params.cwd = threadInfo.cwd;
    return {
      type: "mcp-request",
      hostId: "local",
      retainResponse: true,
      priority: "critical",
      source: "turn",
      timeoutMs: 30000,
      expiresAtMs: now() + 30000,
      request: { id: uuid(), method: "turn/start", params },
      _minimal: true,
    };
  }

  // 模板要能活過熱換 / app 重開 / 頁面重載 —— 不然最需要它的時候剛好沒有。
  const TPL_KEY = "codexRetryHook.templates.v1";
  const TPL_MAX = 50;
  const TPL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
  const TPL_MAX_BYTES = 200_000; // localStorage 別塞爆

  // 純函式：留最近的、丟過期的、超量就砍舊的
  function pruneTemplates(entries, nowMs, max, ttlMs) {
    return entries
      .filter(([, v]) => v && typeof v.at === "number" && nowMs - v.at < ttlMs)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, max);
  }

  /* ---------- 模板救援：從 rollout 的 thread_settings_applied 重建 ----------
   * 26.1027 之後 mcp-request 不再經過 codex-message-from-view 這條 CustomEvent，
   * 改成直接呼叫 electronBridge.sendMessageFromView（asar 裡 dispatchMessage 仍在，
   * 但實測整段 turn 只看到 view-focused / persisted-atom-update / log-message /
   * dynamic-tools-for-thread-start-response，一則 mcp-request 都沒有）→ 送出方向的
   * 抓取永久靜默失效、模板快取停更，背景重送就永遠「無模板可抄」。
   * 改用 app-server 自己寫在 rollout 裡的 thread_settings_applied —— 那是
   * 「這一回合實際套用了什麼設定」的權威記錄。
   *
   *   thread/read  -> thread.path（rollout jsonl 路徑）+ cwd / runtimeWorkspaceRoots
   *   fs/readFile  -> { dataBase64 } -> 解碼 -> 取最後一筆 thread_settings_applied
   *
   * 只取 TEMPLATE_FIELDS 裡的欄位；rollout 沒有的（responsesapiClientMetadata /
   * multiAgentMode / summary）寧缺勿編 —— buildRetryRequest 對缺的欄位就是不放。
   */
  const RECOVER = {
    enabled: true,
    maxBytes: 24_000_000, // base64 上限，別把 renderer 記憶體撐爆
    attempts: 3, // 同一筆錯誤最多試幾次救援
  };

  // 純函式：從 rollout 文字裡取最後一筆 thread_settings（沒有就 null）
  function settingsFromRollout(text) {
    if (!text) return null;
    let last = null;
    for (const line of text.split("\n")) {
      if (line.indexOf("thread_settings_applied") === -1) continue;
      try {
        const o = JSON.parse(line);
        const p = o && o.payload;
        if (p && p.type === "thread_settings_applied" && p.thread_settings)
          last = p.thread_settings;
      } catch (e) {
        /* 壞行跳過，不讓一行毀掉整份 */
      }
    }
    return last;
  }

  // 純函式：thread_settings -> 模板（只放 TEMPLATE_FIELDS 認得的欄位）
  function templateFromSettings(settings, info) {
    if (!settings && !info) return null;
    const tpl = { hostId: (info && info.hostId) || "local", at: 0 };
    const cwd = (settings && settings.cwd) || (info && info.cwd);
    if (cwd) tpl.cwd = cwd;
    const roots =
      (settings && settings.runtime_workspace_roots) ||
      (info && info.runtimeWorkspaceRoots);
    // 實測：第一筆 thread_settings_applied 的 roots 是 [cwd, visualizations]，
    // 之後 app 自己續跑時只剩 [visualizations]。cwd 不在 roots 裡是 app 端的怪癖，
    // 對 workspace-write 沙箱可能造成寫入被拒 —— 這裡把 cwd 補回去（不新增別的）。
    if (roots) {
      tpl.runtimeWorkspaceRoots =
        cwd && roots.indexOf(cwd) === -1 ? [cwd, ...roots] : roots;
    }
    if (settings && settings.collaboration_mode)
      tpl.collaborationMode = settings.collaboration_mode;
    // 0 / false / null 都是有效值，只有 undefined 才算沒資料
    if (settings && settings.personality !== undefined)
      tpl.personality = settings.personality;
    if (settings && settings.service_tier !== undefined)
      tpl.serviceTier = settings.service_tier;
    return Object.keys(tpl).length > 2 ? tpl : null; // 只有 hostId/at 等於沒救到
  }

  // base64（app-server fs/readFile 的回傳）-> utf-8 文字
  function decodeBase64Text(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* ---------- 決策核心（可單獨測試，不碰 DOM） ---------- */
  function makeBrain(cfg, now) {
    now = now || (() => Date.now());
    const seen = new Map(); // key -> {n, last}
    let lastAny = 0; // 任何一條路徑上次按下的時間
    return {
      decide(key) {
        const c = cfg[key];
        if (!c) return { click: false, why: "not whitelisted" };
        const t = now();
        if (lastAny && t - lastAny < GLOBAL_GAP_MS) {
          return { click: false, why: "global cooldown" };
        }
        let s = seen.get(key);
        if (s && t - s.last > IDLE_RESET_MS) s = null; // 安靜夠久 -> 重新計數
        s = s || { n: 0, last: 0 };
        if (s.n >= c.max) return { click: false, why: `cap ${c.max} reached` };
        if (s.last && t - s.last < c.gapMs)
          return { click: false, why: "cooldown" };
        return {
          click: true,
          n: s.n + 1,
          commit: () => {
            seen.set(key, { n: s.n + 1, last: t });
            lastAny = t;
          },
        };
      },
      stats: () => Object.fromEntries(seen),
      reset: () => {
        seen.clear();
        lastAny = 0;
      },
    };
  }

  /* ---------- node 下只匯出核心，給 test 用 ---------- */
  if (typeof window === "undefined") {
    if (typeof module !== "undefined") {
      module.exports = {
        makeBrain,
        CFG,
        IDLE_RESET_MS,
        GLOBAL_GAP_MS,
        IPC_CFG,
        ALL_ERROR_VARIANTS,
        decideRetry,
        shouldRetryByMessage,
        buildRetryRequest,
        buildMinimalRetryRequest,
        pruneTemplates,
        settingsFromRollout,
        templateFromSettings,
        RETRY_TRIGGER,
        NULL_FIELDS,
        TEMPLATE_FIELDS,
        TPL_MAX,
        TPL_TTL_MS,
      };
    }
    return;
  }

  /* ---------- 從 DOM 節點走 React fiber 找出 i18n key ---------- */
  function fiberOf(el) {
    for (const k in el) {
      if (
        k.charCodeAt(0) === 95 &&
        (k.startsWith("__reactFiber$") ||
          k.startsWith("__reactInternalInstance$"))
      )
        return el[k];
    }
    return null;
  }

  function i18nId(btn) {
    const f = fiberOf(btn);
    if (!f) return null;
    // 先往下找（<intl id> 通常是按鈕的子節點，就是那顆按鈕的文字）
    const q = [[f, 0]];
    while (q.length) {
      const [node, d] = q.shift();
      if (!node || d > 8) continue;
      const id = node.memoizedProps && node.memoizedProps.id;
      if (typeof id === "string" && KEY_RE.test(id) && Object.hasOwn(CFG, id))
        return id;
      if (node.child) q.push([node.child, d + 1]);
      if (node.sibling && d > 0) q.push([node.sibling, d]);
    }
    // 再往上找（有些是整塊錯誤區塊帶著 key）
    let up = f,
      d = 0;
    while (up && d++ < 12) {
      const id = up.memoizedProps && up.memoizedProps.id;
      if (typeof id === "string" && Object.hasOwn(CFG, id)) return id;
      up = up.return;
    }
    return null;
  }

  const brain = makeBrain(CFG);
  const log = [];
  const lastWhy = new Map(); // key -> 上次記過的理由，一樣就不重複記
  function note(msg) {
    log.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (log.length > 200) log.shift();
    console.log("[codex-retry]", msg);
  }

  let sweeps = 0,
    lastSweepAt = 0;
  function sweep() {
    sweeps += 1;
    lastSweepAt = Date.now();
    const btns = document.querySelectorAll(
      "button:not([disabled]),[role=button]",
    );
    for (const b of btns) {
      if (b.offsetParent === null) continue; // 看不見的不算
      const key = i18nId(b);
      if (!key) continue;
      const d = brain.decide(key);
      if (!d.click) {
        if (
          d.why !== "cooldown" &&
          d.why !== "global cooldown" &&
          lastWhy.get(key) !== d.why
        ) {
          lastWhy.set(key, d.why);
          note(`skip ${key}: ${d.why}`);
        }
        continue;
      }
      lastWhy.delete(key);
      d.commit();
      threads.forEach((v) => {
        v.handled = true;
      }); // DOM 點擊已接手當前對話
      note(
        `click #${d.n} ${key} ("${(b.innerText || "").trim().slice(0, 24)}")`,
      );
      try {
        b.click();
      } catch (e) {
        note(`click failed: ${e}`);
      }
      return; // 一輪只按一顆，等下一輪再看
    }
  }

  // ---------- IPC 偵測：app-server 的事件全部走 window message，每則帶 threadId ----------
  // 這條路不管 UI 有沒有掛載都收得到，背景 thread 也一樣。
  const threads = new Map(); // threadId -> {errorInfo, turnId, at, willRetry, active}
  function normKind(info) {
    if (typeof info === "string") return info;
    if (info && typeof info === "object") {
      const k = Object.keys(info)[0];
      return typeof k === "string" ? k : null;
    }
    return null;
  }
  function onIpc(e) {
    const d = e.data;
    if (!d || typeof d !== "object" || d.type !== "mcp-notification") return;
    const p = d.params || {};

    if (d.method === "error" && p.threadId) {
      const kind = normKind(p.error && p.error.codexErrorInfo);
      const cfg = kind && IPC_CFG[kind];
      threads.set(p.threadId, {
        errorInfo: kind,
        turnId: p.turnId,
        at: Date.now(),
        willRetry: !!p.willRetry,
        msg: (p.error && p.error.message) || "",
        handled: false,
      });
      // 決策：cfg.retry 可能是 true / false / "auto"（未說明的錯誤，看訊息）
      const decision = decideRetry(cfg, kind, threads.get(p.threadId));
      const short = p.threadId.slice(0, 8);
      if (p.willRetry) {
        note(`ipc ${kind}: app-server 會自己重試，不插手 (${short})`);
      } else if (!decision.retry) {
        note(`ipc ${kind || "?"}: ${decision.why} (${short})`);
      } else {
        const cfgKey = decision.cfgKey; // 'ipc:' + kind，或 'ipc:__unknown'
        note(`ipc ${kind || "?"}: ${decision.why} → 重試路徑 ${cfgKey} (${short})`);
        sweep(); // 先試 DOM（當前對話走 app 自己的路徑）
        // 2.5 秒後還卡著，就是背景 thread（DOM 沒有它的按鈕）-> 直接送 RPC
        // 修正：多條對話同時失敗時，全域冷卻會讓後到的 setTimeout 直接放棄，
        // 而且永不再排 —— 那幾條就永久餓死（handled 永遠 false，也沒有新錯誤來喚醒）。
        // 改成：冷卻中就重新排程，直到決策核心放行或 thread 已被處理。
        // 用錯誤時間戳當序號防重複：同 thread 有新錯誤時，舊代定時器自動失效。
        const tid = p.threadId;
        const myErrAt = threads.get(tid) ? threads.get(tid).at : 0;
        let tries = 0;
        const scheduleBg = () => {
          setTimeout(() => {
            const st = threads.get(tid);
            if (!st || st.handled || st.at !== myErrAt) return; // 已處理或已有新錯誤接手
            const d2 = brain.decide(cfgKey);
            if (!d2.click) {
              scheduleBg(); // 冷卻中：重新排，不是放棄
              return;
            }
            tries += 1;
            sendBackgroundRetry(tid, (sent) => {
              if (sent) {
                d2.commit();
                const cur = threads.get(tid);
                if (cur) cur.handled = true;
                return;
              }
              // 送不出去（救不到模板 / bridge 壞掉）：給有限次機會，不要無限空轉
              if (tries < RECOVER.attempts) scheduleBg();
              else
                note(`bg 重試放棄，試了 ${tries} 次仍失敗 (${tid.slice(0, 8)})`);
            });
          }, 2500);
        };
        scheduleBg();
      }
    } else if (d.method === "turn/started" || d.method === "turn/completed") {
      // 新的 turn 開始/結束就清掉舊的錯誤狀態
      const t = p.threadId && threads.get(p.threadId);
      const failed =
        d.method === "turn/completed" && p.turn && p.turn.status === "failed";
      if (t && !failed) threads.delete(p.threadId);
    }
  }
  window.addEventListener("message", onIpc, true);

  // ---------- 快取每個 thread 自己送過的 turn/start，當背景重送的模板 ----------
  function loadTemplates() {
    try {
      const raw = localStorage.getItem(TPL_KEY);
      if (!raw) return new Map();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();
      return new Map(pruneTemplates(arr, Date.now(), TPL_MAX, TPL_TTL_MS));
    } catch (e) {
      return new Map();
    }
  }
  function saveTemplates() {
    try {
      let kept = pruneTemplates(
        [...templates],
        Date.now(),
        TPL_MAX,
        TPL_TTL_MS,
      );
      let json = JSON.stringify(kept);
      while (json.length > TPL_MAX_BYTES && kept.length > 1) {
        // 太大就砍最舊的
        kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
        json = JSON.stringify(kept);
      }
      localStorage.setItem(TPL_KEY, json);
    } catch (e) {
      note("模板存檔失敗: " + e);
    }
  }

  const templates = loadTemplates();
  function onOutbound(e) {
    const d = e.detail;
    if (!d || d.type !== "mcp-request") return;
    const rq = d.request;
    if (!rq || rq.method !== "turn/start") return;
    const p = rq.params || {};
    if (!p.threadId) return;
    const tpl = { hostId: d.hostId, at: Date.now() };
    for (const k of TEMPLATE_FIELDS) if (k in p) tpl[k] = p[k];
    templates.set(p.threadId, tpl); // 只留設定欄位，input 不進快取
    saveTemplates(); // 立刻落地，熱換/重開都不會丟
  }
  window.addEventListener("codex-message-from-view", onOutbound, true);
  document.addEventListener("codex-message-from-view", onOutbound, true);

  let minimalFallback = false; // 預設關閉：這條路會省略 collaborationMode

  function rpc(method, params, timeoutMs) {
    return new Promise((resolve) => {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve(null);
        return;
      }
      const id = crypto.randomUUID();
      let done = false;
      const h = (e) => {
        const d = e.data;
        if (!d || typeof d !== "object") return;
        const msg = d.message;
        if (!msg || msg.id !== id) return;
        done = true;
        window.removeEventListener("message", h, true);
        resolve(msg.result !== undefined ? msg.result : msg);
      };
      window.addEventListener("message", h, true);
      bridge
        .sendMessageFromView({
          type: "mcp-request",
          hostId: "local",
          priority: "background",
          request: { id, method, params },
        })
        .catch(() => {});
      setTimeout(() => {
        if (done) return;
        window.removeEventListener("message", h, true);
        resolve(null);
      }, timeoutMs || 8000);
    });
  }

  // 從 thread/read + rollout 重建模板；救不到回 null（不寫快取、不送）
  // 只有救到 collaborationMode 才算成功 —— 沒有它就可能把 Plan mode 偷偷切回 default。
  function recoverTemplate(threadId) {
    if (!RECOVER.enabled) return Promise.resolve(null);
    const short = threadId.slice(0, 8);
    return rpc("thread/read", { threadId }, 8000)
      .then((res) => {
        const info = res && (res.thread || res);
        if (!info) {
          note("救模板 thread/read 沒回應 " + short);
          return null;
        }
        // 子代理線程設計上不接受直接輸入，別硬送
        if (info.canAcceptDirectInput === false) {
          note("救模板 " + short + " 是子代理（canAcceptDirectInput:false），不送");
          return null;
        }
        const env =
          (info.environments && info.environments[0]) || {};
        const base = {
          hostId: "local",
          cwd: info.cwd || env.cwd,
          runtimeWorkspaceRoots: env.runtimeWorkspaceRoots,
        };
        if (!info.path) {
          note("救模板 " + short + " 沒有 rollout 路徑，救不到 collaborationMode");
          return null;
        }
        return rpc("fs/readFile", { path: info.path }, 15000).then((file) => {
          const b64 = file && file.dataBase64;
          if (!b64) {
            note("救模板 fs/readFile 沒回應 " + short);
            return null;
          }
          if (b64.length > RECOVER.maxBytes) {
            note("救模板 rollout 太大（base64 " + b64.length + "），放棄 " + short);
            return null;
          }
          let text;
          try {
            text = decodeBase64Text(b64);
          } catch (err) {
            note("救模板解碼失敗 " + short + ": " + err);
            return null;
          }
          const settings = settingsFromRollout(text);
          if (!settings) {
            note("救模板 rollout 沒有 thread_settings_applied " + short);
            return null;
          }
          const tpl = templateFromSettings(settings, base);
          if (!tpl || !tpl.collaborationMode) {
            note("救模板缺 collaborationMode " + short);
            return null;
          }
          return tpl;
        });
      })
      .catch((err) => {
        note("救模板失敗 " + short + ": " + err);
        return null;
      });
  }

  function sendWithTemplate(threadId, tpl, finish) {
    const short = threadId.slice(0, 8);
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      note("bg 無法送出：electronBridge 不可用");
      finish(false);
      return;
    }
    let msg;
    try {
      msg = buildRetryRequest(
        threadId,
        tpl,
        () => crypto.randomUUID(),
        () => Date.now(),
      );
    } catch (err) {
      note("bg 組裝失敗 " + short + ": " + err.message);
      finish(false);
      return;
    }
    try {
      bridge.sendMessageFromView(msg);
      note("bg turn/start 已送出 " + short + " (" + RETRY_TRIGGER + ")");
      finish(true);
    } catch (err) {
      note("bg 送出失敗 " + short + ": " + err);
      finish(false);
    }
  }

  // 退路（預設關閉）：只放 thread/read 讀到的欄位，缺 collaborationMode
  function sendMinimalRetry(threadId, finish) {
    const short = threadId.slice(0, 8);
    rpc("thread/read", { threadId }).then((res) => {
      const info = res && (res.thread || res);
      if (!info || !info.cwd) {
        note("bg thread/read 沒有可用資訊 " + short);
        finish(false);
        return;
      }
      let msg;
      try {
        msg = buildMinimalRetryRequest(
          threadId,
          info,
          () => crypto.randomUUID(),
          () => Date.now(),
        );
      } catch (err) {
        note("bg 最小組裝失敗 " + short + ": " + err.message);
        finish(false);
        return;
      }
      try {
        window.electronBridge.sendMessageFromView(msg);
        note("bg turn/start 已送出（最小參數，省略 collaborationMode）" + short);
        finish(true);
      } catch (err) {
        note("bg 最小送出失敗 " + short + ": " + err);
        finish(false);
      }
    });
  }

  // 送背景重試：先吃快取模板；沒有就從 rollout 救一次；再不行才看 minimalFallback。
  // done(sent) 保證只被呼叫一次 —— 呼叫端靠它決定要不要 commit 決策核心。
  function sendBackgroundRetry(threadId, done) {
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      if (typeof done === "function") done(ok);
    };
    const short = threadId.slice(0, 8);
    if (!backgroundSend) {
      note("bg 已停用，跳過 " + short);
      finish(false);
      return;
    }
    const cached = templates.get(threadId);
    if (cached) {
      sendWithTemplate(threadId, cached, finish);
      return;
    }
    recoverTemplate(threadId).then((tpl) => {
      if (tpl) {
        tpl.at = Date.now();
        templates.set(threadId, tpl);
        saveTemplates(); // 救到的模板也落地，下次不用再讀 rollout
        note(
          "bg 模板已從 rollout 重建 " +
            short +
            "（" +
            Object.keys(tpl)
              .filter((k) => k !== "hostId" && k !== "at")
              .join(",") +
            "）",
        );
        sendWithTemplate(threadId, tpl, finish);
        return;
      }
      if (!minimalFallback) {
        note("bg 救援失敗，只記錄不送出 " + short);
        finish(false);
        return;
      }
      sendMinimalRetry(threadId, finish);
    });
  }

  const timer = setInterval(sweep, 700);
  const mo = new MutationObserver(() => sweep());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.__codexRetryHook = {
    cfg: CFG,
    // 診斷用：背景視窗會不會被 Chromium 節流，看這兩個值有沒有在動
    health: () => ({
      sweeps,
      lastSweepAt,
      visibility: document.visibilityState,
      hidden: document.hidden,
    }),
    stats: () => brain.stats(),
    log: () => log.slice(),
    sweep,
    ipcCfg: IPC_CFG,
    retryTrigger: RETRY_TRIGGER,
    templates: () => Object.fromEntries(templates),
    clearTemplates() {
      templates.clear();
      saveTemplates();
      note("模板已清空");
    },
    setBackgroundSend(v) {
      backgroundSend = !!v;
      note("背景重送 " + (v ? "啟用" : "停用"));
    },
    // 沒有模板的 thread 是否用 thread/read 的最小參數硬送（會省略 collaborationMode）
    setMinimalFallback(v) {
      minimalFallback = !!v;
      note("最小參數退路 " + (v ? "啟用" : "停用"));
    },
    // 沒有模板時要不要從 rollout 的 thread_settings_applied 重建（新版的唯一來源）
    setRecovery(v) {
      RECOVER.enabled = !!v;
      note("模板救援 " + (v ? "啟用" : "停用"));
    },
    recoverTemplate, // 手動救單一 thread（診斷用，例如 recoverTemplate('01a1...')）
    // 手動立刻重試某個 thread（救急/驗證用）：走跟自動路徑完全一樣的邏輯
    retryNow(threadId) {
      return new Promise((resolve) => {
        sendBackgroundRetry(threadId, (sent) => {
          const cur = threads.get(threadId);
          if (sent && cur) cur.handled = true;
          resolve(sent);
        });
      });
    },
    rpc, // 唯讀查詢用，例如 rpc('thread/read',{threadId})
    // 目前偵測到有錯誤在身上的 thread（含背景的）
    threads: () => Object.fromEntries(threads),
    stop() {
      clearInterval(timer);
      mo.disconnect();
      window.removeEventListener("message", onIpc, true);
      window.removeEventListener("codex-message-from-view", onOutbound, true);
      document.removeEventListener("codex-message-from-view", onOutbound, true);
      note("stopped");
    },
  };
  note(
    "installed; 上限由 CFG 決定，不吃 app 內建次數" +
      "；載入 " +
      templates.size +
      " 筆模板",
  );
})();
