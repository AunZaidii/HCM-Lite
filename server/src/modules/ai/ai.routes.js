import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { getSettings } from '../../lib/settings.js';
import { addDays, isoWeekday, todayLocal } from '../../lib/time.js';
import { protect, requireEmployee, requireRole } from '../../middleware/auth.js';
import { h, validate } from '../../middleware/validate.js';
import { adminDashboard, hrDashboard } from '../analytics.service.js';
import { chatCompletion, extractJson } from './provider.js';
import { buildLeaveDraft, toolsFor } from './tools.js';

const router = Router();
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const AI_LABEL = 'AI-generated';

async function log(actor, feature, { input, toolsCalled, output, status, latency, error }) {
  await db.query(
    `insert into ai_logs (user_id, role, feature, input, tools_called, output, status, model, latency_ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor.id, actor.role, feature, String(input ?? '').slice(0, 2000), toolsCalled ? JSON.stringify(toolsCalled) : null,
      output ? String(output).slice(0, 4000) : null, status, env.AI_MODEL, latency ?? null, error ?? null]);
}

// ~20 AI requests per user per hour, counted from ai_logs.
async function aiRateLimit(req, _res, next) {
  try {
    const { n } = await db.one("select count(*)::int as n from ai_logs where user_id = $1 and created_at > now() - interval '1 hour' and status <> 'rate_limited'", [req.user.id]);
    if (n >= env.AI_RATE_LIMIT_PER_HOUR) {
      await log(req.user, req.path.split('/').pop(), { input: '', status: 'rate_limited' });
      throw new AppError(429, 'AI_RATE_LIMIT', `You've reached the hourly AI limit (${env.AI_RATE_LIMIT_PER_HOUR}). Please try again later or use the dashboard.`);
    }
    next();
  } catch (err) {
    next(err);
  }
}

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const isTimeout = (err) => err.name === 'AbortError' || err.name === 'TimeoutError';
const timeoutError = () => new AppError(504, 'AI_TIMEOUT', 'The assistant is taking too long. Please try again or use the dashboard.');

async function systemPrompt(actor) {
  const s = await getSettings();
  const types = await db.query('select name, yearly_quota from leave_types where is_active order by name');
  const today = todayLocal();
  const late = (() => {
    const [hh, mm] = s.officeStart.split(':').map(Number);
    const t = hh * 60 + mm + s.graceMinutes;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  })();
  const weekend = s.weekendDays.map((d) => DAYS[d]).join(' and ');
  const scope = {
    admin: 'Admin: may see all company data.',
    hr: 'HR: may see all employees\' HR data (attendance, leave, payroll summaries). Never reveal an individual\'s salary unless asked by Admin or HR for payroll purposes.',
    employee: 'Employee: may ONLY see their own data. If asked about any other person\'s salary, pay, attendance, leave or personal details, politely refuse with "Sorry, I can only share your own information." and do not call any tool for it.',
  }[actor.role];
  const nextWeek = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).map((d) => `${DAYS[isoWeekday(d)]} ${d}`).join(', ');
  return `You are "HCM Lite Assistant" for ${s.companyName}. Today is ${DAYS[isoWeekday(today)]}, ${today} (Asia/Karachi). The next 7 days are: ${nextWeek}.
The user is ${actor.fullName}, role ${actor.role.toUpperCase()}.

DATA RULES
- Answer questions about company data ONLY by calling the provided tools. Never guess or invent numbers; use exactly the numbers the tools return.
- If a tool returns an error or no data, say so plainly.
- You cannot create, change, approve or submit anything. Tell the user which screen to use. For leave requests you may only prepare a draft with draft_leave_request; the user confirms it in the form.
- "This month" means ${today.slice(0, 7)}-01 to ${today}. Resolve relative dates against today before calling tools.
- Access: ${scope}

POLICY (answer policy questions only from these rules; if the answer is not here, say "I don't know — please ask HR.")
- Office starts ${s.officeStart.slice(0, 5)} with ${s.graceMinutes} minutes grace: check-in after ${late} is late. Weekend: ${weekend}. Office hours end ${s.officeEnd.slice(0, 5)}.
- Half day if worked less than ${Number(s.halfDayHours)} hours. Absent = working day with no attendance and no approved leave. Missing checkout = checked in but never checked out.
- One attendance record per employee per day; the server sets the time. Mistakes are fixed by an attendance correction request that HR approves.
- Leave counts working days only (weekends and public holidays are skipped). Yearly quotas: ${types.map((t) => `${t.name} ${t.yearlyQuota ?? 'unlimited'}`).join(', ') || 'not configured yet'}.
- Overlapping leave or leave above the remaining balance is rejected. Leave needs HR approval. Pending or future approved leave can be cancelled.
- Payroll: gross = 1.5 × basic (HRA 40% of basic + medical 10% of basic). Per-day rate = gross ÷ working days in the month. Deductions = absent days + unpaid leave days + 0.5 × half days${s.latePenaltyEnabled ? ' + late penalty (every 3 lates = 0.5 day)' : ''}. Joiners and leavers are prorated.
- Monthly tax uses the yearly slab on gross × 12: up to 600,000 = 0; 600,000–1,200,000 = 5% of the amount above 600,000; 1,200,000–2,400,000 = 30,000 + 15% above 1,200,000; 2,400,000–3,600,000 = 210,000 + 25% above 2,400,000; above 3,600,000 = 510,000 + 35% above 3,600,000. Monthly tax = yearly tax ÷ 12.
- HR prepares payroll, only Admin finalizes it, and finalized payroll is locked.

STYLE
- Be brief: at most 6 sentences or a short list. Use PKR with thousands separators. Use names, not IDs.
- LANGUAGE: look only at the user's latest message. If it is in English, reply in English. Reply in Roman Urdu (Urdu written
  in Latin letters, e.g. "Aap ki 8 chuttiyan baqi hain") only when that message itself is in Roman Urdu
  (e.g. "meri kitni chuttiyan baqi hain?"). Never use Hindi/Devanagari or Urdu/Arabic script.`;
}

// Roman Urdu = Urdu written in Latin letters. Detected from common words so the reply language is decided
// by the server, not left to the model (small models drift into Hindi/Urdu script otherwise).
const ROMAN_URDU = /\b(hai|hain|mujhe|meri|mera|mere|kitni|kitne|kitna|chutti|chuttiyan|chhutti|aaj|kal|kaun|kya|kyun|nahi|nahin|agle|agla|chahiye|baqi|aur|ki|ka|ke|ko|se|par|wala|wali|tankhwa|haazri|kab|kaise|batao|bataen)\b/gi;
export const isRomanUrdu = (text) => (String(text).match(ROMAN_URDU) || []).length >= 2;

// ---- Chat with tools ----
router.post('/ai/chat', ...protect, aiRateLimit,
  validate({ body: z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(1000) })).min(1).max(10) }) }),
  h(async (req, res) => {
    const actor = req.user;
    const started = Date.now();
    const tools = toolsFor(actor.role);
    const toolsCalled = [];
    let action = null;
    const input = req.body.messages.at(-1).content;
    const language = isRomanUrdu(input) ? 'Roman Urdu (Latin letters only)' : 'English';
    const messages = [
      { role: 'system', content: `${await systemPrompt(actor)}\n- Reply language for this conversation turn: ${language}.` },
      ...req.body.messages,
    ];
    const { signal, done } = withTimeout();
    try {
      let answer = '';
      for (let round = 0; round < 4; round++) {
        const msg = await chatCompletion({ messages, tools: tools.map((t) => t.schema), signal });
        if (!msg.tool_calls?.length) {
          answer = msg.content || '';
          // Some models occasionally return an empty message right after a tool result: ask once for the answer.
          if (!answer && round > 0) {
            messages.push({ role: 'user', content: `Answer my question now using the tool results above. Reply in ${language}.` });
            answer = (await chatCompletion({ messages, signal })).content || '';
          }
          break;
        }
        messages.push(msg);
        for (const call of msg.tool_calls) {
          const tool = tools.find((t) => t.schema.function.name === call.function.name);
          const t0 = Date.now();
          let result;
          try {
            if (!tool) throw new Error(`Tool ${call.function.name} is not available for your role`);
            const args = tool.args.parse(JSON.parse(call.function.arguments || '{}'));
            result = await tool.run(args, actor);
            if (call.function.name === 'draft_leave_request' && result.draft) action = { type: 'OPEN_LEAVE_FORM', draft: result.draft };
          } catch (err) {
            result = { error: err instanceof z.ZodError ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` : err.message };
          }
          toolsCalled.push({ name: call.function.name, args: call.function.arguments, ms: Date.now() - t0, error: result.error });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
      if (!answer) answer = 'Sorry, I could not find an answer. Please try rephrasing or check the dashboard.';
      await log(actor, 'chat', { input, toolsCalled, output: answer, status: 'ok', latency: Date.now() - started });
      res.json({ answer, toolsUsed: [...new Set(toolsCalled.map((t) => t.name))], action, aiGenerated: true, label: AI_LABEL });
    } catch (err) {
      const timeout = isTimeout(err);
      await log(actor, 'chat', { input, toolsCalled, status: timeout ? 'timeout' : 'error', latency: Date.now() - started, error: err.message });
      throw timeout ? timeoutError() : err;
    } finally {
      done();
    }
  }));

// Calls the model for JSON, validates it, retries once, otherwise returns null (caller falls back).
async function jsonWithRetry(messages, schema, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await chatCompletion({ messages, json: true, signal });
    const parsed = schema.safeParse(extractJson(msg.content));
    if (parsed.success) return parsed.data;
    messages = [...messages, { role: 'assistant', content: msg.content || '' }, { role: 'user', content: 'That was not valid. Return valid JSON only, exactly in the requested shape.' }];
  }
  return null;
}

// ---- Dashboard summary: 3-5 bullets using only the KPI JSON for the current filters ----
router.post('/ai/summary', ...protect, requireRole('admin', 'hr'), aiRateLimit,
  validate({ body: z.object({ dashboard: z.enum(['hr', 'admin']), from: z.string().date().optional(), to: z.string().date().optional(), departmentId: z.string().uuid().optional() }) }),
  h(async (req, res) => {
    const b = req.body;
    if (b.dashboard === 'admin' && req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only Admin can summarize the company dashboard');
    const data = b.dashboard === 'admin' ? await adminDashboard(b) : await hrDashboard(b);
    const { auditFeed, attendanceTrend, ...kpis } = data;
    const started = Date.now();
    const { signal, done } = withTimeout();
    try {
      const bullets = await jsonWithRetry([
        { role: 'system', content: 'You are an HR analyst. Using ONLY the numbers in the JSON the user gives you, write 3 to 5 short, useful insight bullets for an HR manager. Do not invent or compute new numbers beyond simple comparisons. If data is empty, say what is missing. Return JSON exactly like {"bullets": ["...", "..."]}.' },
        { role: 'user', content: JSON.stringify(kpis) },
      ], z.object({ bullets: z.array(z.string().min(3).max(300)).min(3).max(5) }), signal);
      await log(req.user, 'summary', { input: b.dashboard, output: bullets ? bullets.bullets.join('\n') : null, status: bullets ? 'ok' : 'invalid_json', latency: Date.now() - started });
      if (!bullets) return res.json({ fallback: true, message: 'Summary unavailable — see the KPIs on the dashboard.' });
      res.json({ bullets: bullets.bullets, aiGenerated: true, label: AI_LABEL });
    } catch (err) {
      await log(req.user, 'summary', { input: b.dashboard, status: isTimeout(err) ? 'timeout' : 'error', latency: Date.now() - started, error: err.message });
      res.json({ fallback: true, message: isTimeout(err) ? 'The summary took too long. See the KPIs on the dashboard.' : 'Summary unavailable right now — see the KPIs on the dashboard.' });
    } finally {
      done();
    }
  }));

// ---- Smart leave: plain words -> validated {type, start, end, reason} -> pre-filled form (never saved) ----
router.post('/ai/smart-leave', ...protect, requireRole('hr', 'employee'), requireEmployee, aiRateLimit,
  validate({ body: z.object({ text: z.string().trim().min(3).max(300) }) }),
  h(async (req, res) => {
    const today = todayLocal();
    const types = await db.query('select name, code from leave_types where is_active order by name');
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((d) => `${DAYS[isoWeekday(d)]} ${d}`).join(', ');
    const started = Date.now();
    const { signal, done } = withTimeout();
    try {
      const parsed = await jsonWithRetry([
        { role: 'system', content: `Convert a leave request written in plain English or Roman Urdu into JSON.
Today is ${DAYS[isoWeekday(today)]} ${today}. Calendar for the next 14 days: ${days}. "Next Monday" means the first Monday after today.
Leave type codes: ${types.map((t) => `${t.code} (${t.name})`).join(', ')}. Rules: wedding, family event, personal work -> CASUAL; illness, doctor, fever -> SICK; vacation, trip, travel -> ANNUAL; "without pay" -> UNPAID.
Return JSON exactly like {"type":"CASUAL","start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"short reason"}.` },
        { role: 'user', content: req.body.text },
      ], z.object({ type: z.string().min(2), start: z.string().date(), end: z.string().date(), reason: z.string().max(200).default('') }), signal);
      if (!parsed) {
        await log(req.user, 'smart_leave', { input: req.body.text, status: 'invalid_json', latency: Date.now() - started });
        return res.json({ ok: false, fallback: 'form', message: "I couldn't understand that — please fill in the form." });
      }
      let result;
      try {
        result = await buildLeaveDraft(req.user, parsed);
      } catch (err) {
        result = { error: err.message };
      }
      await log(req.user, 'smart_leave', { input: req.body.text, output: JSON.stringify(parsed), status: result.error ? 'fallback' : 'ok', latency: Date.now() - started });
      if (result.error) return res.json({ ok: false, fallback: 'form', message: result.error, parsed });
      res.json({ ok: true, draft: result.draft, aiGenerated: true, label: AI_LABEL });
    } catch (err) {
      await log(req.user, 'smart_leave', { input: req.body.text, status: isTimeout(err) ? 'timeout' : 'error', latency: Date.now() - started, error: err.message });
      res.json({ ok: false, fallback: 'form', message: 'The assistant is unavailable right now — please fill in the form.' });
    } finally {
      done();
    }
  }));

export default router;
