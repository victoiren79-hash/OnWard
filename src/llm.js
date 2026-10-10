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
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const REQUEST_TIMEOUT_MS = 30_000;

const client = axios.create({
  baseURL: GROQ_BASE_URL,
  headers: {
    Authorization: `Bearer ${GROQ_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: REQUEST_TIMEOUT_MS,
});

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

  const baseMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const first = await requestCompletion({
    model,
    temperature,
    messages: baseMessages,
    maxTokens: opts.maxTokens,
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
  });

  const secondParsed = tryParseJson(second.content);
  if (secondParsed.ok) return secondParsed.value;

  const err = new Error(
    '[onward/llm] Groq returned malformed JSON twice in a row. ' +
      `First: ${truncate(first.content, 400)} | ` +
      `Second: ${truncate(second.content, 400)}`
  );
  err.code = 'LLM_MALFORMED_JSON';
  throw err;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function requestCompletion({ model, temperature, messages, maxTokens }) {
  const body = {
    model,
    messages,
    temperature,
    response_format: { type: 'json_object' },
  };
  // Groq prefers max_completion_tokens (OpenAI-compatible).
  if (typeof maxTokens === 'number') body.max_completion_tokens = maxTokens;

  let response;
  try {
    response = await client.post('/chat/completions', body);
  } catch (err) {
    throw normalizeAxiosError(err);
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
  const context = status ? `HTTP ${status}` : err.code || 'no-status';

  const wrapped = new Error(
    `[onward/llm] Groq request failed (${context}): ${apiMessage ?? err.message}`
  );
  wrapped.code = 'LLM_REQUEST_FAILED';
  wrapped.status = status ?? null;
  wrapped.cause = err;
  return wrapped;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}







/**
 * Plain-text variant of callLLM. Same transport, no JSON mode, no parsing.
 * Returns the raw string content.
 */
export async function callLLMText(systemPrompt, userMessage, opts = {}) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('[onward/llm] callLLMText: systemPrompt must be a non-empty string');
  }
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('[onward/llm] callLLMText: userMessage must be a non-empty string');
  }

  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: opts.temperature ?? 0.3,
  };
  if (typeof opts.maxTokens === 'number') body.max_completion_tokens = opts.maxTokens;

  let response;
  try {
    response = await client.post('/chat/completions', body);
  } catch (err) {
    throw normalizeAxiosError(err);
  }

  const content = response?.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('[onward/llm] callLLMText: Groq returned no usable text');
  }
  return content.trim();
}