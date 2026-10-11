// Agent 是人设载体。领域规则只关心"它是谁、怎么说话、关注什么"，
// 不关心背后是哪个模型——模型选择属于基础设施配置。

const REQUIRED_FIELDS = ['id', 'name', 'title', 'personality', 'style'];

export function createAgent(persona) {
  for (const field of REQUIRED_FIELDS) {
    if (!persona[field] || typeof persona[field] !== 'string') {
      throw new Error(`人设缺少必要字段: ${field}`);
    }
  }
  return Object.freeze({
    id: persona.id,
    name: persona.name,
    title: persona.title,
    personality: persona.personality,
    style: persona.style,
    background: persona.background ?? '',
    interests: Object.freeze([...(persona.interests ?? [])]),
    quirk: persona.quirk ?? '',
    color: persona.color ?? '#8b93a7',
  });
}

// 提示词与 UI 共用的名册摘要：让模型知道"房间里都有谁"。
export function rosterSummary(agents) {
  return agents.map((a) => `${a.name}（${a.title}）`).join('；');
}
