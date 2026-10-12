import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoom } from '../src/domain/room.js';
import { createMessage } from '../src/domain/message.js';
import { createDefaultRoster } from '../src/domain/personas.js';

function makeRoom(scheduling = {}) {
  return createRoom({
    id: 'r1',
    title: '测试房间',
    hostName: '主持人',
    agents: createDefaultRoster(),
    scheduling: { maxAgentMessagesPerTurn: 12, maxPerAgentPerTurn: 1, ...scheduling },
  });
}

const msg = (name, kind = 'agent') =>
  createMessage({ speakerId: name, speakerName: name, kind, content: `${name}说话了` });

test('聊天记录按时间追加且只增不减', () => {
  const room = makeRoom();
  room.appendMessage(msg('甲', 'human'));
  room.appendMessage(msg('乙'));
  assert.equal(room.messages.length, 2);
  assert.equal(room.lastMessage.speakerName, '乙');
});

test('刚发言的 Agent 不能立即再次发言（不允许连庄）', () => {
  const room = makeRoom();
  room.appendMessage(msg('林晚舟'));
  room.markSpoke('lin-wanzhou');
  const ids = room.eligibleAgents().map((a) => a.id);
  assert.ok(!ids.includes('lin-wanzhou'));
  assert.equal(ids.length, 9);
});

test('同一轮内发言次数达上限后不再候选', () => {
  const room = makeRoom({ maxPerAgentPerTurn: 1 });
  room.markSpoke('chen-mo');
  assert.ok(!room.eligibleAgents().some((a) => a.id === 'chen-mo'));
  room.resetTurn();
  // 注意：resetTurn 不清除"上一句发言人"，跨轮同样禁止连庄；
  // 只有别人发过言后，上一轮的最后发言者才重新获得候选资格
  assert.ok(!room.eligibleAgents().some((a) => a.id === 'chen-mo'));
  room.markSpoke('su-rui');
  assert.ok(room.eligibleAgents().some((a) => a.id === 'chen-mo'));
});

test('发言（含失败）都会扣减本轮预算', () => {
  const room = makeRoom({ maxAgentMessagesPerTurn: 2 });
  room.markSpoke('a');
  room.markSpoke('b');
  assert.equal(room.turnBudget, 0);
  room.markSpoke('c');
  assert.equal(room.turnBudget, 0, '预算不会扣成负数');
});

test('暂停时全员不可发言', () => {
  const room = makeRoom();
  room.setPaused(true);
  assert.deepEqual(room.eligibleAgents(), []);
  room.setPaused(false);
  assert.equal(room.eligibleAgents().length, 10);
});

test('人类插话标记只被消费一次', () => {
  const room = makeRoom();
  assert.equal(room.consumeHostInterject(), false);
  room.requestHostInterject();
  assert.equal(room.consumeHostInterject(), true);
  assert.equal(room.consumeHostInterject(), false);
});

test('清空历史后房间回到初始状态', () => {
  const room = makeRoom({ maxAgentMessagesPerTurn: 3 });
  room.appendMessage(msg('甲', 'human'));
  room.markSpoke('lin-wanzhou');
  room.clear();
  assert.equal(room.messages.length, 0);
  assert.equal(room.lastMessage, null);
  assert.equal(room.lastSpeakerId, null);
  assert.equal(room.turnBudget, 3);
  assert.equal(room.eligibleAgents().length, 10);
});

test('消息不变量：空内容与未知类型被拒绝', () => {
  assert.throws(() => createMessage({ speakerId: 'x', speakerName: '', kind: 'human', content: 'hi' }));
  assert.throws(() => createMessage({ speakerId: 'x', speakerName: '甲', kind: 'human', content: '  ' }));
  assert.throws(() => createMessage({ speakerId: 'x', speakerName: '甲', kind: 'alien', content: 'hi' }));
  assert.throws(() => createMessage({ speakerId: 'x', speakerName: '甲', kind: 'human', content: 'x'.repeat(2001) }));
});

test('预算与单人上限为 0 时表示无限额度', () => {
  const room = makeRoom({ maxAgentMessagesPerTurn: 0, maxPerAgentPerTurn: 0 });
  assert.equal(room.turnBudget, null);
  // 无限发言：连续发言也不耗尽额度，候选只受"不能连庄"约束
  room.markSpoke('lin-wanzhou');
  room.markSpoke('chen-mo');
  room.markSpoke('su-rui');
  assert.equal(room.turnBudget, null, '无限额度下预算始终为 null');
  assert.equal(room.eligibleAgents().length, 9, '只排除上一句发言人');
  assert.equal(room.turnMessages, 3);
  room.resetTurn();
  // resetTurn 不清除"上一句发言人"：跨轮同样禁止连庄，需别人发言后才恢复资格
  assert.equal(room.eligibleAgents().length, 9);
  assert.ok(!room.eligibleAgents().some((a) => a.id === 'su-rui'));
  room.markSpoke('gu-yan');
  assert.equal(room.eligibleAgents().length, 9);
  assert.ok(room.eligibleAgents().some((a) => a.id === 'su-rui'));
});
