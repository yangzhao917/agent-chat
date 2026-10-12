// 提示词构造属于领域规则：人设如何渲染成指令、输出协议如何定义、
// 循证要求如何注入，都与具体 HTTP 客户端无关，因此放在 domain 而非 llm 目录。

function formatHistory(messages) {
  return messages.map((m) => `${m.speakerName}: ${m.content}`).join('\n');
}

function personaBlock(agent) {
  const lines = [
    `你是群聊中的成员：${agent.name}（${agent.title}）。`,
    `性格：${agent.personality}`,
    `说话风格：${agent.style}`,
  ];
  if (agent.background) lines.push(`背景：${agent.background}`);
  if (agent.interests.length) lines.push(`你关注的领域：${agent.interests.join('、')}`);
  if (agent.quirk) lines.push(`特点：${agent.quirk}`);
  return lines.join('\n');
}

// 有目标讨论时注入的循证要求：目标是让观点可核查，而不是让每人每次发言都堆引用。
const EVIDENCE_SPEECH_RULE = [
  '5. 事实与数据纪律：涉及事实、数据、比例、趋势或案例时，必须给出可核查的来源',
  '   （机构/报告名 + 年份，如"据 Gartner 2024 年报告"）；没有把握就明说"我没有可靠数据"，',
  '   禁止编造数字或虚构引用。观点和推测可以直说，但不要伪装成事实。',
].join('\n');

const EVIDENCE_DECISION_RULE = '有数据或可靠依据可以补充 → urge 高；';

// 决策提示：只让模型判断"想不想接话"，输出严格 JSON，控制成本（轻量模型 + 低温）。
export function buildDecisionMessages({ agent, history, roster, recentSpeakers = [], evidenceRequired = false }) {
  return [
    {
      role: 'system',
      content: [
        personaBlock(agent),
        '',
        '你在一个群聊里。下面会给你最近的聊天记录，请判断你现在是否想接话。',
        '只输出一个 JSON 对象，禁止输出任何其他文字、解释或代码块围栏：',
        '{"want": true 或 false, "urge": 0到10的整数, "reason": "不超过20个字的理由"}',
        '判断标准：被 @ 到、有独到信息或数据、观点被误解、话题正中你的领域 → urge 高；',
        evidenceRequired ? EVIDENCE_DECISION_RULE : '',
        '无话可说、纯寒暄、需要你不具备的专业细节 → urge 低。',
        '不要为了刷存在感而发言；宁可少说，不说废话。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: [
        '【聊天记录】（从早到晚）',
        formatHistory(history),
        '',
        `【当前成员】${roster}`,
        recentSpeakers.length ? `【最近发言顺序】${recentSpeakers.join(' → ')}` : '',
        '请输出你的决策 JSON。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

// 发言提示：人设驱动的口语化发言 + 提名下一位发言者。
export function buildSpeechMessages({ agent, history, roster, evidenceRequired = false }) {
  return [
    {
      role: 'system',
      content: [
        personaBlock(agent),
        '',
        '现在轮到你在这个群聊里发言。严格遵守：',
        '1. 只用中文、第一人称，像真人一样口语化，1-3 句话，总共不超过120字；',
        '2. 不要重复别人已经说过的内容，可以对某人表示赞同/反对/补充，想回应谁就在内容里 @名字；',
        '3. 只输出一个 JSON 对象，禁止输出任何其他文字或代码块围栏：',
        '   {"content": "你的发言", "next": "你希望接下话的成员名字，没有则填 null"}',
        '4. next 只能从当前成员名单里选，不能选自己，不确定就填 null。',
        evidenceRequired ? EVIDENCE_SPEECH_RULE : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: [
        '【聊天记录】（从早到晚）',
        formatHistory(history),
        '',
        `【当前成员】${roster}`,
        '请发言。',
      ].join('\n'),
    },
  ];
}

// 总结提示：把整段讨论压缩成保留来源的摘要，供"总结讨论"按钮使用。
export function buildSummaryMessages({ history }) {
  return [
    {
      role: 'system',
      content: [
        '你是群聊讨论的记录员。请把下面的群聊记录总结成一段中文摘要，要求：',
        '1. 提炼各方核心观点、主要分歧，以及达成了哪些共识或仍未解决的疑问；',
        '2. 保留其中出现的关键数据及其出处（机构/报告名 + 年份）；',
        '3. 300 字以内，直接输出摘要正文，不要输出 JSON、标题或任何解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: ['【聊天记录】（从早到晚）', formatHistory(history), '', '请输出讨论总结。'].join('\n'),
    },
  ];
}
