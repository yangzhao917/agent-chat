import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoom } from '../src/domain/room.js';
import { createDefaultRoster } from '../src/domain/personas.js';
import { createChatService } from '../src/app/chatService.js';
import { createFakeLlm, createGate } from './helpers/fakeLlm.js';

function makeService({ llm, scheduling = {}, history = {}, rng = Math.random } = {}) {
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
    rng,
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

test('无人想发言时也不会停下：兜底接话直到预算耗尽', async () => {
  const silent = createFakeLlm();
  silent.decide = async () => JSON.stringify({ want: false, urge: 1, reason: '无话可说' });
  const { service, room } = makeService({ llm: silent, scheduling: { maxAgentMessagesPerTurn: 4 } });
  const end = await hostSay(service, '有人吗？');
  // 没有待机状态：即使全员不想发言，也按兜底规则持续发言，直到预算耗尽
  assert.equal(end.payload.reason, 'budget');
  assert.equal(agentMessages(room).length, 4);
  for (let i = 1; i < speakers(room).length; i += 1) {
    assert.notEqual(speakers(room)[i], speakers(room)[i - 1], '兜底也不允许连庄');
  }
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

test('无限额度 + 无待机：Agent 可多次发言，冷场也由兜底接话', async () => {
  // 每位 Agent 只想发言 2 次，第 3 次被问及时沉默；rng 固定取 0 让行为完全确定。
  // 配 6 条预算让测试可终止（线上默认无限，只能靠暂停/清空/预算刹住）。
  const counts = new Map();
  const decisions = new Map(
    createDefaultRoster().map((a) => [
      a.name,
      () => {
        const c = (counts.get(a.name) ?? 0) + 1;
        counts.set(a.name, c);
        return c <= 2 ? { want: true, urge: 6 } : { want: false, urge: 0 };
      },
    ]),
  );
  const { service, room } = makeService({
    llm: createFakeLlm({ decisions }),
    scheduling: { maxAgentMessagesPerTurn: 6, maxPerAgentPerTurn: 0 },
    rng: () => 0,
  });
  const end = await hostSay(service, '无限额度测试：大家随便聊');
  assert.equal(end.payload.reason, 'budget');
  assert.equal(agentMessages(room).length, 6);
  // 前 3 条是自愿发言（林晚舟、陈墨可多次发言）；之后全员沉默，由兜底规则接满预算
  assert.deepEqual(speakers(room).slice(0, 3), ['林晚舟', '陈墨', '林晚舟']);
  assert.ok(speakers(room).length > new Set(speakers(room)).size, '同一 Agent 在一轮内多次发言');
  for (let i = 1; i < speakers(room).length; i += 1) {
    assert.notEqual(speakers(room)[i], speakers(room)[i - 1], '仍然不允许连庄');
  }
});

test('配置了预算时仍然受预算约束（向后兼容）', async () => {
  const { service, room } = makeService({
    llm: createFakeLlm(),
    scheduling: { maxAgentMessagesPerTurn: 3, maxPerAgentPerTurn: 0 },
  });
  const end = await hostSay(service, '有限预算测试');
  assert.equal(end.payload.reason, 'budget');
  assert.equal(agentMessages(room).length, 3);
});

test('暂停中的回合结束时，状态仍是暂停而非待机', async () => {
  const gate = createGate();
  const llm = createFakeLlm({ gate });
  const { service, room, events } = makeService({ llm });
  const firstTurn = hostSay(service, '暂停语义测试');
  while (llm.calls.decide.length === 0) await new Promise((r) => setImmediate(r));
  service.setPaused(true);
  gate.release();
  const end = await firstTurn;
  assert.equal(end.payload.paused, true, 'turn_end 必须带上真实暂停状态');
  assert.equal(room.paused, true);
});

test('清空历史会中止进行中的回合，不再基于空上下文发言', async () => {
  const gate = createGate();
  const llm = createFakeLlm({ gate });
  const { service, room, events } = makeService({ llm });
  const firstTurn = hostSay(service, '清空中止测试');
  while (llm.calls.decide.length === 0) await new Promise((r) => setImmediate(r));
  service.clearHistory();
  gate.release();
  await firstTurn;
  assert.equal(room.messages.length, 0, '清空后不得再有任何消息（含在途发言）');
  assert.ok(events.some((e) => e.type === 'turn_end' && e.payload.reason === 'cleared'));
});

test('有目标的讨论会向 Agent 注入循证要求，自由讨论不会', async () => {
  const llm = createFakeLlm();
  const { service } = makeService({ llm });

  await hostSay(service, '有依据吗：远程办公能提升多少产出？');
  const targetedSpeech = llm.calls.speak[0].messages.map((m) => m.content).join('\n');
  assert.match(targetedSpeech, /事实与数据纪律/, '有目标讨论必须要求引用可核查来源');
  const targetedDecision = llm.calls.decide[0].messages.map((m) => m.content).join('\n');
  assert.match(targetedDecision, /有数据或可靠依据可以补充/);

  // 切到自由讨论：提示词里不应再出现循证要求
  llm.calls.speak.length = 0;
  const done = new Promise((resolve) => service.subscribe((e) => e.type === 'turn_end' && resolve(e)));
  service.postHostMessage('大家随便聊', { mode: 'free' });
  await done;
  assert.ok(llm.calls.speak.length > 0);
  for (const call of llm.calls.speak) {
    const prompt = call.messages.map((m) => m.content).join('\n');
    assert.ok(!prompt.includes('事实与数据纪律'), '自由讨论不得注入循证要求');
  }
});

test('总结讨论：生成系统消息入历史，但不参与后续 Agent 上下文', async () => {
  const llm = createFakeLlm();
  const { service, room, events } = makeService({ llm });
  await hostSay(service, '总结测试话题');
  const before = llm.calls.speak.length;

  const summary = await service.summarizeDiscussion();
  assert.equal(summary.kind, 'system');
  assert.equal(summary.meta.summary, true);
  assert.ok(summary.content.length > 0);
  assert.equal(room.messages.at(-1), summary);
  assert.ok(events.some((e) => e.type === 'message' && e.payload.id === summary.id));

  // 再触发一轮：Agent 的上下文里不应出现总结内容
  await hostSay(service, '继续讨论');
  const laterPrompts = llm.calls.speak.slice(before + 1).map((c) => c.messages.map((m) => m.content).join('\n'));
  assert.ok(laterPrompts.length > 0);
  for (const p of laterPrompts) {
    assert.ok(!p.includes(summary.content), '总结是派生记录，不得进入 Agent 上下文');
  }
});

test('没有 Agent 发言时拒绝总结', async () => {
  const { service } = makeService({ llm: createFakeLlm() });
  await assert.rejects(() => service.summarizeDiscussion(), /还没有可总结的讨论/);
});

test('总结不影响调度：不改变上一句发言人与提名', async () => {
  const llm = createFakeLlm();
  const { service, room } = makeService({ llm });
  await hostSay(service, '调度隔离测试');
  const lastAgentBefore = room.messages.filter((m) => m.kind === 'agent').at(-1);
  await service.summarizeDiscussion();
  assert.equal(room.lastSpeakerId, lastAgentBefore.speakerId, '总结不得抢占发言权');
  const eligible = room.eligibleAgents().map((a) => a.id);
  assert.ok(!eligible.includes(lastAgentBefore.speakerId), '禁连庄规则不受总结影响');
});
