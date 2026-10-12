// 配置单一来源：环境变量优先，.env 兜底，内置面向本机 StepFun 接口的默认值。
// 不引入第三方依赖：.env 解析只支持 KEY=VALUE 与 # 注释，够用即可。
import { readFileSync } from 'node:fs';

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function loadDotEnv(path = '.env') {
  try {
    return parseDotEnv(readFileSync(path, 'utf8'));
  } catch {
    return {}; // 没有 .env 是正常情况
  }
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const dotenv = loadDotEnv();
  const get = (key) => env[key] ?? dotenv[key];
  // STEP_API_KEY 兜底：本机环境已配置 StepFun 时无需额外设置 LLM_API_KEY
  const apiKey = get('LLM_API_KEY') || env.STEP_API_KEY || '';
  return {
    port: int(get('PORT'), 3210),
    llm: {
      baseUrl: (get('LLM_BASE_URL') || 'https://api.stepfun.com/step_plan/v1').replace(/\/+$/, ''),
      apiKey,
      speakModel: get('LLM_MODEL') || 'step-5-preview',
      decisionModel: get('LLM_DECISION_MODEL') || 'step-3.5-flash',
      speakMaxTokens: int(get('LLM_SPEAK_MAX_TOKENS'), 3000),
      decisionMaxTokens: int(get('LLM_DECISION_MAX_TOKENS'), 2000),
      summaryMaxTokens: int(get('LLM_SUMMARY_MAX_TOKENS'), 3000),
      timeoutMs: int(get('LLM_TIMEOUT_MS'), 60000),
      maxRetries: int(get('LLM_MAX_RETRIES'), 2),
      // 上游并发上限（StepFun 为 8），超发会得到 429；保守取 6 留余量
      maxConcurrent: int(get('LLM_MAX_CONCURRENCY'), 6),
    },
    scheduling: {
      // 0 = 不设上限（默认无限额度：一轮持续到无人想发言或暂停）
      maxAgentMessagesPerTurn: int(get('MAX_AGENT_MESSAGES_PER_TURN'), 0),
      urgeThreshold: int(get('URGE_THRESHOLD'), 4),
      maxPerAgentPerTurn: int(get('MAX_PER_AGENT_PER_TURN'), 0),
      messageDelayMs: int(get('MESSAGE_DELAY_MS'), 900),
    },
    history: {
      max: int(get('MAX_HISTORY'), 30),
      decisionWindow: int(get('DECISION_HISTORY'), 16),
    },
    dataDir: get('DATA_DIR') || './data',
    roomTitle: get('ROOM_TITLE') || '深夜茶馆 · 十人局',
    hostName: get('HOST_NAME') || '主持人',
  };
}
