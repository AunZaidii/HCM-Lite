import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

// Any OpenAI-compatible chat-completions endpoint with tool calling (Gemini, Groq, OpenAI...).
// The key never leaves the server.
export async function chatCompletion(args) {
  try {
    return await callModel(env.AI_MODEL, args);
  } catch (err) {
    // Provider overloaded or model unavailable: retry once on the fallback model.
    if (env.AI_FALLBACK_MODEL && err.code === 'AI_PROVIDER_ERROR' && !args.signal?.aborted) return callModel(env.AI_FALLBACK_MODEL, args);
    throw err;
  }
}

async function callModel(model, { messages, tools, json = false, signal }) {
  if (!env.AI_API_KEY) throw new AppError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured (AI_API_KEY missing).');
  const body = { model, messages, temperature: 0.2 };
  if (env.AI_REASONING_EFFORT) body.reasoning_effort = env.AI_REASONING_EFFORT;
  if (tools?.length) body.tools = tools;
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (Array.isArray(data) ? data[0] : data)?.error?.message || `HTTP ${res.status}`;
    throw new AppError(503, 'AI_PROVIDER_ERROR', `AI provider error: ${msg}`);
  }
  return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
}

// Pulls the first JSON object out of a model reply (tolerates ```json fences).
export function extractJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
