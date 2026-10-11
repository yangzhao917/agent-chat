// 消息是聊天室的唯一事实来源：只追加、不修改、不删除（"清空"等同于开新的历史）。
// 领域层只定义结构与不变量，不关心它来自 HTTP 请求还是 Agent 生成。

const KINDS = new Set(['human', 'agent', 'system']);

export function createMessage({ speakerId, speakerName, kind, content, meta = {} }, { id, createdAt } = {}) {
  if (typeof speakerName !== 'string' || !speakerName.trim()) {
    throw new Error('消息必须包含非空的发言者名称');
  }
  if (!KINDS.has(kind)) {
    throw new Error(`未知的消息类型: ${kind}`);
  }
  const text = String(content ?? '').trim();
  if (!text) throw new Error('消息内容不能为空');
  if (text.length > 2000) throw new Error('消息内容超过 2000 字上限');
  return {
    id: id ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    speakerId: String(speakerId),
    speakerName: speakerName.trim(),
    kind,
    content: text,
    createdAt: createdAt ?? Date.now(),
    meta,
  };
}
