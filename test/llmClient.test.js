import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlmClient, LlmError } from '../src/llm/client.js';

function okFetch(content, calls = []) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

const base = { baseUrl: 'https://llm.test/v1', apiKey: 'k', speakModel: 'big', decisionModel: 'small' };

test('按协议请求 chat/completions 并返回 content', async () => {
  const calls = [];
  const llm = createLlmClient({ ...base, fetchImpl: okFetch('你好', calls) });
  const out = await llm.speak([{ role: 'user', content: '在吗' }]);
  assert.equal(out, '你好');
  assert.equal(calls[0].url, 'https://llm.test/v1/chat/completions');
  assert.equal(calls[0].body.model, 'big');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
});

test('决策与发言使用不同模型与温度', async () => {
  const calls = [];
  const llm = createLlmClient({ ...base, fetchImpl: okFetch('{}', calls) });
  await llm.decide([{ role: 'user', content: 'x' }]);
  await llm.speak([{ role: 'user', content: 'x' }]);
  assert.equal(calls[0].body.model, 'small');
  assert.equal(calls[1].body.model, 'big');
  assert.ok(calls[0].body.temperature < calls[1].body.temperature, '决策应更低温度');
});

test('5xx 与 429 会指数退避重试，最终成功', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push(1);
    n += 1;
    if (n < 3) return { ok: false, status: 503, text: async () => 'busy' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '终于成功' } }] }) };
  };
  const slept = [];
  const llm = createLlmClient({ ...base, fetchImpl, maxRetries: 2, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  assert.equal(await llm.speak([]), '终于成功');
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [300, 600]);
});

test('4xx 不重试，直接抛错', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  const llm = createLlmClient({ ...base, fetchImpl, sleep: () => Promise.resolve() });
  await assert.rejects(() => llm.speak([]), (err) => err instanceof LlmError && err.status === 400);
  assert.equal(calls, 1);
});

test('重试耗尽后抛出最后一次错误', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const llm = createLlmClient({ ...base, fetchImpl, maxRetries: 1, sleep: () => Promise.resolve() });
  await assert.rejects(() => llm.decide([]), /HTTP 500/);
});

test('响应缺少 content 视为失败', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
  const llm = createLlmClient({ ...base, fetchImpl, sleep: () => Promise.resolve() });
  await assert.rejects(() => llm.decide([]), /content/);
});

test('网络异常按可重试处理', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const llm = createLlmClient({ ...base, fetchImpl, sleep: () => Promise.resolve() });
  assert.equal(await llm.speak([]), 'ok');
});

test('缺少 API Key 时快速失败，不发请求', () => {
  assert.throws(() => createLlmClient({ ...base, apiKey: '' }), /LLM_API_KEY/);
});

test('并发闸门把在途请求数限制在 maxConcurrent 以内', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const llm = createLlmClient({ ...base, fetchImpl, maxConcurrent: 3, maxRetries: 0 });
  await Promise.all(Array.from({ length: 12 }, () => llm.decide([])));
  assert.equal(peak, 3, '峰值并发不得超过闸门上限');
});

test('发言与决策的 token 配额可配置', async () => {
  const calls = [];
  const llm = createLlmClient({ ...base, fetchImpl: okFetch('x', calls), speakMaxTokens: 111, decisionMaxTokens: 222 });
  await llm.speak([]);
  await llm.decide([]);
  assert.equal(calls[0].body.max_tokens, 111);
  assert.equal(calls[1].body.max_tokens, 222);
});
