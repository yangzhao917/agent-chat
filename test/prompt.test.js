import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDecisionMessages, buildSpeechMessages, buildSummaryMessages } from '../src/domain/prompt.js';
import { createDefaultRoster } from '../src/domain/personas.js';

const agent = createDefaultRoster()[0];
const history = [{ speakerName: '主持人', content: '小团队该不该自研 IM？' }];
const roster = '林晚舟（产品经理）；陈墨（全栈工程师）';
const flat = (messages) => messages.map((m) => m.content).join('\n');

test('有目标讨论时，发言提示词注入循证要求', () => {
  const withEvidence = flat(buildSpeechMessages({ agent, history, roster, evidenceRequired: true }));
  assert.match(withEvidence, /事实与数据纪律/);
  assert.match(withEvidence, /可核查的来源/);
  assert.match(withEvidence, /禁止编造数字或虚构引用/);
});

test('自由讨论时，发言提示词不注入循证要求', () => {
  const free = flat(buildSpeechMessages({ agent, history, roster }));
  assert.ok(!free.includes('事实与数据纪律'));
  const explicit = flat(buildSpeechMessages({ agent, history, roster, evidenceRequired: false }));
  assert.ok(!explicit.includes('事实与数据纪律'));
});

test('有目标讨论时，决策提示词把"有依据"列为高意愿信号', () => {
  const targeted = flat(buildDecisionMessages({ agent, history, roster, evidenceRequired: true }));
  assert.match(targeted, /有数据或可靠依据可以补充 → urge 高/);
  const free = flat(buildDecisionMessages({ agent, history, roster }));
  assert.ok(!free.includes('有数据或可靠依据可以补充'));
});

test('发言提示词始终包含人设块、输出协议与成员名册', () => {
  const text = flat(buildSpeechMessages({ agent, history, roster }));
  assert.match(text, new RegExp(`你是群聊中的成员：${agent.name}（${agent.title}）`));
  assert.match(text, /"next": "你希望接下话的成员名字，没有则填 null"/);
  assert.ok(text.includes('【当前成员】林晚舟（产品经理）'));
  assert.ok(text.includes('主持人: 小团队该不该自研 IM？'));
});

test('总结提示词要求保留数据来源并限制篇幅', () => {
  const [system, user] = buildSummaryMessages({ history });
  assert.match(system.content, /保留其中出现的关键数据及其出处/);
  assert.match(system.content, /300 字以内/);
  assert.match(user.content, /请输出讨论总结/);
  assert.ok(user.content.includes('主持人: 小团队该不该自研 IM？'));
});
