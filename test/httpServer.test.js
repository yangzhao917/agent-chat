import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRoom } from '../src/domain/room.js';
import { createDefaultRoster } from '../src/domain/personas.js';
import { createChatService } from '../src/app/chatService.js';
import { createHttpServer } from '../src/server/httpServer.js';
import { createFakeLlm } from './helpers/fakeLlm.js';
import { request as rawRequest } from 'node:http';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'public');

async function withServer(fn) {
  const room = createRoom({
    id: 'srv',
    title: '服务器测试房',
    hostName: '主持人',
    agents: createDefaultRoster(),
    scheduling: { maxAgentMessagesPerTurn: 12, maxPerAgentPerTurn: 1, messageDelayMs: 0 },
  });
  const service = createChatService({
    room,
    llm: createFakeLlm(),
    store: null,
    scheduling: { maxAgentMessagesPerTurn: 12, maxPerAgentPerTurn: 1, messageDelayMs: 0 },
    history: { max: 30, decisionWindow: 16 },
    sleep: async () => {},
  });
  const http = createHttpServer({ service, publicDir });
  const port = await http.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, service, room });
  } finally {
    await http.close();
  }
}

test('GET / 返回聊天室页面', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /多 Agent 群聊房间/);
  });
});

test('GET /api/state 返回房间快照与 10 位成员', async () => {
  await withServer(async ({ base }) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.agents.length, 10);
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.messages, []);
  });
});

test('POST /api/messages 追加人类消息并触发 Agent 回合', async () => {
  await withServer(async ({ base, room }) => {
    const res = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '大家好' }),
    });
    assert.equal(res.status, 201);
    // 等待回合跑完
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(room.messages[0].kind, 'human');
    assert.ok(room.messages.filter((m) => m.kind === 'agent').length > 0);
  });
});

test('POST /api/messages 拒绝空内容', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
  });
});

test('暂停接口切换房间状态', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal((await res.json()).paused, true);
  });
});

test('静态文件限制在 public 目录内（防目录穿越）', async () => {
  await withServer(async ({ base }) => {
    const ok = await fetch(`${base}/app.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /javascript/);

    // 安全属性：任何穿越尝试都不得拿到 public 之外的文件内容。
    // 注意 new URL() 会折叠 dot 段，join 后的前缀校验是最后一道防线。
    const { port } = new URL(base);
    for (const path of ['/../package.json', '/../../etc/passwd', '/..%2f..%2fpackage.json', '/./../src/config.js']) {
      const res = await new Promise((resolve, reject) => {
        rawRequest({ host: '127.0.0.1', port, path }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, body }));
        }).end();
      });
      assert.ok(res.status >= 400, `${path} 不应成功`);
      assert.ok(!res.body.includes('"name": "agent-chat"'), `${path} 不得泄露仓库文件`);
      assert.ok(!res.body.includes('root:'), `${path} 不得泄露系统文件`);
    }
  });
});

test('SSE 通道推送命名事件', async () => {
  await withServer(async ({ base }) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^event: hello\n/);
    assert.match(text, /"agents"/);
    await reader.cancel(); // 先取消读取再中断，避免残留套接字影响后续测试
    controller.abort();
  });
});

test('POST /api/messages 的 mode 决定循证模式并落库', async () => {
  await withServer(async ({ base, room }) => {
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '有目标的问题', mode: 'targeted' }),
    });
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '随便聊', mode: 'free' }),
    });
    await new Promise((r) => setTimeout(r, 120));
    const humans = room.messages.filter((m) => m.kind === 'human').map((m) => m.meta.mode);
    assert.deepEqual(humans, ['targeted', 'free']);
  });
});

test('POST /api/messages 未传 mode 时按有目标讨论处理', async () => {
  await withServer(async ({ base, room }) => {
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '默认模式' }),
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(room.messages.find((m) => m.kind === 'human').meta.mode, 'targeted');
  });
});

test('POST /api/summary 生成总结系统消息', async () => {
  await withServer(async ({ base, room }) => {
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '总结接口测试' }),
    });
    await new Promise((r) => setTimeout(r, 120));
    const res = await fetch(`${base}/api/summary`, { method: 'POST' });
    assert.equal(res.status, 201);
    const { message } = await res.json();
    assert.equal(message.kind, 'system');
    assert.equal(message.meta.summary, true);
    assert.equal(room.messages.at(-1).id, message.id);
  });
});

test('没有 Agent 发言时 POST /api/summary 返回 400', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/summary`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});
