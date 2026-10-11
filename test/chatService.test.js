import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoom } from '../src/domain/room.js';
import { createDefaultRoster } from '../src/domain/personas.js';
import { createChatService } from '../src/app/chatService.js';
import { createFakeLlm, createGate } from './helpers/fakeLlm.js';

function makeService({ llm, scheduling = {}, history = {} } = {}) {
  const room = createRoom({
    id: 'test-room',
    title: '测试房间',
    hostName: '主持人',
    agents: createDefaultRoster(),
    scheduling: { maxAgentMessagesPerTurn: 12, maxPerAgentPerTurn: 1, messageDelayMs: 0, ...scheduling },
  });
  const events = [];
  const service = createChatService({
    room,
    llm,
    store: null,
    scheduling: { maxAgentMessagesPerTurn: 12, maxPerAgentPerTurn: 1, messageDelayMs: 0, ...scheduling },
    history: { max: 30, decisionWindow: 16, ...history },
    sleep: async () => {},
  });
  service.subscribe((e) => events.push(e));
  return { service, room, events };
}

// 发一条人类消息并等待本轮彻底结束
async function hostSay(service, text) {
  const done = new Promise((resolve) => {
    const un = service.subscribe((e) => {
      if (e.type === 'turn_end') {
        un();
        resolve(e);
      }
    });
  });
  service.postHostMessage(text);
  return done;
}

const agentMessages = (room) => room.messages.filter((m) => m.kind === 'agent');
const speakers = (room) => agentMessages(room).map((m) => m.speakerName);

test('人类消息触发一轮自主对话，10 位成员依次发言且不连庄', async () => {
  const { service, room } = makeService({ llm: createFakeLlm() });
  const end = await hostSay(service, '大家觉得 AI 会取代程序员吗？');
  assert.equal(end.payload.reason, 'no-candidate', '每人一次后无候选，自然结束');
  assert.equal(room.messages[0].kind, 'human');
  assert.equal(speakers(room).length, 10);
  assert.equal(new Set(speakers(room)).size, 10, '同一轮内每位 Agent 只发言一次');
  for (let i = 1; i < speakers(room).length; i += 1) {
    assert.notEqual(speakers(room)[i], speakers(room)[i - 1], '不允许连续两人相同（连庄）');
  }
});

test('共享聊天记录：每次发言的提示词都包含此前全部关键消息', async () => {
  const llm = createFakeLlm();
  const { service, room } = makeService({ llm });
  await hostSay(service, '起点话题：周末去哪玩？');
  assert.ok(llm.calls.speak.length >= 2);
  for (const call of llm.calls.speak) {
    const userPrompt = call.messages.find((m) => m.role === 'user').content;
    assert.ok(userPrompt.includes('起点话题：周末去哪玩？'), '人类消息必须进入每个 Agent 的上下文');
    assert.ok(userPrompt.includes('林晚舟') && userPrompt.includes('郑板儿'), '名册必须下发');
  }
  // 后发言者能看到先发言者的内容
  const lastCall = llm.calls.speak.at(-1);
  const userPrompt = lastCall.messages.find((m) => m.role === 'user').content;
  assert.ok(userPrompt.includes(speakers(room)[0]), '后发言者上下文包含第一位 Agent 的发言');
});

test('无人想发言时房间转入 idle，不产生空转消息', async () => {
  const llm = createFakeLlm({ decisions: new Map([['__all__', { want: false, urge: 9 }]]) });
  // 用默认兜底之外的方式：让所有决策都 want=false
  const silent = createFakeLlm();
  silent.decide = async () => JSON.stringify({ want: false, urge: 1, reason: '无话可说' });
  const { service, room } = makeService({ llm: silent });
  const end = await hostSay(service, '有人吗？');
  assert.equal(end.payload.reason, 'idle');
  assert.equal(agentMessages(room).length, 0);
});

test('上一位发言者的提名优先于意愿加权随机', async () => {
  // 林晚舟 urge=8 会被 rng=0 首先选中；她提名陈墨；陈墨 urge=1 本不可能被选中
  const speeches = new Map();
  for (const a of createDefaultRoster()) speeches.set(a.name, JSON.stringify({ content: `${a.name}的发言`, next: '陈墨' }));
  speeches.set('陈墨', JSON.stringify({ content: '陈墨的发言', next: null }));
  const decisions = new Map([['陈墨', { want: true, urge: 1 }]]);
  const llm = createFakeLlm({ decisions, speeches });
  const { service, room } = makeService({ llm });
  // 通过 rng 注入不可行（服务构造未暴露），改为验证前两名顺序：第一名随机，第二名必须是被提名者
  await hostSay(service, '开始');
  const names = speakers(room);
  assert.equal(names[1], '陈墨', '提名必须优先于加权随机');
});

test('本轮预算耗尽时结束，且原因可区分', async () => {
  const llm = createFakeLlm();
  const { service, room } = makeService({ llm, scheduling: { maxAgentMessagesPerTurn: 4, maxPerAgentPerTurn: 1 } });
  const end = await hostSay(service, '预算测试');
  assert.equal(end.payload.reason, 'budget');
  assert.equal(agentMessages(room).length, 4);
});

test('人类中途插话：以新上下文开启新一轮，Agent 继续接话', async () => {
  const gate = createGate();
  const llm = createFakeLlm({ gate });
  const { service, room, events } = makeService({ llm });
  const firstTurn = hostSay(service, '第一话题');

  // 等回合真正进入（第一次决策调用已发起并被门控挡住）
  while (llm.calls.decide.length === 0) await new Promise((r) => setImmediate(r));
  assert.equal(room.status, 'discussing');

  service.postHostMessage('插话：跑题一下，晚饭吃什么？');
  gate.release();
  await firstTurn;

  const hostMessages = room.messages.filter((m) => m.kind === 'human').map((m) => m.content);
  assert.deepEqual(hostMessages, ['第一话题', '插话：跑题一下，晚饭吃什么？']);
  assert.ok(events.some((e) => e.type === 'turn_restart'), '插话应触发新一轮');

  const interjectIndex = room.messages.findIndex((m) => m.content.includes('插话'));
  const afterInterject = room.messages.slice(interjectIndex + 1).filter((m) => m.kind === 'agent');
  assert.ok(afterInterject.length > 0, '插话之后 Agent 基于新上下文继续发言');
});

test('单个 Agent 决策失败按沉默降级，不影响其他人', async () => {
  const llm = createFakeLlm({ decideThrows: new Set(['苏芮', '何霁']) });
  const { service, room } = makeService({ llm });
  await hostSay(service, '降级测试');
  const names = speakers(room);
  assert.equal(names.length, 8);
  assert.ok(!names.includes('苏芮') && !names.includes('何霁'));
});

test('被选中者发言失败：跳过并继续，连续失败 3 次才中止本轮', async () => {
  const llm = createFakeLlm({ speakThrows: new Set(['all']) });
  const { service, room, events } = makeService({ llm });
  const end = await hostSay(service, '全员发言失败');
  assert.equal(end.payload.reason, 'error');
  assert.equal(agentMessages(room).length, 0);
  assert.ok(events.some((e) => e.type === 'error'), '必须推送 error 事件，不静默');

  // 仅一人失败：其余人照常发言
  const llm2 = createFakeLlm({ speakThrows: new Set(['林晚舟']) });
  const s2 = makeService({ llm: llm2 });
  await hostSay(s2.service, '单人失败');
  const names = speakers(s2.room);
  assert.ok(!names.includes('林晚舟'));
  assert.equal(names.length, 9);
});

test('发言输出无法解析时同样降级跳过', async () => {
  const llm = createFakeLlm();
  llm.speak = async () => '完全不是 JSON 也没有内容';
  const { service, room } = makeService({ llm });
  await hostSay(service, '坏输出');
  // 纯文本降级为发言内容而非跳过（parseSpeech 的降级路径）
  assert.ok(agentMessages(room).length > 0);
  assert.ok(room.messages.every((m) => m.content.length <= 300));
});

test('暂停后停止调度，恢复后继续', async () => {
  const gate = createGate();
  const llm = createFakeLlm({ gate });
  const { service, room, events } = makeService({ llm });
  const firstTurn = hostSay(service, '暂停测试');
  while (llm.calls.decide.length === 0) await new Promise((r) => setImmediate(r));

  service.setPaused(true);
  gate.release();
  await firstTurn;
  const countWhenPaused = agentMessages(room).length;

  service.setPaused(false);
  // 恢复触发新一轮；等待其结束
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(agentMessages(room).length > countWhenPaused, '恢复后应继续产生消息');
  assert.ok(events.some((e) => e.type === 'turn_end'));
});

test('所有消息都写入持久化存储', async () => {
  const persisted = [];
  const store = { append: (m) => persisted.push(m), reset: () => persisted.length = 0 };
  const llm = createFakeLlm();
  const room = createRoom({
    id: 't', title: 't', hostName: '主持人', agents: createDefaultRoster(),
    scheduling: { maxAgentMessagesPerTurn: 3, maxPerAgentPerTurn: 1, messageDelayMs: 0 },
  });
  const service = createChatService({ room, llm, store, scheduling: { maxAgentMessagesPerTurn: 3, maxPerAgentPerTurn: 1, messageDelayMs: 0 }, history: { max: 30, decisionWindow: 16 }, sleep: async () => {} });
  const done = new Promise((resolve) => service.subscribe((e) => e.type === 'turn_end' && resolve(e)));
  service.postHostMessage('持久化测试');
  await done;
  assert.equal(persisted.length, room.messages.length);
  assert.equal(persisted.filter((m) => m.kind === 'agent').length, 3);
});
