// 前端只做渲染与转发：所有规则都在服务端，这里不实现任何调度逻辑。
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const agentsEl = $('agents');

const agentEls = new Map(); // agentId -> { li, dot }
let agentMeta = new Map(); // agentId -> { name, title, color }

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 把 @名字 高亮为可点击的提及
function renderContent(text) {
  return esc(text).replace(/@([\u4e00-\u9fa5A-Za-z]{2,4})/g, '<span class="mention">@$1</span>');
}

function renderAgentRoster(agents) {
  agentsEl.innerHTML = '';
  agentEls.clear();
  for (const a of agents) {
    agentMeta.set(a.id, a);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="avatar" style="background:${a.color};--lantern:${a.color}">${esc(a.name[0])}<span class="dot" hidden></span></div>
      <div><div class="who">${esc(a.name)}</div><div class="what">${esc(a.title)}</div></div>`;
    agentsEl.appendChild(li);
    agentEls.set(a.id, { li, dot: li.querySelector('.dot') });
  }
  $('agent-count').textContent = `（${agents.length} 人）`;
}

function setAgentStatus(agentId, mode) {
  const entry = agentEls.get(agentId);
  if (!entry) return;
  entry.li.classList.toggle('active', mode !== 'idle');
  entry.dot.hidden = mode === 'idle';
  entry.dot.className = `dot ${mode === 'speaking' ? 'speaking-dot' : 'thinking'}`;
}

function setRoomStatus(state) {
  const el = $('room-status');
  if (state.paused) {
    el.textContent = '已暂停';
    el.className = 'status paused';
    el.hidden = false;
  } else if (state.status === 'discussing') {
    el.textContent = '讨论中';
    el.className = 'status discussing';
    el.hidden = false;
  } else {
    // 已去掉待机状态：房间只会有"讨论中/已暂停"两种可见状态，其余情况不展示徽标
    el.hidden = true;
  }
  $('btn-pause').textContent = state.paused ? '继续' : '暂停';
}

function appendMessage(message) {
  const li = document.createElement('li');
  const isSummary = message.meta?.summary === true;
  li.className = `msg ${isSummary ? 'summary' : message.kind === 'human' ? 'host' : 'agent'}`;
  const meta = agentMeta.get(message.speakerId);
  const color = message.kind === 'human' ? '#7ee2a8' : isSummary ? 'rgba(232,150,60,0.22)' : (meta?.color ?? '#8b93a7');
  const title = message.kind === 'human' ? '主持人' : isSummary ? '由本房讨论生成' : (meta?.title ?? '');
  const avatar = isSummary ? '📌' : esc(message.speakerName[0]);
  li.innerHTML = `
    <div class="avatar" style="background:${color};--lantern:${color}">${avatar}</div>
    <div>
      <div class="meta"><span class="name">${esc(message.speakerName)}</span><span>${esc(title)}</span><span>${new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></div>
      <div class="bubble">${isSummary ? esc(message.content) : renderContent(message.content)}</div>
    </div>`;
  clearReasoning(); // 正式消息到达，思考气泡让位
  messagesEl.appendChild(li);
  scrollToBottom();
}

// 思考气泡：Agent 开口前的推理过程，实时滚动显示。
// 它只是观感附属物——不落盘、不入历史、不进任何 Agent 的上下文，
// 正式消息（message 事件）到达时必须被替换掉，不能残留半段思考冒充发言。
let reasoningEl = null;
let reasoningAgentId = null;

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearReasoning() {
  reasoningEl?.remove();
  reasoningEl = null;
  reasoningAgentId = null;
}

function reasoningBubble(agentId) {
  if (reasoningEl && reasoningAgentId === agentId) return reasoningEl;
  clearReasoning();
  const meta = agentMeta.get(agentId);
  const color = meta?.color ?? '#8b93a7';
  const li = document.createElement('li');
  li.className = 'msg agent reasoning';
  li.innerHTML = `
    <div class="avatar" style="background:${color};--lantern:${color}">${esc(meta?.name?.[0] ?? '?')}</div>
    <div>
      <div class="meta"><span class="name">${esc(meta?.name ?? '')}</span><span>思考中…</span></div>
      <div class="bubble"><span class="reason-text"></span><span class="caret"></span></div>
    </div>`;
  messagesEl.appendChild(li);
  reasoningEl = li;
  reasoningAgentId = agentId;
  scrollToBottom();
  return li;
}

// 讨论结束后才显示"总结讨论"：有 Agent 发言且当前没有回合在进行
function refreshSummaryButton(state) {
  const hasDiscussion = (state.messages ?? []).some((m) => m.kind === 'agent');
  const btn = $('btn-summary');
  btn.hidden = !(hasDiscussion && state.status !== 'discussing' && !state.paused);
  if (btn.dataset.busy === '1') btn.textContent = '总结生成中…';
  else btn.textContent = '总结讨论';
}

let lastState = { messages: [], status: 'idle', paused: false };

function handleEvent(event) {
  switch (event.type) {
    case 'hello':
    case 'room_state':
      renderAgentRoster(event.payload.agents);
      if (event.payload.messages) {
        messagesEl.innerHTML = '';
        clearReasoning();
        for (const m of event.payload.messages) appendMessage(m);
      }
      lastState = event.payload;
      setRoomStatus(event.payload);
      refreshSummaryButton(event.payload);
      break;
    case 'message':
      appendMessage(event.payload);
      refreshSummaryButton({ messages: [...(lastState.messages ?? []), event.payload], status: lastState.status, paused: lastState.paused });
      break;
    case 'agent_reasoning': {
      const { agentId, delta, reset } = event.payload;
      // reset：LLM 配额扩容后重试，已显示的半段思考作废，避免两段被拼成一段
      if (reset) {
        clearReasoning();
        break;
      }
      reasoningBubble(agentId).querySelector('.reason-text').textContent += delta;
      scrollToBottom();
      break;
    }
    case 'agent_status':
      if (event.payload.phase === 'deciding' || event.payload.phase === 'decided') {
        for (const id of event.payload.agentIds ?? []) setAgentStatus(id, event.payload.phase === 'deciding' ? 'thinking' : 'idle');
      } else {
        setAgentStatus(event.payload.agentId, event.payload.status ?? 'idle');
        // 发言结束（含失败）都会回到 idle：此时若还挂着思考气泡，说明没有正式消息来接棒，
        // 必须清掉，否则失败 Agent 的半段思考会一直冒充"还在想"。
        if (event.payload.status === 'idle') clearReasoning();
      }
      break;
    case 'turn_start':
      setRoomStatus({ status: 'discussing', paused: false });
      break;
    case 'turn_restart':
      // 人类插话重开一轮：在途发言会被丢弃，思考气泡没有对应的正式消息，必须清掉
      setRoomStatus({ status: 'discussing', paused: false });
      clearReasoning();
      break;
    case 'turn_end':
      // paused 以服务端为准：暂停中的回合结束时仍是"已暂停"，不能翻成"待机"
      setRoomStatus({ status: 'idle', paused: event.payload.paused ?? false });
      for (const [id] of agentEls) setAgentStatus(id, 'idle');
      clearReasoning();
      break;
    case 'error':
      console.error(event.payload.message);
      break;
    default:
      break;
  }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  post('/api/messages', { text }).catch((err) => alert(err.message));
});

$('btn-nudge').addEventListener('click', () => {
  // mode=free：自由讨论不要求引用来源
  post('/api/messages', { text: '大家自由聊聊吧，什么话题都行。', mode: 'free' }).catch((err) => alert(err.message));
});

$('btn-summary').addEventListener('click', async () => {
  const btn = $('btn-summary');
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.textContent = '总结生成中…';
  try {
    await post('/api/summary');
    // 总结通过 SSE 的 message 事件追加，这里只需收起按钮
    btn.hidden = true;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.dataset.busy = '';
    btn.disabled = false;
  }
});

$('btn-pause').addEventListener('click', async () => {
  const paused = $('btn-pause').textContent === '暂停';
  await post('/api/pause', { paused });
});

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('确定清空全部聊天记录？')) return;
  await post('/api/reset');
  messagesEl.innerHTML = '';
});

const es = new EventSource('/api/events');
for (const type of ['hello', 'room_state', 'message', 'agent_status', 'agent_reasoning', 'turn_start', 'turn_restart', 'turn_end', 'history_cleared', 'error']) {
  es.addEventListener(type, (e) => handleEvent({ type, payload: JSON.parse(e.data).payload }));
}
// SSE 默认事件名是 message，上面已显式订阅命名事件；服务端统一发命名事件
es.onerror = () => setRoomStatus({ status: 'idle', paused: false, turnBudget: 0 });
