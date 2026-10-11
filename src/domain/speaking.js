// 发言调度规则：纯函数，不碰网络与 IO，随机源可注入以便测试锁定行为。
//
// 业务规则（与 docs/plan.md §3.2 一致）：
//   1. 上一位发言者的有效提名优先——对话衔接优先于随机；
//   2. 否则在"想发言"的候选者中按 urge² 加权随机——高意愿更可能发言但不保证，
//      避免强势人设垄断话筒，也保留意外之喜；
//   3. 无人想发言则返回 null，房间转入 idle，绝不空转烧钱。

// 从模型输出中尽力提取 JSON 对象：容忍 ```json 围栏与前后废话。
function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 解析"是否想发言"的决策；无法解析返回 null（调用方按沉默降级处理）。
export function parseDecision(raw) {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const urge = Number(obj.urge);
  if (!Number.isFinite(urge)) return null;
  return {
    want: obj.want === true || obj.want === 'true',
    urge: Math.min(10, Math.max(0, Math.round(urge))),
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 50) : '',
  };
}

// 解析一次发言：content 为必须，next 为提名（仅接受名册内的名字，防提示词注入）。
export function parseSpeech(raw, { roster = [] } = {}) {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') {
    // 降级：模型没按格式输出时，把原文当作发言内容，但不接受任何提名。
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text ? { content: text.slice(0, 300), next: null, degraded: true } : null;
  }
  const content = typeof obj.content === 'string' ? obj.content.trim() : '';
  if (!content) return null;
  const known = new Set(roster.flatMap((a) => [a.id, a.name]));
  const next = typeof obj.next === 'string' && known.has(obj.next.trim()) ? obj.next.trim() : null;
  return { content: content.slice(0, 300), next, degraded: false };
}

// 选出下一位发言者。candidates: Agent[]；decisions: Map<agentId, 决策>；
// nomination: 上一位发言者的提名的名字或 id；rng 可注入。
export function selectNextSpeaker({ candidates, decisions, nomination = null, urgeThreshold = 4, rng = Math.random }) {
  if (!candidates.length) return null;

  const byId = new Map(candidates.map((a) => [a.id, a]));
  const byName = new Map(candidates.map((a) => [a.name, a]));
  if (nomination) {
    const target = byId.get(nomination) ?? byName.get(nomination);
    if (target) return target.id;
  }

  const willing = candidates.filter((a) => {
    const d = decisions.get(a.id);
    return d && d.want && d.urge >= urgeThreshold;
  });
  if (!willing.length) return null;

  const weights = willing.map((a) => Math.pow(decisions.get(a.id).urge, 2));
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < willing.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return willing[i].id;
  }
  return willing[willing.length - 1].id;
}
