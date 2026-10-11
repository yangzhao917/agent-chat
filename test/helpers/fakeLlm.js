// 测试替身：按 Agent 姓名脚本化决策/发言，可注入失败与门控（用于中途插话场景）。
export function createFakeLlm({ decisions = new Map(), speeches = new Map(), decideThrows = new Set(), speakThrows = new Set(), gate = null } = {}) {
  const calls = { decide: [], speak: [] };

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
    async speak(messages) {
      const agent = decodeAgent(messages);
      calls.speak.push({ agent, messages });
      await passGate();
      if (speakThrows.has('all') || speakThrows.has(agent.name)) throw new Error('发言模拟失败');
      const scripted = lookup(speeches, agent);
      if (scripted) return scripted;
      // 默认发言复述提示词里最后一条历史，用于验证"共享聊天记录"确实下发了
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const lastLine = user.split('\n').filter((l) => l.includes(':')).pop() ?? '';
      return JSON.stringify({ content: `${agent.name}接话：${lastLine}`, next: null });
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
