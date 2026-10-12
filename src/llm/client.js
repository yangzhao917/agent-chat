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
// 推理型模型的推理 token 也占用 max_tokens：配额被推理吃满时 content 为空
// （finish_reason=length）。此时成倍扩容重试，而不是把失败抛给上层。
const MAX_ESCALATED_TOKENS = 16000;
const MAX_ESCALATIONS = 2;

export function createLlmClient({
  baseUrl,
  apiKey,
  speakModel,
  decisionModel,
  speakMaxTokens = 3000,
  decisionMaxTokens = 2000,
  summaryMaxTokens = 3000,
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

  // 单次请求（含配额扩容）：推理 token 吃满 max_tokens 时 content 为空或被截断，
  // 此时按 4 倍扩容重试，最多 MAX_ESCALATIONS 次。
  async function requestOnce(model, messages, temperature, maxTokens) {
    let budget = maxTokens;
    for (let escalation = 0; ; escalation += 1) {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: budget }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LlmError(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`, {
          status: res.status,
          retriable: RETRIABLE_STATUS.has(res.status),
        });
      }
      const choice = (await res.json())?.choices?.[0];
      const content = choice?.message?.content;
      const truncated = choice?.finish_reason === 'length';
      if (typeof content === 'string' && content.trim() && !truncated) return content;
      if (truncated && escalation < MAX_ESCALATIONS && budget < MAX_ESCALATED_TOKENS) {
        budget = Math.min(MAX_ESCALATED_TOKENS, budget * 4);
        continue;
      }
      throw new LlmError(
        truncated ? 'LLM 响应因 max_tokens 不足被截断，扩容后仍失败' : 'LLM 响应缺少 content',
      );
    }
  }

  // 流式请求：推理型模型先吐 reasoning_content、很久之后才吐正文，
  // 把推理增量实时透出，前端才能在正文生成前就有东西可看（缩短"盯着转圈"的感知等待）。
  // 返回的仍是完整正文字符串，入库与持久化路径完全不变。
  async function requestStream(model, messages, temperature, maxTokens, { onReasoning, onRestart } = {}) {
    let budget = maxTokens;
    for (let escalation = 0; ; escalation += 1) {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: budget, stream: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LlmError(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`, {
          status: res.status,
          retriable: RETRIABLE_STATUS.has(res.status),
        });
      }
      if (!res.body) throw new LlmError('LLM 流式响应缺少 body');

      let content = '';
      let truncated = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 以空行分帧、以 "data:" 承载负载；按行切分足够，跨包的残行留在 buffer 里
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // 心跳或分片残缺，跳过
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning_content) onReasoning?.(delta.reasoning_content);
          if (delta?.content) content += delta.content;
          if (chunk.choices?.[0]?.finish_reason === 'length') truncated = true;
        }
      }
      if (content.trim() && !truncated) return content;
      if (truncated && escalation < MAX_ESCALATIONS && budget < MAX_ESCALATED_TOKENS) {
        budget = Math.min(MAX_ESCALATED_TOKENS, budget * 4);
        // 扩容后重试会重新产出一份思考：通知上层丢弃已展示的半段，避免两段思考被拼成一段
        onRestart?.();
        continue;
      }
      throw new LlmError(
        truncated ? 'LLM 响应因 max_tokens 不足被截断，扩容后仍失败' : 'LLM 响应缺少 content',
      );
    }
  }

  // 并发闸门 + 指数退避重试的外壳：同步与流式两条路径共用同一套失败语义
  async function withRetry(request) {
    let lastError;
    await acquire();
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await request();
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

  function chat({ model, messages, temperature, maxTokens }) {
    return withRetry(() => requestOnce(model, messages, temperature, maxTokens));
  }

  function chatStream({ model, messages, temperature, maxTokens, onReasoning, onRestart }) {
    return withRetry(() => requestStream(model, messages, temperature, maxTokens, { onReasoning, onRestart }));
  }

  return {
    // 决策用轻量模型 + 低温度：追求快、便宜、格式稳定。
    // 注意：推理型模型的推理 token 同样占用 max_tokens，配额太小会被推理吃满；
    // 客户端会按 4 倍自动扩容重试，但初始值也不要离合理范围太远。
    decide(messages) {
      return chat({ model: decisionModel, messages, temperature: 0.3, maxTokens: decisionMaxTokens });
    },
    // 发言用主模型 + 高温度：追求人设差异与多样性，同样要为推理 token 留足配额
    speak(messages) {
      return chat({ model: speakModel, messages, temperature: 0.9, maxTokens: speakMaxTokens });
    },
    // 流式发言：推理增量通过 onReasoning 实时流出，返回值与 speak 完全一致
    speakStream(messages, { onReasoning, onRestart } = {}) {
      return chatStream({
        model: speakModel,
        messages,
        temperature: 0.9,
        maxTokens: speakMaxTokens,
        onReasoning,
        onRestart,
      });
    },
    // 总结用主模型 + 低温度：追求忠实压缩，不追求创造性
    summarize(messages) {
      return chat({ model: speakModel, messages, temperature: 0.3, maxTokens: summaryMaxTokens });
    },
  };
}
