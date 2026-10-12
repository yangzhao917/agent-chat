// 测试替身：按 Agent 姓名脚本化决策/发言，可注入失败与门控（用于中途插话场景）。
export function createFakeLlm({
  decisions = new Map(),
  speeches = new Map(),
  summaries = new Map(),
  reasonings = new Map(),
  streamRestarts = new Set(),
  decideThrows = new Set(),
  speakThrows = new Set(),
  gate = null,
} = {}) {
  const calls = { decide: [], speak: [], speakStream: [], summarize: [] };

  function lookup(map, agent) {
    const entry = map.get(agent.name);
    if (entry === undefined) return null;
    return typeof entry === 'function' ? entry(agent) : entry;
  }

  async function passGate() {
    if (gate && gate.remaining > 0) {
      gate.remaining -= 1;
      await gate.promise;
    }
  }

  // speak 与 speakStream 共用一套脚本、门控与失败注入：
  // 流式路径不得重复消耗测试门控，否则"挡住第 N 次调用"的语义会漂移。
  async function speakCore(messages, kind, { onReasoning, onRestart } = {}) {
    const agent = decodeAgent(messages);
    calls[kind].push({ agent, messages });
    await passGate();
    if (speakThrows.has('all') || speakThrows.has(agent.name)) throw new Error('发言模拟失败');
    // reasonings 脚本：把一段思考拆成多个增量回调，模拟真实流式输出
    const deltas = reasonings.get(agent.name);
    if (deltas) {
      for (const delta of deltas) {
        onReasoning?.(delta);
        await new Promise((r) => setImmediate(r));
      }
    }
    if (streamRestarts.has(agent.name)) onRestart?.();
    const scripted = lookup(speeches, agent);
    if (scripted) return scripted;
    // 默认发言复述提示词里最后一条历史，用于验证"共享聊天记录"确实下发了
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lastLine = user.split('\n').filter((l) => l.includes(':')).pop() ?? '';
    return JSON.stringify({ content: `${agent.name}接话：${lastLine}`, next: null });
  }

  return {
    calls,
    async decide(messages) {
      const agent = decodeAgent(messages);
      calls.decide.push({ agent, messages });
      await passGate();
      if (decideThrows.has('all') || decideThrows.has(agent.name)) throw new Error('决策模拟失败');
      const d = lookup(decisions, agent) ?? { want: true, urge: 8 };
      return JSON.stringify({ want: d.want, urge: d.urge, reason: d.reason ?? '测试理由' });
    },
    // 流式发言替身：默认直接复用 speak 的脚本（不产生思考增量），
    // 配置 reasonings 后按脚本分段回调 onReasoning，用于验证事件透出与清理。
    async speakStream(messages, { onReasoning, onRestart } = {}) {
      return speakCore(messages, 'speakStream', { onReasoning, onRestart });
    },
    async summarize(messages) {
      calls.summarize.push({ messages });
      await passGate();
      const scripted = summaries.get('all') ?? summaries.get('default');
      if (typeof scripted === 'function') return scripted(messages);
      if (scripted) return scripted;
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const lines = user.split('\n').filter((l) => l.includes(':'));
      return `共 ${lines.length} 条发言的总结：${lines.map((l) => l.split(':')[0]).join('、')} 参与了讨论。`;
    },
    async speak(messages) {
      return speakCore(messages, 'speak');
    },
  };
}

// 从系统提示词反解当前 Agent（测试替身专用，仅依赖人设渲染格式）
function decodeAgent(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const m = system.match(/成员：(.+?)（(.+?)）/);
  return { name: m?.[1] ?? '未知', title: m?.[2] ?? '' };
}

export function createGate() {
  let resolveGate;
  const promise = new Promise((resolve) => {
    resolveGate = resolve;
  });
  return { promise, remaining: 1, release: () => resolveGate() };
}
