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
      <div class="avatar" style="background:${a.color}">${esc(a.name[0])}<span class="dot" hidden></span></div>
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
  } else if (state.status === 'discussing') {
    el.textContent = '讨论中';
    el.className = 'status discussing';
  } else {
    el.textContent = '待机';
    el.className = 'status idle';
  }
  $('btn-pause').textContent = state.paused ? '继续' : '暂停';
}

function appendMessage(message) {
  const li = document.createElement('li');
  li.className = `msg ${message.kind === 'human' ? 'host' : 'agent'}`;
  const meta = agentMeta.get(message.speakerId);
  const color = message.kind === 'human' ? '#7ee2a8' : (meta?.color ?? '#8b93a7');
  const title = message.kind === 'human' ? '主持人' : (meta?.title ?? '');
  li.innerHTML = `
    <div class="avatar" style="background:${color}">${esc(message.speakerName[0])}</div>
    <div>
      <div class="meta"><span class="name">${esc(message.speakerName)}</span><span>${esc(title)}</span><span>${new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></div>
      <div class="bubble">${renderContent(message.content)}</div>
    </div>`;
  messagesEl.appendChild(li);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleEvent(event) {
  switch (event.type) {
    case 'hello':
    case 'room_state':
      renderAgentRoster(event.payload.agents);
      if (event.payload.messages) {
        messagesEl.innerHTML = '';
        for (const m of event.payload.messages) appendMessage(m);
      }
      setRoomStatus(event.payload);
      break;
    case 'message':
      appendMessage(event.payload);
      break;
    case 'agent_status':
      if (event.payload.phase === 'deciding' || event.payload.phase === 'decided') {
        for (const id of event.payload.agentIds ?? []) setAgentStatus(id, event.payload.phase === 'deciding' ? 'thinking' : 'idle');
      } else {
        setAgentStatus(event.payload.agentId, event.payload.status ?? 'idle');
      }
      break;
    case 'turn_start':
    case 'turn_restart':
      setRoomStatus({ status: 'discussing', paused: false });
      break;
    case 'turn_end':
      setRoomStatus({ status: 'idle', paused: false, turnBudget: 0 });
      for (const [id] of agentEls) setAgentStatus(id, 'idle');
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
  post('/api/messages', { text: '大家自由聊聊吧，什么话题都行。' }).catch((err) => alert(err.message));
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
for (const type of ['hello', 'room_state', 'message', 'agent_status', 'turn_start', 'turn_restart', 'turn_end', 'history_cleared', 'error']) {
  es.addEventListener(type, (e) => handleEvent({ type, payload: JSON.parse(e.data).payload }));
}
// SSE 默认事件名是 message，上面已显式订阅命名事件；服务端统一发命名事件
es.onerror = () => setRoomStatus({ status: 'idle', paused: false, turnBudget: 0 });
