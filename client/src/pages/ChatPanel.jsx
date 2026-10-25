import { useEffect, useRef, useState } from 'react';
import { Bot, CalendarPlus, Send, X } from 'lucide-react';
import { api, errMsg } from '../api';
import { useAuth } from '../auth';
import { AiBadge, Button, Modal, cx, fmtDate } from '../ui';
import { LeaveForm } from './Leave';

const SUGGESTIONS = {
  admin: ['How many active employees are in each department?', 'Who is on leave today?', "What is this month's attendance rate?", 'Summarize payroll for this month'],
  hr: ['Who came late most often this month?', "What is this month's attendance rate?", 'Who is on leave today?', 'How many active employees are in Engineering?'],
  employee: ['How many sick leaves do I have left this year?', 'What was my attendance this month?', 'I need next Monday and Tuesday off for my sister\'s wedding', 'What happens if I check in at 9:20?'],
};

// AI chat: the browser only talks to our API; the server calls the model with role-scoped tools.
export default function ChatPanel({ floating, onClose }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const history = next.filter((m) => !m.error).slice(-10).map(({ role, content: c }) => ({ role, content: c.slice(0, 1000) }));
      const { data } = await api.post('/ai/chat', { messages: history }, { timeout: 25000 });
      setMessages([...next, { role: 'assistant', content: data.answer, tools: data.toolsUsed, action: data.action }]);
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: errMsg(err), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className={cx('flex flex-col', floating ? 'h-full' : 'card h-[calc(100vh-9rem)]')}>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 font-semibold"><Bot className="h-5 w-5 text-violet-600" /> HCM Assistant</div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-slate-500 sm:inline">Answers from {user.role === 'employee' ? 'your own data' : user.role === 'hr' ? 'HR data' : 'all company data'}</span>
          {floating && <button onClick={onClose} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close assistant"><X className="h-4 w-4" /></button>}
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {!messages.length && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">Ask about attendance, leave, payroll or company policy. English and Roman Urdu both work.</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS[user.role].map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-violet-200 px-3 py-1.5 text-left text-xs text-violet-700 hover:bg-violet-50 dark:border-violet-900 dark:text-violet-300 dark:hover:bg-violet-950">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cx('max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm',
              m.role === 'user' ? 'bg-brand-700 text-white' : m.error ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-slate-100 dark:bg-slate-800')}>
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.role === 'assistant' && !m.error && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <AiBadge />
                  {m.tools?.map((t) => <span key={t} className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-900">used: {t}</span>)}
                </div>
              )}
              {m.action?.type === 'OPEN_LEAVE_FORM' && (
                <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs dark:border-slate-700 dark:bg-slate-900">
                  <div className="font-medium">{m.action.draft.leaveTypeName} leave · {fmtDate(m.action.draft.start)} → {fmtDate(m.action.draft.end)} · {m.action.draft.workingDays} working day(s)</div>
                  <Button size="sm" className="mt-2" onClick={() => setDraft(m.action.draft)}><CalendarPlus className="h-3.5 w-3.5" /> Open pre-filled form</Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex gap-1 px-2 py-3" aria-label="Assistant is thinking">{[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-violet-400" style={{ animationDelay: `${i * 120}ms` }} />)}</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2 border-t border-slate-100 p-3 dark:border-slate-800">
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question…" maxLength={1000} aria-label="Message" />
        <Button type="submit" loading={busy} disabled={!input.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
      <Modal open={!!draft} onClose={() => setDraft(null)} title="Confirm your leave request">
        {draft && (
          <>
            <div className="mb-3 flex items-center gap-2 text-xs text-slate-500"><AiBadge /> Pre-filled by the assistant — please check before submitting.</div>
            <LeaveForm draft={draft} onDone={() => setDraft(null)} />
          </>
        )}
      </Modal>
    </div>
  );

  if (!floating) return body;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="h-full w-full bg-white shadow-2xl sm:max-w-md dark:bg-slate-900" onMouseDown={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
}
