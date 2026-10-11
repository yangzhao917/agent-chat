// LLM 适配层：只依赖 OpenAI 兼容的 /chat/completions 协议，
// 对上层暴露 decide（轻量决策）与 speak（人设发言）两个用例。
// fetch 与 sleep 均可注入，测试用假实现替换，不发真实请求。

export class LlmError extends Error {
  constructor(message, { status = 0, retriable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retriable = retriable;
  }
}

const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function createLlmClient({
  baseUrl,
  apiKey,
  speakModel,
  decisionModel,
  speakMaxTokens = 3000,
  decisionMaxTokens = 2000,
  timeoutMs = 60000,
  maxRetries = 2,
  maxConcurrent = 6,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!baseUrl) throw new Error('LLM_BASE_URL 未配置');
  if (!apiKey) throw new Error('LLM_API_KEY 未配置（可复用环境变量 STEP_API_KEY）');

  // 并发闸门：上游（如 StepFun）有并发上限，超发直接 429。
  // 10 个 Agent 的并行决策必须排队通过，否则整轮决策都会失败。
  let inFlight = 0;
  const waiters = [];
  async function acquire() {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    inFlight += 1;
  }
  function release() {
    inFlight -= 1;
    waiters.shift()?.();
  }

  async function chat({ model, messages, temperature, maxTokens }) {
    let lastError;
    await acquire();
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new LlmError(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`, {
              status: res.status,
              retriable: RETRIABLE_STATUS.has(res.status),
            });
          }
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) {
            throw new LlmError('LLM 响应缺少 content');
          }
          return content;
        } catch (err) {
          lastError =
            err instanceof LlmError ? err : new LlmError(`LLM 请求失败: ${err.message}`, { retriable: true });
          if (!lastError.retriable || attempt === maxRetries) break;
          await sleep(300 * 2 ** attempt); // 指数退避，上限 maxRetries 次
        }
      }
      throw lastError;
    } finally {
      release();
    }
  }

  return {
    // 决策用轻量模型 + 低温度：追求快、便宜、格式稳定。
    // 注意：推理型模型的推理 token 同样占用 max_tokens，配额给太小会导致
    // content 为空（finish_reason=length），这是实测踩过的坑，勿改回小值。
    decide(messages) {
      return chat({ model: decisionModel, messages, temperature: 0.3, maxTokens: decisionMaxTokens });
    },
    // 发言用主模型 + 高温度：追求人设差异与多样性，同样要为推理 token 留足配额
    speak(messages) {
      return chat({ model: speakModel, messages, temperature: 0.9, maxTokens: speakMaxTokens });
    },
  };
}
