import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDecision, parseSpeech, selectNextSpeaker } from '../src/domain/speaking.js';

const roster = [
  { id: 'a', name: '甲' },
  { id: 'b', name: '乙' },
  { id: 'c', name: '丙' },
];
const decisions = new Map([
  ['a', { want: true, urge: 9 }],
  ['b', { want: true, urge: 5 }],
  ['c', { want: false, urge: 10 }],
]);

test('parseDecision 解析合法 JSON 并夹紧 urge 范围', () => {
  assert.deepEqual(parseDecision('{"want":true,"urge":12,"reason":"x"}'), { want: true, urge: 10, reason: 'x' });
  assert.equal(parseDecision('{"want":false,"urge":-3}').urge, 0);
  assert.equal(parseDecision('{"want":"true","urge":4}').want, true);
});

test('parseDecision 容忍代码块围栏，拒绝无法解析的输出', () => {
  assert.equal(parseDecision('```json\n{"want":true,"urge":7}\n```').urge, 7);
  assert.equal(parseDecision('我觉得可以'), null);
  assert.equal(parseDecision('{"want":true}'), null); // 缺少 urge
});

test('parseSpeech 只接受名册内的提名，其余置空', () => {
  assert.deepEqual(parseSpeech('{"content":"你好","next":"乙"}', { roster }), { content: '你好', next: '乙', degraded: false });
  assert.deepEqual(parseSpeech('{"content":"你好","next":"不存在的人"}', { roster }).next, null);
  assert.deepEqual(parseSpeech('{"content":"你好","next":"a"}', { roster }).next, 'a', '按 id 提名同样接受（鲁棒性）');
  const degraded = parseSpeech('纯文本没有 JSON', { roster });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.next, null);
  assert.equal(parseSpeech('{"next":"乙"}', { roster }), null, '没有 content 视为无效');
});

test('提名优先于意愿：被提名者即使 urge 低也当选', () => {
  const pick = selectNextSpeaker({ candidates: roster, decisions, nomination: '乙', urgeThreshold: 4, rng: () => 0.99 });
  assert.equal(pick, 'b');
});

test('提名无效时降级为加权随机', () => {
  // 提名不在候选（丙 want=false 不在候选里也无妨，指向不存在的人）
  const pick = selectNextSpeaker({ candidates: roster, decisions, nomination: '不存在', urgeThreshold: 4, rng: () => 0 });
  assert.equal(pick, 'a', 'roll=0 时应选中权重最高的甲');
});

test('无人想发言时返回 null（房间应转入 idle）', () => {
  const allNo = new Map(roster.map((a) => [a.id, { want: false, urge: 9 }]));
  assert.equal(selectNextSpeaker({ candidates: roster, decisions: allNo, urgeThreshold: 4, rng: () => 0 }), null);
});

test('urge 低于阈值视为不想发言', () => {
  const low = new Map([
    ['a', { want: true, urge: 3 }],
    ['b', { want: true, urge: 5 }],
  ]);
  assert.equal(selectNextSpeaker({ candidates: roster, decisions: low, urgeThreshold: 4, rng: () => 0 }), 'b');
});

test('候选为空时返回 null', () => {
  assert.equal(selectNextSpeaker({ candidates: [], decisions: new Map(), rng: () => 0 }), null);
});
