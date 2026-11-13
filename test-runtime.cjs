// 用隔离的浏览器环境回放真实限流通知，覆盖模板恢复和自动重送整条路径。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const THREAD_ID = '01a1ced4-5ce1-77e1-9d81-e664960af5e0';
const TURN_ID = '01a1cf30-7075-7562-b739-5d8e560574f9';
const RATE_ERROR = 'rate limit exceeded: Your requests to gpt-6.1-sol for gpt-6.1-sol in eastus2 have exceeded token rate limit.';
const SETTINGS = {
  cwd: 'C:\\work\\project',
  runtime_workspace_roots: ['C:\\work\\project'],
  collaboration_mode: { mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: '保留原来的计划模式' } },
  personality: 'friendly',
  service_tier: 'default',
};
const ROLLOUT = JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: SETTINGS } });

function chunkMessage(message, transferId) {
  const tokens = [];
  function string(value, target) {
    tokens.push({ type: 'string-start', target });
    for (let offset = 0; offset < value.length; offset += 19) {
      tokens.push({ type: 'string-chunk', value: value.slice(offset, offset + 19) });
    }
    tokens.push({ type: 'string-end' });
  }
  function value(item) {
    if (Array.isArray(item)) {
      tokens.push({ type: 'array-start' });
      item.forEach(value);
      tokens.push({ type: 'container-end' });
    } else if (item !== null && typeof item === 'object') {
      tokens.push({ type: 'object-start' });
      for (const [key, child] of Object.entries(item)) { string(key, 'key'); value(child); }
      tokens.push({ type: 'container-end' });
    } else if (typeof item === 'string') string(item, 'value');
    else tokens.push({ type: 'value', value: item });
  }
  value(message);
  const marker = 'codex-host-chunked-message-v1';
  const packets = [{ marker, kind: 'start', transferId, sequence: 0 }];
  for (let offset = 0; offset < tokens.length; offset += 4) {
    packets.push({ marker, kind: 'chunk', transferId, sequence: packets.length, tokens: tokens.slice(offset, offset + 4) });
  }
  packets.push({ marker, kind: 'end', transferId, sequence: packets.length });
  return packets;
}

function createRuntime({ chunked = true, chunkedThread = false, directInput = true } = {}) {
  let clock = 1_000_000;
  let nextId = 0;
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
  const stored = new Map();
  function addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  }
  function removeEventListener(type, handler) { listeners.get(type)?.delete(handler); }
  function emit(type, event) { for (const handler of [...(listeners.get(type) || [])]) handler(event); }
  function schedule(handler, delay = 0) {
    const id = ++nextId;
    timers.set(id, { at: clock + delay, handler });
    return id;
  }
  const window = { addEventListener, removeEventListener };
  window.electronBridge = {
    sendMessageFromView(message) {
      requests.push(message);
      if (message.type === 'mcp-request' && message.request.method === 'thread/read') {
        const response = { type: 'mcp-response', message: {
          id: message.request.id,
          result: { thread: { id: THREAD_ID, cwd: SETTINGS.cwd, path: 'C:\\sessions\\rollout.jsonl', canAcceptDirectInput: directInput } },
        } };
        const packets = chunkedThread ? chunkMessage(response, message.request.id) : [response];
        packets.forEach((data, index) => schedule(() => emit('message', { data }), index));
      } else if (message.type === 'mcp-request' && message.request.method === 'fs/readFile') {
        const response = { type: 'mcp-response', message: { id: message.request.id, result: {
          dataBase64: Buffer.from(ROLLOUT).toString('base64'),
        } } };
        const packets = chunked ? chunkMessage(response, message.request.id) : [response];
        packets.forEach((data, index) => schedule(() => emit('message', { data }), index));
      }
      // 新版应用以 start / chunk / end 分片传回大文件，旧脚本因此误判没有响应。
      return Promise.resolve();
    },
  };
  const context = vm.createContext({
    window,
    document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], documentElement: {} },
    localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    MutationObserver: class { observe() {} disconnect() {} },
    crypto: { randomUUID: () => `test-${++nextId}` },
    console: { log() {} },
    setTimeout: schedule,
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++nextId,
    clearInterval() {},
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    },
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    TextDecoder,
    Uint8Array,
  });
  vm.runInContext(fs.readFileSync(require.resolve('./codex-retry-hook.js'), 'utf8'), context);
  return {
    hook: window.__codexRetryHook,
    requests,
    emit,
    async advance(duration) {
      const end = clock + duration;
      for (let i = 0; i < 200; i++) {
        // 清空 Promise 链，再运行下一笔计时器；不需要真实等待。
        for (let j = 0; j < 12; j++) await Promise.resolve();
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) { clock = end; return; }
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].handler();
      }
      throw new Error('诊断计时器循环没有结束');
    },
  };
}

async function replay({ chunked = true, chunkedThread = false, chunkedError = false, willRetry = false,
                        directInput = true, errorKind = 'rateLimitExceeded' } = {}) {
  const runtime = createRuntime({ chunked, chunkedThread, directInput });
  const notification = { type: 'mcp-notification', method: 'error', params: {
    threadId: THREAD_ID, turnId: TURN_ID, willRetry: false,
    error: { message: RATE_ERROR, codexErrorInfo: errorKind },
  } };
  notification.params.willRetry = willRetry;
  const packets = chunkedError ? chunkMessage(notification, 'error-transfer') : [notification];
  packets.forEach(data => runtime.emit('message', { data }));
  await runtime.advance(60_000);
  const starts = runtime.requests.filter(message => message.type === 'mcp-request' && message.request.method === 'turn/start');
  return { runtime, starts };
}

async function main() {
  const { runtime, starts } = await replay();
  if (starts.length !== 1) console.log(JSON.stringify({ retryCount: starts.length, log: runtime.hook.log().slice(-8) }, null, 2));
  assert.equal(starts.length, 1, '令牌限流后必须恢复模板并自动发送一次 turn/start');
  assert.equal(starts[0].request.params.collaborationMode.mode, 'plan', '重试必须保留原来的计划模式');
  assert.equal(starts[0].request.params.collaborationMode.settings.model, 'gpt-6.1-sol');
  assert.deepEqual(JSON.parse(JSON.stringify(starts[0].request.params.input)), [], '自动重试不能复制用户消息');
  console.log('ok  (回放实际令牌限流：分片文件恢复模板，自动重试一次，保留模型和计划模式)');

  assert.equal((await replay({ chunked: false })).starts.length, 1, '旧版完整消息仍然兼容');
  assert.equal((await replay({ chunkedThread: true, chunkedError: true })).starts.length, 1, '分片的 thread/read 和错误通知都能识别');
  console.log('ok  (完整消息兼容；分片错误通知、thread/read、fs/readFile 共用解码结果)');

  assert.equal((await replay({ willRetry: true, chunkedError: true })).starts.length, 0, 'Codex 正在重试时不能重复发起');
  assert.equal((await replay({ errorKind: 'usageLimitExceeded', chunkedError: true })).starts.length, 0, '配额用尽不能因为消息分片而误重试');
  assert.equal((await replay({ directInput: false })).starts.length, 0, '子代理会话仍然跳过');
  console.log('ok  (不抢应用自己的重试；配额错误和子代理会话仍然跳过)');

  const { makeHostMessageDecoder, HOST_CHUNK_MARKER } = require('./codex-retry-hook.js');
  const decoder = makeHostMessageDecoder();
  const original = JSON.parse('{"type":"mcp-response","message":{"id":"test","result":{"__proto__":{"safe":true},"empty":"","items":[null,true,42,"中文"]}}}');
  const packets = chunkMessage(original, 'structure');
  let result = null;
  for (const packet of packets) {
    const decoded = decoder.read(packet);
    if (packet.kind !== 'end') assert.equal(decoded, null, '尚未结束不能提前处理');
    else result = decoded;
  }
  assert.deepEqual(result, original);
  assert.equal(Object.getPrototypeOf(result.message.result), Object.prototype, '__proto__ 必须只是普通键');
  assert.equal(decoder.pending(), 0, '完整结束后必须释放分片缓存');
  assert.equal(decoder.read(original), original, '完整消息保持原对象');

  const bad = chunkMessage(original, 'out-of-order');
  decoder.read(bad[0]);
  decoder.read(bad[2]);
  for (const packet of bad.slice(1)) assert.equal(decoder.read(packet), null, '缺片后整条消息应丢弃');
  assert.equal(decoder.pending(), 0);

  decoder.read({ marker: HOST_CHUNK_MARKER, kind: 'start', transferId: 'incomplete', sequence: 0 });
  assert.equal(decoder.read({ marker: HOST_CHUNK_MARKER, kind: 'end', transferId: 'incomplete', sequence: 1 }), null);
  assert.equal(decoder.pending(), 0);

  const small = makeHostMessageDecoder({ maxSize: 32 });
  for (const packet of chunkMessage(original, 'too-large')) assert.equal(small.read(packet), null, '超过大小上限必须丢弃');
  assert.equal(small.pending(), 0);

  let clock = 0;
  const expiring = makeHostMessageDecoder({ now: () => clock, ttlMs: 100 });
  expiring.read({ marker: HOST_CHUNK_MARKER, kind: 'start', transferId: 'expired', sequence: 0 });
  clock = 101;
  expiring.read(original);
  assert.equal(expiring.pending(), 0, '过期的未完成消息必须释放');
  console.log('ok  (嵌套与长字符串组装；未完成、乱序、超限、过期分片丢弃并释放缓存)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
