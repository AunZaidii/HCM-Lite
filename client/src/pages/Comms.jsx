import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Megaphone, Pin, Plus, ScrollText, Trash2 } from 'lucide-react';
import { api, errMsg, get } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, Table, cx, fmtDate, fmtDateTime } from '../ui';

const AUDIENCES = [
  { value: 'all', label: 'Everyone' },
  { value: 'hr', label: 'HR only' },
  { value: 'employee', label: 'Employees' },
];
const audienceLabel = (a) => AUDIENCES.find((x) => x.value === a)?.label || a;

function Composer({ open, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: '', body: '', audience: 'all', pinned: false });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const post = useMutation({
    mutationFn: () => api.post('/announcements', form),
    onSuccess: () => {
      ['announcements', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success('Announcement posted');
      setForm({ title: '', body: '', audience: 'all', pinned: false });
      onClose();
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  const valid = form.title.trim().length >= 3 && form.body.trim().length >= 3;
  return (
    <Modal open={open} onClose={onClose} title="New announcement"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={post.isPending} disabled={!valid} onClick={() => post.mutate()}>Post</Button></>}>
      <div className="space-y-3">
        <Field label="Title"><input className="input" value={form.title} onChange={set('title')} maxLength={120} autoFocus /></Field>
        <Field label="Message"><textarea className="input min-h-28" value={form.body} onChange={set('body')} maxLength={2000} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Audience"><Select options={AUDIENCES} value={form.audience} onChange={set('audience')} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.pinned} onChange={set('pinned')} /> Pin to top</label>
        </div>
      </div>
    </Modal>
  );
}

export function Announcements() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const q = useQuery({ queryKey: ['announcements', 'all'], queryFn: () => get('/announcements') });
  const del = useMutation({
    mutationFn: (id) => api.delete(`/announcements/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['announcements'] }); toast.success('Announcement deleted'); setToDelete(null); },
    onError: (err) => { toast.error(errMsg(err)); setToDelete(null); },
  });
  const canPost = ['admin', 'hr'].includes(user.role);

  return (
    <>
      <PageHeader title="Announcements" subtitle="Company news shown on every dashboard."
        actions={canPost && <Button onClick={() => setComposing(true)}><Plus className="h-4 w-4" /> New announcement</Button>} />
      <QueryState q={q} isEmpty={(d) => !d.length} empty={(
        <div className="card"><Empty title="No announcements yet" icon={Megaphone}>{canPost ? 'Post the first announcement for your team.' : 'Announcements from Admin and HR will appear here.'}</Empty></div>
      )}>
        {(items) => (
          <div className="space-y-3">
            {items.map((a) => (
              <article key={a.id} className={cx('card p-4', a.pinned && 'border-brand-500/50 dark:border-brand-700')}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 font-semibold">{a.pinned && <Pin className="h-4 w-4 text-brand-700" aria-label="Pinned" />}{a.title}</h2>
                    <div className="mt-0.5 text-xs text-slate-500">{a.authorName || 'Unknown'} · {fmtDateTime(a.createdAt)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{audienceLabel(a.audience)}</Badge>
                    {(user.role === 'admin' || (canPost && a.createdBy === user.id)) && (
                      <Button size="sm" variant="ghost" onClick={() => setToDelete(a)} aria-label="Delete announcement"><Trash2 className="h-4 w-4" /></Button>
                    )}
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-line text-sm text-slate-700 dark:text-slate-300">{a.body}</p>
              </article>
            ))}
          </div>
        )}
      </QueryState>
      <Composer open={composing} onClose={() => setComposing(false)} />
      <Modal open={!!toDelete} onClose={() => setToDelete(null)} title="Delete announcement?"
        footer={<><Button variant="secondary" onClick={() => setToDelete(null)}>Cancel</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate(toDelete.id)}>Delete</Button></>}>
        <p className="text-sm">“{toDelete?.title}” will be removed for everyone.</p>
      </Modal>
    </>
  );
}

export function AnnouncementsWidget({ limit = 5 }) {
  const q = useQuery({ queryKey: ['announcements', limit], queryFn: () => get('/announcements', { limit }) });
  return (
    <Card title="Announcements" actions={<Link to="/announcements" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-500">View all</Link>}>
      <QueryState q={q} rows={2} isEmpty={(d) => !d.length} empty={<Empty title="No announcements" icon={Megaphone} />}>
        {(items) => (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((a) => (
              <li key={a.id} className="py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">{a.pinned && <Pin className="h-3.5 w-3.5 text-brand-700" />}{a.title}</div>
                <p className="line-clamp-2 text-xs text-slate-500">{a.body}</p>
                <div className="mt-0.5 text-[11px] text-slate-400">{a.authorName} · {fmtDate(a.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

const asObj = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return { value: v }; } }
  return v;
};

function JsonPane({ title, data, changed }) {
  if (!data) return <div><div className="label">{title}</div><div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-400 dark:bg-slate-800">—</div></div>;
  return (
    <div className="min-w-0">
      <div className="label">{title}</div>
      <pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed dark:bg-slate-800">
        {'{\n'}
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className={cx(changed.has(k) && 'rounded bg-amber-100 dark:bg-amber-900/40')}>
            {'  '}<span className="text-violet-700 dark:text-violet-300">"{k}"</span>: {JSON.stringify(v)}
          </div>
        ))}
        {'}'}
      </pre>
    </div>
  );
}

const ENTITY_TYPES = ['company', 'user', 'employee', 'department', 'designation', 'leave_type', 'holiday', 'attendance', 'attendance_correction', 'leave_request', 'payroll_run', 'announcement']
  .map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

export function AuditLog() {
  const [filters, setFilters] = useState({ action: '', entityType: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const params = Object.fromEntries(Object.entries({ ...filters, page }).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['audit', params], queryFn: () => get('/audit', params), placeholderData: (prev) => prev });
  const set = (k) => (e) => { setFilters({ ...filters, [k]: e.target.value }); setPage(1); };

  const before = asObj(selected?.before);
  const after = asObj(selected?.after);
  const changed = new Set(
    [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
      .filter((k) => before && after && JSON.stringify(before[k]) !== JSON.stringify(after[k])),
  );

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every create, update, approve and finalize action, with who did it and what changed." />
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        <ScrollText className="h-4 w-4 text-brand-700" /> Append-only: entries cannot be edited or deleted.
      </div>
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Action"><input className="input" placeholder="e.g. LEAVE_APPROVED" value={filters.action} onChange={set('action')} /></Field>
          <Field label="Entity"><Select placeholder="All entities" options={ENTITY_TYPES} value={filters.entityType} onChange={set('entityType')} /></Field>
          <Field label="From"><input type="date" className="input" value={filters.from} onChange={set('from')} /></Field>
          <Field label="To"><input type="date" className="input" value={filters.to} onChange={set('to')} /></Field>
        </div>
        <QueryState q={q} rows={6} isEmpty={(d) => !d.items.length} empty={<Empty title="No audit entries match these filters" icon={ScrollText} />}>
          {(data) => (
            <>
              <Table>
                <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setSelected(r)}>
                      <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                      <td><div>{r.actorName || 'System'}</div>{r.actorRole && <div className="text-xs uppercase text-slate-500">{r.actorRole}</div>}</td>
                      <td><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">{r.action}</span></td>
                      <td><div className="capitalize">{r.entityType?.replace(/_/g, ' ')}</div>{r.entityId && <div className="max-w-40 truncate font-mono text-[11px] text-slate-500">{r.entityId}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
                <span>{data.total} entr{data.total === 1 ? 'y' : 'ies'} · page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </QueryState>
      </Card>

      <Modal wide open={!!selected} onClose={() => setSelected(null)} title={selected ? `${selected.action} · ${fmtDateTime(selected.createdAt)}` : ''}>
        {selected && (
          <>
            <div className="mb-3 grid gap-1 text-sm sm:grid-cols-2">
              <div><span className="text-slate-500">Actor:</span> {selected.actorName || 'System'} {selected.actorRole && `(${selected.actorRole})`}</div>
              <div><span className="text-slate-500">Entity:</span> {selected.entityType} {selected.entityId && <span className="font-mono text-xs">{selected.entityId}</span>}</div>
              {selected.ip && <div><span className="text-slate-500">IP:</span> {selected.ip}</div>}
            </div>
            {changed.size > 0 && <p className="mb-2 text-xs text-slate-500">Highlighted keys changed: {[...changed].join(', ')}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              <JsonPane title="Before" data={before} changed={changed} />
              <JsonPane title="After" data={after} changed={changed} />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

// Admin: every AI call is logged in ai_logs (feature, tools used, status, latency).
export function AiLogs() {
  const q = useQuery({ queryKey: ['ai-logs'], queryFn: () => get('/ai/logs') });
  return (
    <>
      <PageHeader title="AI logs" subtitle="Every assistant, summary and smart-leave call — including timeouts, rate limits and fallbacks" />
      <Card bodyClass="p-0 sm:p-4">
        <QueryState q={q} isEmpty={(d) => !d.length} empty={<Empty title="No AI calls yet" />}>
          {(rows) => (
            <Table>
              <thead><tr><th>Time</th><th>User</th><th>Feature</th><th>Status</th><th>Tools</th><th className="text-right">Latency</th><th>Input</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td className="whitespace-nowrap">{r.fullName || '—'} <span className="text-xs capitalize text-slate-500">{r.role}</span></td>
                  <td className="font-mono text-xs">{r.feature}</td>
                  <td><Badge status={r.status === 'ok' ? 'present' : r.status === 'rate_limited' || r.status === 'timeout' ? 'late' : 'absent'}>{r.status}</Badge></td>
                  <td className="font-mono text-xs">{(r.toolsCalled || []).map((t) => t.name).join(', ') || '—'}</td>
                  <td className="text-right tabular-nums">{r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="max-w-xs truncate" title={r.input}>{r.input || '—'}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
