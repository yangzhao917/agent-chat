// 持久化：JSONL 追加式日志。选型理由见 docs/plan.md §2——
// 单进程服务器 + 只追加消息流，规范化的事实来源本身就是日志，
// 不引入外部数据库服务（不假定本机端口或容器存在）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createRoomStore({ dataDir, roomId }) {
  const file = join(dataDir, 'rooms', `${roomId}.jsonl`);

  function ensureDir() {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    file,

    append(message) {
      ensureDir();
      appendFileSync(file, `${JSON.stringify(message)}\n`);
    },

    load() {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null; // 容忍半行损坏：跳过而非让整个历史不可读
          }
        })
        .filter(Boolean);
    },

    reset() {
      ensureDir();
      writeFileSync(file, '');
    },
  };
}
