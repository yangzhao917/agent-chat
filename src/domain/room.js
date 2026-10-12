// 聊天室聚合根：持有成员与共享消息历史，并封装"谁现在能发言"的领域规则。
// 调度策略本身在 speaking.js，这里只维护状态与不变量。

export function createRoom({ id, title, hostName, agents, scheduling }) {
  // 约定：0 或负值 = 不设上限。预算用 null 表示无限，人数上限用 Infinity。
  const maxBudget = scheduling.maxAgentMessagesPerTurn > 0 ? scheduling.maxAgentMessagesPerTurn : null;
  const maxPerAgent = scheduling.maxPerAgentPerTurn > 0 ? scheduling.maxPerAgentPerTurn : Infinity;
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const messages = [];
  const state = {
    status: 'idle', // idle | discussing：是否有一轮自主对话正在推进
    paused: false,
    lastSpeakerId: null,
    spokeThisTurn: new Map(),
    turnBudget: maxBudget,
    pendingHostInterject: false,
    turnSeq: 0,
  };

  return {
    id,
    title,
    hostName,
    agents,

    get messages() {
      return messages;
    },
    get status() {
      return state.status;
    },
    get paused() {
      return state.paused;
    },
    get lastSpeakerId() {
      return state.lastSpeakerId;
    },
    get turnBudget() {
      return state.turnBudget;
    },
    get lastMessage() {
      return messages[messages.length - 1] ?? null;
    },

    getAgent(agentId) {
      return agentMap.get(agentId) ?? null;
    },

    // 可发言候选：排除上一句发言人（不允许自言自语连庄）、
    // 排除本轮已达发言上限者、暂停时全员不可发言。
    eligibleAgents() {
      if (state.paused) return [];
      return agents.filter(
        (a) => a.id !== state.lastSpeakerId && (state.spokeThisTurn.get(a.id) ?? 0) < maxPerAgent,
      );
    },

    // 本轮已产生的 Agent 消息数（UI 展示用，替代原“剩余额度”语义）
    get turnMessages() {
      let total = 0;
      for (const n of state.spokeThisTurn.values()) total += n;
      return total;
    },

    appendMessage(message) {
      messages.push(message);
      return message;
    },

    // 发言成功或失败都调用：记录发言人、累计本轮次数、（配置了预算时）扣减预算。
    // 失败也计数是为了避免调度器反复选中同一个失灵的 Agent。
    markSpoke(agentId) {
      state.lastSpeakerId = agentId;
      state.spokeThisTurn.set(agentId, (state.spokeThisTurn.get(agentId) ?? 0) + 1);
      if (state.turnBudget !== null) state.turnBudget = Math.max(0, state.turnBudget - 1);
    },

    resetTurn({ budget = maxBudget } = {}) {
      state.spokeThisTurn.clear();
      state.turnBudget = budget;
      state.turnSeq += 1;
    },

    requestHostInterject() {
      state.pendingHostInterject = true;
    },

    // 消费人类插话标记：返回 true 表示回合需要以此为新起点重新评估。
    consumeHostInterject() {
      const had = state.pendingHostInterject;
      state.pendingHostInterject = false;
      return had;
    },

    setPaused(paused) {
      state.paused = Boolean(paused);
    },

    setStatus(status) {
      state.status = status;
    },

    clear() {
      messages.length = 0;
      state.lastSpeakerId = null;
      state.spokeThisTurn.clear();
      state.turnBudget = maxBudget;
      state.pendingHostInterject = false;
      state.turnSeq += 1;
    },

    snapshot() {
      return {
        id,
        title,
        hostName,
        status: state.status,
        paused: state.paused,
        turnBudget: state.turnBudget,
        turnMessages: (() => {
          let total = 0;
          for (const n of state.spokeThisTurn.values()) total += n;
          return total;
        })(),
        lastSpeakerId: state.lastSpeakerId,
        agents: agents.map((a) => ({ id: a.id, name: a.name, title: a.title, color: a.color, quirk: a.quirk })),
      };
    },
  };
}
