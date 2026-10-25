import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarPlus, Sparkles } from 'lucide-react';
import { api, errMsg, get } from '../api';
import { useAuth } from '../auth';
import {
  AiBadge, Badge, Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, Table, cx, fmtDate, fmtDateTime, todayStr,
} from '../ui';

const invalidateLeave = (qc) => ['leave-balance', 'leave-requests', 'on-leave', 'hr-dashboard', 'me-dashboard', 'notifications']
  .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

// ---------------- Leave form (used directly and pre-filled by smart leave) ----------------
export function LeaveForm({ draft, onDone }) {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['leave-types', 'active'], queryFn: () => get('/leave-types', { active: 'true' }) });
  const [form, setForm] = useState({
    leaveTypeId: draft?.leaveTypeId || '', startDate: draft?.start || '', endDate: draft?.end || '', reason: draft?.reason || '',
  });
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');

  // Live preview: working days, balance, overlap — the same checks the server runs on submit.
  useEffect(() => {
    const { leaveTypeId, startDate, endDate } = form;
    setPreview(null);
    setPreviewError('');
    if (!leaveTypeId || !startDate || !endDate) return undefined;
    let cancelled = false;
    api.post('/leave/preview', { leaveTypeId, startDate, endDate })
      .then((r) => { if (!cancelled) setPreview(r.data); })
      .catch((e) => { if (!cancelled) setPreviewError(errMsg(e)); });
    return () => { cancelled = true; };
  }, [form.leaveTypeId, form.startDate, form.endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = useMutation({
    mutationFn: () => api.post('/leave/requests', { ...form, source: draft ? 'smart' : 'form' }),
    onSuccess: () => {
      toast.success('Leave request submitted to HR');
      invalidateLeave(qc);
      setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
      onDone?.();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const canSubmit = preview?.ok && !previewError;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Leave type" className="sm:col-span-2">
          <Select value={form.leaveTypeId} onChange={set('leaveTypeId')} placeholder={types.isLoading ? 'Loading…' : 'Choose leave type'}
            options={(types.data || []).map((t) => ({ value: t.id, label: `${t.name}${t.yearlyQuota === null ? ' (unlimited)' : ` (${t.yearlyQuota}/year)`}` }))} />
        </Field>
        <Field label="Start date"><input type="date" className="input" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="End date"><input type="date" className="input" min={form.startDate || undefined} value={form.endDate} onChange={set('endDate')} /></Field>
        <Field label="Reason" className="sm:col-span-2">
          <textarea className="input" rows={2} value={form.reason} onChange={set('reason')} placeholder="Optional" />
        </Field>
      </div>
      {previewError && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{previewError}</p>}
      {preview && (
        <div className={cx('rounded-lg p-3 text-sm', preview.ok ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200')}>
          <div><b>{preview.workingDays}</b> working day(s) (weekends and public holidays skipped) · Available: <b>{preview.available === null ? 'Unlimited' : preview.available}</b></div>
          {preview.problems.map((p) => <div key={p.code} className="mt-1">⚠ {p.message}</div>)}
        </div>
      )}
      <div className="flex justify-end">
        <Button loading={submit.isPending} disabled={!canSubmit} onClick={() => submit.mutate()}>
          <CalendarPlus className="h-4 w-4" /> Submit request
        </Button>
      </div>
    </div>
  );
}

// ---------------- My leave (HR + Employee) ----------------
export function MyLeave() {
  const qc = useQueryClient();
  const balance = useQuery({ queryKey: ['leave-balance'], queryFn: () => get('/leave/balance') });
  const history = useQuery({ queryKey: ['leave-requests', 'mine'], queryFn: () => get('/leave/requests', { mine: 'true' }) });
  const [text, setText] = useState('');
  const [draft, setDraft] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [cancelRow, setCancelRow] = useState(null);

  const smart = useMutation({
    mutationFn: () => api.post('/ai/smart-leave', { text }).then((r) => r.data),
    onSuccess: (r) => {
      if (r.ok) {
        setDraft(r.draft);
        toast.success('Form pre-filled — please check before submitting');
      } else {
        setDraft(null);
        toast.message(r.message || "Couldn't understand that — please fill in the form.");
      }
      setFormKey((k) => k + 1);
    },
    onError: (e) => { setDraft(null); setFormKey((k) => k + 1); toast.error(errMsg(e)); },
  });

  const cancel = useMutation({
    mutationFn: (id) => api.post(`/leave/requests/${id}/cancel`),
    onSuccess: () => { toast.success('Leave cancelled — balance restored'); invalidateLeave(qc); setCancelRow(null); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const today = todayStr();
  return (
    <div className="space-y-5">
      <PageHeader title="My leave" subtitle="Balances count approved leave; pending requests are held from your available days" />

      <QueryState q={balance} isEmpty={(d) => !d.length} rows={2}
        empty={<Card><Empty title="No leave types yet">Admin needs to set up leave types first.</Empty></Card>}>
        {(rows) => (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {rows.map((b) => (
              <div key={b.leaveTypeId} className="card p-4">
                <div className="text-xs font-medium text-slate-500">{b.name}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-brand-700 dark:text-brand-500">
                  {b.quota === null ? '∞' : b.remaining}<span className="text-sm font-normal text-slate-400">{b.quota === null ? ' unlimited' : ` / ${b.quota}`}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{b.approved} taken · {b.pending} pending</div>
              </div>
            ))}
          </div>
        )}
      </QueryState>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-violet-600" /> Smart leave</span>}>
          <p className="mb-2 text-sm text-slate-500">Describe your leave in plain words (English or Roman Urdu). The assistant fills the form; nothing is sent until you submit.</p>
          <textarea className="input" rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. I need next Monday and Tuesday off for my sister's wedding" />
          <div className="mt-2 flex justify-end">
            <Button variant="secondary" loading={smart.isPending} disabled={text.trim().length < 3} onClick={() => smart.mutate()}>
              <Sparkles className="h-4 w-4" /> Fill the form
            </Button>
          </div>
        </Card>

        <Card title="Apply for leave" actions={draft && <AiBadge />}>
          {draft && (
            <p className="mb-3 rounded-lg bg-violet-50 p-2 text-xs text-violet-800 dark:bg-violet-900/30 dark:text-violet-200">
              Pre-filled by the assistant as <b>{draft.leaveTypeName}</b>, {fmtDate(draft.start)} → {fmtDate(draft.end)} — please check before submitting.
            </p>
          )}
          <LeaveForm key={formKey} draft={draft} onDone={() => { setDraft(null); setText(''); setFormKey((k) => k + 1); }} />
        </Card>
      </div>

      <Card title="History">
        <QueryState q={history} isEmpty={(d) => !d.length} empty={<Empty title="No leave requests yet" />}>
          {(rows) => (
            <Table>
              <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Review</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const cancellable = r.status === 'pending' || (r.status === 'approved' && r.startDate > today);
                  return (
                    <tr key={r.id}>
                      <td>{r.leaveTypeName}{r.source === 'smart' && <Sparkles className="ml-1 inline h-3 w-3 text-violet-500" />}</td>
                      <td className="whitespace-nowrap">{fmtDate(r.startDate)}</td>
                      <td className="whitespace-nowrap">{fmtDate(r.endDate)}</td>
                      <td>{r.days}</td>
                      <td><Badge status={r.status} /></td>
                      <td className="text-xs text-slate-500">{r.reviewerName ? `${r.reviewerName}${r.reviewComment ? `: ${r.reviewComment}` : ''}` : '—'}</td>
                      <td>{cancellable && <Button size="sm" variant="ghost" onClick={() => setCancelRow(r)}>Cancel</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={!!cancelRow} onClose={() => setCancelRow(null)} title="Cancel leave?"
        footer={<><Button variant="secondary" onClick={() => setCancelRow(null)}>Keep it</Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(cancelRow.id)}>Cancel leave</Button></>}>
        {cancelRow && <p className="text-sm">{cancelRow.leaveTypeName} leave {fmtDate(cancelRow.startDate)} → {fmtDate(cancelRow.endDate)} ({cancelRow.days} days) will be cancelled and the days returned to your balance.</p>}
      </Modal>
    </div>
  );
}

// ---------------- Approvals (HR approve; Admin view) ----------------
export function LeaveApprovals() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [departmentId, setDepartmentId] = useState('');
  const [decision, setDecision] = useState(null); // { row, approve }
  const [comment, setComment] = useState('');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => get('/departments') });
  const q = useQuery({
    queryKey: ['leave-requests', status, departmentId],
    queryFn: () => get('/leave/requests', { status: status || undefined, departmentId: departmentId || undefined }),
  });
  const onLeave = useQuery({ queryKey: ['on-leave'], queryFn: () => get('/leave/on-leave') });
  const decide = useMutation({
    mutationFn: () => api.post(`/leave/requests/${decision.row.id}/${decision.approve ? 'approve' : 'reject'}`, { comment: comment || undefined }),
    onSuccess: () => { toast.success(decision.approve ? 'Leave approved' : 'Leave rejected'); invalidateLeave(qc); setDecision(null); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const isHr = user.role === 'hr';

  return (
    <div className="space-y-5">
      <PageHeader title={isHr ? 'Leave approvals' : 'Leave requests'}
        subtitle={isHr ? 'Approve or reject with a comment. Your own requests must be decided by another HR user.' : 'View only — HR approves leave'} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) => (
                <button key={l} onClick={() => setStatus(v)}
                  className={cx('rounded-lg px-3 py-1.5 text-sm font-medium', status === v ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>{l}</button>
              ))}
            </div>
            <div className="w-full sm:w-52">
              <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} placeholder="All departments"
                options={(depts.data || []).map((d) => ({ value: d.id, label: d.name }))} />
            </div>
          </div>
          <QueryState q={q} isEmpty={(d) => !d.length} empty={<Empty title={status === 'pending' ? 'No pending requests' : 'No requests'}>All caught up.</Empty>}>
            {(rows) => (
              <Table>
                <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th>{isHr && <th />}</tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><div className="font-medium">{r.fullName}</div><div className="text-xs text-slate-500">{r.departmentName}</div></td>
                      <td>{r.leaveTypeName}</td>
                      <td className="whitespace-nowrap text-xs">{fmtDate(r.startDate)} → {fmtDate(r.endDate)}</td>
                      <td>{r.days}</td>
                      <td className="max-w-48 text-xs">{r.reason || '—'}{r.reviewComment && <div className="text-slate-500">Review: {r.reviewComment}</div>}</td>
                      <td><Badge status={r.status} /></td>
                      {isHr && (
                        <td className="whitespace-nowrap">
                          {r.status === 'pending' && r.employeeId !== user.employeeId && (
                            <div className="flex gap-1">
                              <Button size="sm" onClick={() => { setComment(''); setDecision({ row: r, approve: true }); }}>Approve</Button>
                              <Button size="sm" variant="secondary" onClick={() => { setComment(''); setDecision({ row: r, approve: false }); }}>Reject</Button>
                            </div>
                          )}
                          {r.status === 'pending' && r.employeeId === user.employeeId && <span className="text-xs text-slate-400">Your request</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </QueryState>
        </Card>
        <Card title="On leave today">
          <QueryState q={onLeave} isEmpty={(d) => !d.length} empty={<Empty title="Nobody is on leave today" />}>
            {(rows) => (
              <ul className="space-y-2 text-sm">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <div><div className="font-medium">{r.fullName}</div><div className="text-xs text-slate-500">{r.departmentName} · until {fmtDate(r.endDate)}</div></div>
                    <Badge status="on_leave">{r.leaveType}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Card>
      </div>

      <Modal open={!!decision} onClose={() => setDecision(null)} title={decision?.approve ? 'Approve leave' : 'Reject leave'}
        footer={<>
          <Button variant="secondary" onClick={() => setDecision(null)}>Cancel</Button>
          <Button variant={decision?.approve ? 'primary' : 'danger'} loading={decide.isPending}
            disabled={!decision?.approve && comment.trim().length < 2} onClick={() => decide.mutate()}>
            {decision?.approve ? 'Approve' : 'Reject'}
          </Button>
        </>}>
        {decision && (
          <div className="space-y-3 text-sm">
            <p><b>{decision.row.fullName}</b> — {decision.row.leaveTypeName}, {fmtDate(decision.row.startDate)} → {fmtDate(decision.row.endDate)} ({decision.row.days} working days)</p>
            <p className="text-xs text-slate-500">Requested {fmtDateTime(decision.row.createdAt)}</p>
            <Field label={decision.approve ? 'Comment (optional)' : 'Comment (required)'}>
              <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
