// Onward — Groq API client.
// Endpoint: https://api.groq.com/openai/v1
// Model default: openai/gpt-oss-120b
//
// This is the ONLY module that talks to the LLM provider.
// Callers get a parsed JSON object or a thrown Error — never a raw string.

import 'dotenv/config';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { GROQ_API_KEY } = process.env;

if (!GROQ_API_KEY) {
  throw new Error('[onward/llm] Missing GROQ_API_KEY in environment.');
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
export const REQUEST_TIMEOUT_MS = 20_000;

const client = axios.create({
  baseURL: GROQ_BASE_URL,
  headers: {
    Authorization: `Bearer ${GROQ_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: REQUEST_TIMEOUT_MS,
});

// ---------------------------------------------------------------------------
// reasoning_effort support
//
// Some Groq models accept `reasoning_effort` ("low", "medium", "high") and
// some reject it with a 400. The env var GROQ_REASONING_EFFORT turns it on
// for every call in this process; a per-call opts.reasoningEffort overrides
// it for that call. If Groq rejects the field once, we remember that and
// never send it again for the life of the process — a single unsupported
// field must never make every call fail.
// ---------------------------------------------------------------------------

let reasoningEffortSupported = true;

function resolveReasoningEffort(opts) {
  if (!reasoningEffortSupported) return null;
  if (opts && typeof opts.reasoningEffort === 'string' && opts.reasoningEffort.trim()) {
    return opts.reasoningEffort.trim();
  }
  const env = process.env.GROQ_REASONING_EFFORT;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return null;
}

function noteReasoningEffortRejected(err) {
  const status = err?.response?.status;
  if (status !== 400) return false;
  const data = err?.response?.data;
  const text =
    (data && (data.error?.message || data.message || data.error)) ||
    (typeof data === 'string' ? data : '');
  if (typeof text !== 'string') return false;
  if (!text.toLowerCase().includes('reasoning_effort')) return false;
  if (reasoningEffortSupported) {
    console.warn(
      '[onward/llm] Groq rejected reasoning_effort; dropping it for the rest of this process.'
    );
  }
  reasoningEffortSupported = false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function callLLM(systemPrompt, userMessage, opts = {}) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('[onward/llm] callLLM: systemPrompt must be a non-empty string');
  }
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('[onward/llm] callLLM: userMessage must be a non-empty string');
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0;
  const reasoningEffort = resolveReasoningEffort(opts);

  const baseMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const first = await requestCompletion({
    model,
    temperature,
    messages: baseMessages,
    maxTokens: opts.maxTokens,
    reasoningEffort,
  });

  const firstParsed = tryParseJson(first.content);
  if (firstParsed.ok) return firstParsed.value;

  // Retry once with a repair instruction.
  const repairMessages = [
    ...baseMessages,
    { role: 'assistant', content: first.content },
    {
      role: 'user',
      content:
        'Your previous response was not valid JSON. Re-emit ONLY a valid JSON ' +
        'object matching the schema described in the system prompt. No prose, ' +
        'no code fences, no commentary — just the JSON object.',
    },
  ];

  const second = await requestCompletion({
    model,
    temperature,
    messages: repairMessages,
    maxTokens: opts.maxTokens,
    reasoningEffort,
  });

  const secondParsed = tryParseJson(second.content);
  if (secondParsed.ok) return secondParsed.value;

  const err = new Error(
    '[onward/llm] Groq returned malformed JSON twice in a row. ' +
      `First: ${truncate(first.content, 400)} | ` +
      `Second: ${truncate(second.content, 400)}`
  );
  err.code = 'LLM_MALFORMED_JSON';
  err.retryable = true;
  throw err;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function requestCompletion({
  model,
  temperature,
  messages,
  maxTokens,
  reasoningEffort = null,
}) {
  const body = {
    model,
    messages,
    temperature,
    response_format: { type: 'json_object' },
  };
  // Groq prefers max_completion_tokens (OpenAI-compatible).
  if (typeof maxTokens === 'number') body.max_completion_tokens = maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let response;
  try {
    response = await postWithRetry('/chat/completions', body);
  } catch (err) {
    // If the failure was Groq rejecting reasoning_effort, note it, drop
    // the field, and try once more so this call still succeeds.
    if (noteReasoningEffortRejected(err.cause?.response ? err.cause : err.cause ?? err)) {
      delete body.reasoning_effort;
      try {
        response = await postWithRetry('/chat/completions', body);
      } catch (err2) {
        throw normalizeAxiosError(err2.cause ?? err2);
      }
    } else {
      throw err;
    }
  }

  const content = response?.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    const err = new Error(
      '[onward/llm] Groq response missing choices[0].message.content. ' +
        `Raw: ${truncate(JSON.stringify(response?.data), 400)}`
    );
    err.code = 'LLM_BAD_RESPONSE';
    throw err;
  }
  return { content, raw: response.data };
}

// ---------------------------------------------------------------------------
// postWithRetry
//
// One POST with up to 3 attempts total. Retries on 429, 5xx, and the
// common axios timeout / connection-reset codes. Waits 500 ms then
// 1500 ms between attempts. If Groq sends a retry-after header on a 429,
// waits that many seconds instead, capped at 5 s.
//
// Throws normalizeAxiosError(err) on the final failure.
// ---------------------------------------------------------------------------

const RETRYABLE_AXIOS_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
]);

const RETRY_WAITS_MS = [500, 1500];
const RETRY_AFTER_CAP_MS = 5000;

async function postWithRetry(path, body) {
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.post(path, body);
    } catch (err) {
      lastErr = err;

      const status = err?.response?.status;
      const code = err?.code;
      const retryable =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        RETRYABLE_AXIOS_CODES.has(code);

      if (!retryable) break;
      if (attempt === 2) break;

      let waitMs = RETRY_WAITS_MS[attempt] ?? 1500;

      if (status === 429) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
          waitMs = Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
        }
      }

      await sleep(waitMs);
    }
  }

  throw normalizeAxiosError(lastErr);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJson(text) {
  if (typeof text !== 'string') return { ok: false };

  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  try {
    const value = JSON.parse(s);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function normalizeAxiosError(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const apiMessage =
    (data && (data.error?.message || data.message || data.error)) ||
    (typeof data === 'string' ? data : null);
  const context = status ? `HTTP ${status}` : err?.code || 'no-status';

  const wrapped = new Error(
    `[onward/llm] Groq request failed (${context}): ${apiMessage ?? err?.message ?? 'unknown error'}`
  );
  wrapped.code = 'LLM_REQUEST_FAILED';
  wrapped.status = status ?? null;
  wrapped.cause = err;

  // Mark retryable so the orchestrator and the frontend know they can
  // safely resend the same message.
  const code = err?.code;
  if (
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    RETRYABLE_AXIOS_CODES.has(code)
  ) {
    wrapped.retryable = true;
  }

  return wrapped;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// Plain-text variant of callLLM. Same transport, no JSON mode, no parsing.
// Returns the raw string content.
// ---------------------------------------------------------------------------

export async function callLLMText(systemPrompt, userMessage, opts = {}) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('[onward/llm] callLLMText: systemPrompt must be a non-empty string');
  }
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('[onward/llm] callLLMText: userMessage must be a non-empty string');
  }

  const reasoningEffort = resolveReasoningEffort(opts);

  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: opts.temperature ?? 0.3,
  };
  if (typeof opts.maxTokens === 'number') body.max_completion_tokens = opts.maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let response;
  try {
    response = await postWithRetry('/chat/completions', body);
  } catch (err) {
    if (noteReasoningEffortRejected(err.cause ?? err)) {
      delete body.reasoning_effort;
      try {
        response = await postWithRetry('/chat/completions', body);
      } catch (err2) {
        throw normalizeAxiosError(err2.cause ?? err2);
      }
    } else {
      throw err;
    }
  }

  const content = response?.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('[onward/llm] callLLMText: Groq returned no usable text');
  }
  return content.trim();
}