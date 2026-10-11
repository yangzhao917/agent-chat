// 应用服务：把领域规则（room/speaking/prompt）与 LLM 适配器编排成用例。
// 这是唯一知道"回合循环"的地方；领域层不知道 LLM，LLM 层不知道房间。
import { createMessage } from '../domain/message.js';
import { rosterSummary } from '../domain/agent.js';
import { parseDecision, parseSpeech, selectNextSpeaker } from '../domain/speaking.js';
import { buildDecisionMessages, buildSpeechMessages } from '../domain/prompt.js';

const MAX_CONSECUTIVE_SPEECH_FAILURES = 3;

export function createChatService({
  room,
  llm,
  store = null,
  scheduling,
  history,
  logger = console,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const listeners = new Set();
  // 回合串行化：同一房间同时只推进一轮，后到的触发排队；
  // turnRequested 用于合并重复触发——进行中的回合会自行消费人类插话，
  // 排队中的那次触发随即作废，避免一条插话引发两轮讨论。
  let turnChain = Promise.resolve();
  let turnRequested = false;

  function emit(type, payload) {
    const event = { type, payload, at: Date.now() };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error('事件监听器异常:', err);
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function persist(message) {
    if (store) store.append(message);
  }

  // 人类（主持人）发言：立即进入共享历史，并作为新一轮的起点。
  function postHostMessage(text) {
    const message = createMessage({
      speakerId: 'host',
      speakerName: room.hostName,
      kind: 'human',
      content: text,
    });
    room.appendMessage(message);
    persist(message);
    emit('message', message);
    // 无论当前是否正在回合中，都重置预算：人类的话是新一轮对话的锚点。
    // 正在进行的回合会在下一个决策检查点消费该标记并基于新上下文重新评估。
    room.resetTurn();
    room.requestHostInterject();
    scheduleTurn('host-message');
    return message;
  }

  function scheduleTurn(reason) {
    turnRequested = true;
    turnChain = turnChain
      .then(async () => {
        if (!turnRequested) return; // 已被进行中的回合消费
        turnRequested = false;
        await runTurn(reason);
      })
      .catch((err) => {
        logger.error('回合异常中断:', err);
        emit('error', { message: `回合异常中断: ${err.message}` });
      });
    return turnChain;
  }

  async function runTurn(reason) {
    if (room.paused || room.status === 'discussing') return;
    room.setStatus('discussing');
    emit('turn_start', { reason, budget: room.turnBudget });
    let stopReason = 'idle';
    let consecutiveFailures = 0;

    try {
      // 先检查插话再检查预算：人类在预算耗尽的瞬间发言也必须被响应
      for (;;) {
        if (room.paused) break;
        if (room.consumeHostInterject()) {
          room.resetTurn();
          turnRequested = false; // 本回合已接管，排队中的触发作废
          emit('turn_restart', { reason: 'host-interject', budget: room.turnBudget });
        }
        if (room.turnBudget <= 0) {
          stopReason = 'budget';
          break;
        }

        const candidates = room.eligibleAgents();
        if (!candidates.length) {
          stopReason = 'no-candidate';
          break;
        }

        const decisions = await gatherDecisions(candidates);
        const lastAgentMessage = room.lastMessage?.kind === 'agent' ? room.lastMessage : null;
        const pickId = selectNextSpeaker({
          candidates,
          decisions,
          nomination: lastAgentMessage?.meta?.next ?? null,
          urgeThreshold: scheduling.urgeThreshold,
        });
        if (!pickId) {
          stopReason = 'idle';
          break;
        }

        const agent = room.getAgent(pickId);
        try {
          await speakAs(agent);
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures += 1;
          logger.warn(`Agent「${agent.name}」发言失败:`, err.message);
          room.markSpoke(agent.id); // 失败也占额度，避免反复选中同一失灵者
          emit('agent_status', { agentId: agent.id, status: 'idle' });
          if (consecutiveFailures >= MAX_CONSECUTIVE_SPEECH_FAILURES) {
            stopReason = 'error';
            emit('error', { message: `连续 ${consecutiveFailures} 次发言失败，本轮结束` });
            break;
          }
        }

        if (scheduling.messageDelayMs > 0) await sleep(scheduling.messageDelayMs);
      }
    } finally {
      room.setStatus('idle');
      emit('turn_end', { reason: stopReason, budget: room.turnBudget });
    }
  }

  // 决策回合：并行询问所有候选者，单个失败按沉默处理，不阻塞其他人。
  async function gatherDecisions(candidates) {
    const context = room.messages.slice(-history.decisionWindow);
    const roster = rosterSummary(room.agents);
    const recentSpeakers = [...new Set(room.messages.slice(-6).map((m) => m.speakerName))];
    emit('agent_status', { phase: 'deciding', agentIds: candidates.map((a) => a.id) });

    const entries = await Promise.all(
      candidates.map(async (agent) => {
        try {
          const raw = await llm.decide(buildDecisionMessages({ agent, history: context, roster, recentSpeakers }));
          const decision = parseDecision(raw);
          if (!decision) throw new Error('决策输出无法解析');
          return [agent.id, decision];
        } catch (err) {
          logger.warn(`Agent「${agent.name}」决策失败，本轮沉默:`, err.message);
          return [agent.id, { want: false, urge: 0, reason: '决策失败，保持沉默' }];
        }
      }),
    );
    emit('agent_status', { phase: 'decided', agentIds: candidates.map((a) => a.id) });
    return new Map(entries);
  }

  async function speakAs(agent) {
    emit('agent_status', { agentId: agent.id, status: 'speaking' });
    try {
      const context = room.messages.slice(-history.max);
      const raw = await llm.speak(buildSpeechMessages({ agent, history: context, roster: rosterSummary(room.agents) }));
      const parsed = parseSpeech(raw, { roster: room.agents });
      if (!parsed) throw new Error('发言输出无法解析');
      const message = createMessage({
        speakerId: agent.id,
        speakerName: agent.name,
        kind: 'agent',
        content: parsed.content,
        meta: { next: parsed.next, degraded: parsed.degraded },
      });
      room.appendMessage(message);
      persist(message);
      room.markSpoke(agent.id);
      emit('message', message);
      return message;
    } finally {
      emit('agent_status', { agentId: agent.id, status: 'idle' });
    }
  }

  function setPaused(paused) {
    room.setPaused(paused);
    emit('room_state', room.snapshot());
    // 已暂停的回合在恢复后会自行继续，只有真正停着的房间才需要重新调度
    if (!paused && room.status !== 'discussing') scheduleTurn('resume');
  }

  function clearHistory() {
    room.clear();
    if (store) store.reset();
    emit('room_state', room.snapshot());
    emit('history_cleared', {});
  }

  return {
    room,
    subscribe,
    postHostMessage,
    setPaused,
    clearHistory,
    // 供启动恢复历史后手动触发一轮（无新人类消息）
    nudge(text) {
      return postHostMessage(text);
    },
    get state() {
      return { ...room.snapshot(), messages: room.messages };
    },
  };
}
