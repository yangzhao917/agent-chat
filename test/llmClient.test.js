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

test('推理 token 吃满配额（finish_reason=length）时自动扩容重试', async () => {
  const sentBudgets = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const budget = JSON.parse(init.body).max_tokens;
    sentBudgets.push(budget);
    n += 1;
    if (n === 1) {
      // 第一次：配额被推理吃满，content 为空
      return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '扩容后成功' } }] }) };
  };
  const llm = createLlmClient({ ...base, fetchImpl, maxRetries: 0 });
  assert.equal(await llm.summarize([]), '扩容后成功');
  assert.deepEqual(sentBudgets, [3000, 12000], '应按 4 倍扩容');
});

test('内容被截断（finish_reason=length 且有部分内容）同样扩容重试', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"content":"被截断' } }] }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"content":"完整"}' } }] }) };
  };
  const llm = createLlmClient({ ...base, fetchImpl, maxRetries: 0 });
  assert.equal(await llm.speak([]), '{"content":"完整"}');
});

test('扩容到上限仍被截断则抛错，不无限重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) };
  };
  const llm = createLlmClient({ ...base, fetchImpl, maxRetries: 0 });
  await assert.rejects(() => llm.decide([]), /截断/);
  assert.equal(calls, 3, '首次 + 2 次扩容，共 3 次请求');
});


// ---- 流式发言：reasoning_content 实时透出 ----

// 构造假的流式响应体：把 SSE 文本按 chunks 切片，模拟网络分片
function streamOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
        };
      },
    },
  };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('speakStream 发流式请求，实时回调推理增量并返回完整正文', async () => {
  const bodies = [];
  const llm = createLlmClient({
    ...base,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return streamOf([
        sse({ choices: [{ delta: { reasoning_content: '先想想' } }] }),
        sse({ choices: [{ delta: { reasoning_content: '再说' } }] }),
        sse({ choices: [{ delta: { content: '{"content":"你好"' } }] }),
        sse({ choices: [{ delta: { content: ',"next":null}' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]);
    },
  });
  const reasoning = [];
  const out = await llm.speakStream([{ role: 'user', content: '在吗' }], {
    onReasoning: (d) => reasoning.push(d),
  });
  assert.equal(out, '{"content":"你好","next":null}');
  assert.deepEqual(reasoning, ['先想想', '再说']);
  assert.equal(bodies[0].stream, true, '必须带 stream: true');
  assert.equal(bodies[0].model, 'big');
});

test('SSE 行被网络分片切断时仍能正确拼接', async () => {
  const llm = createLlmClient({
    ...base,
    fetchImpl: async () =>
      streamOf([
        // 同一条 data 行被切成三段，前两段连合法 JSON 都算不上
        'data: {"choices":[{"delta":{"reasoning_con',
        'tent":"半句',
        '思考"}}]}\n\ndata: {"choices":[{"delta":{"content":"完整回答"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]),
  });
  const reasoning = [];
  const out = await llm.speakStream([], { onReasoning: (d) => reasoning.push(d) });
  assert.equal(out, '完整回答');
  assert.deepEqual(reasoning, ['半句思考']);
});

test('流式响应被截断时扩容重试，并通知上层作废已显示的思考', async () => {
  const budgets = [];
  let n = 0;
  const llm = createLlmClient({
    ...base,
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      budgets.push(JSON.parse(init.body).max_tokens);
      n += 1;
      if (n === 1) {
        return streamOf([
          sse({ choices: [{ delta: { reasoning_content: '想了一半' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
        ]);
      }
      return streamOf([
        sse({ choices: [{ delta: { reasoning_content: '重新想' } }] }),
        sse({ choices: [{ delta: { content: '扩容后的完整回答' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]);
    },
  });
  const restarts = [];
  const out = await llm.speakStream([], { onRestart: () => restarts.push(1) });
  assert.equal(out, '扩容后的完整回答');
  assert.deepEqual(budgets, [3000, 12000], '流式路径同样按 4 倍扩容');
  assert.equal(restarts.length, 1, '重试前必须通知上层丢弃半段思考，避免两段被拼成一段');
});

test('流式请求遇到可重试错误时同样退避重试', async () => {
  let n = 0;
  const slept = [];
  const llm = createLlmClient({
    ...base,
    maxRetries: 2,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    fetchImpl: async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 503, text: async () => 'busy' };
      return streamOf([
        sse({ choices: [{ delta: { content: '重试后成功' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]);
    },
  });
  assert.equal(await llm.speakStream([]), '重试后成功');
  assert.equal(n, 2);
  assert.deepEqual(slept, [300]);
});

test('流式响应缺少 body 时抛错，不静默返回空内容', async () => {
  const llm = createLlmClient({ ...base, maxRetries: 0, fetchImpl: async () => ({ ok: true, status: 200 }) });
  await assert.rejects(() => llm.speakStream([]), /body/);
});

test('流式路径同样受并发闸门限制', async () => {
  let inFlight = 0;
  let peak = 0;
  const llm = createLlmClient({
    ...base,
    maxConcurrent: 2,
    maxRetries: 0,
    fetchImpl: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return streamOf([
        sse({ choices: [{ delta: { content: 'ok' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]);
    },
  });
  await Promise.all(Array.from({ length: 8 }, () => llm.speakStream([])));
  assert.equal(peak, 2, '流式请求也必须走并发闸门');
});
