// 启动入口：装配配置 → 恢复历史 → 建房间 → 起 HTTP 服务。
import { loadConfig } from '../config.js';
import { createDefaultRoster } from '../domain/personas.js';
import { createRoom } from '../domain/room.js';
import { createLlmClient } from '../llm/client.js';
import { createRoomStore } from '../store/roomStore.js';
import { createChatService } from '../app/chatService.js';
import { createHttpServer } from './httpServer.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const config = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

const roomId = 'main';
const store = createRoomStore({ dataDir: config.dataDir, roomId });
const room = createRoom({
  id: roomId,
  title: config.roomTitle,
  hostName: config.hostName,
  agents: createDefaultRoster(),
  scheduling: config.scheduling,
});

// 重启恢复：历史消息即事实来源，直接回放
for (const message of store.load()) room.appendMessage(message);

const llm = createLlmClient({ ...config.llm });
const service = createChatService({ room, llm, store, scheduling: config.scheduling, history: config.history });

const http = createHttpServer({ service, publicDir });
await http.listen(config.port);
console.log(`[agent-chat] 房间「${room.title}」已就绪，10 位成员在线`);
console.log(`[agent-chat] 打开 http://localhost:${config.port}`);
console.log(`[agent-chat] LLM: ${config.llm.baseUrl} (speak=${config.llm.model}, decide=${config.llm.decisionModel})`);
console.log(`[agent-chat] 已恢复 ${room.messages.length} 条历史消息`);
