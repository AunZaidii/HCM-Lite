import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Camera, ChevronLeft, ChevronRight, Clock, LogIn, LogOut, Plus } from 'lucide-react';
import { api, errMsg, get } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, Empty, ErrorState, Field, Loading, Modal, PageHeader, QueryState, Select, Table,
  cx, fmtDate, fmtDateTime, fmtTime, monthName, todayStr,
} from '../ui';

const hours = (m) => (m === null || m === undefined ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

const DAY_COLORS = {
  present: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  late: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  half_day: 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
  absent: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  on_leave: 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200',
  missing_checkout: 'bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200',
  not_checked_in: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  weekend: 'bg-slate-50 text-slate-400 dark:bg-slate-800/40 dark:text-slate-500',
  holiday: 'bg-slate-50 text-slate-400 dark:bg-slate-800/40 dark:text-slate-500',
  upcoming: 'bg-slate-50 text-slate-400 dark:bg-slate-800/40 dark:text-slate-500',
};

function useDepartments() {
  return useQuery({ queryKey: ['departments'], queryFn: () => get('/departments') });
}

// ---------------- Check-in widget (dashboards) ----------------
export function CheckInWidget() {
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => get('/attendance/today') });
  const settings = useQuery({ queryKey: ['settings-public'], queryFn: () => get('/settings/public') });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const after = () => ['today', 'me-dashboard', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const checkIn = useMutation({
    mutationFn: () => api.post('/attendance/check-in').then((r) => r.data),
    onSuccess: (r) => { toast.success(r.status === 'late' ? `Checked in at ${fmtTime(r.checkInAt)} — marked late` : `Checked in at ${fmtTime(r.checkInAt)}`); after(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const checkOut = useMutation({
    mutationFn: () => api.post('/attendance/check-out').then((r) => r.data),
    onSuccess: (r) => { toast.success(`Checked out — worked ${hours(r.workedMinutes)}${r.status === 'half_day' ? ' (half day)' : ''}`); after(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const rec = today.data?.record;
  return (
    <Card title="Today" actions={settings.data?.cameraCheckinEnabled && !rec && (
      <Link to="/attendance/camera" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700"><Camera className="h-3.5 w-3.5" /> Use camera</Link>
    )}>
      {today.isLoading ? <Loading rows={2} /> : today.isError ? <ErrorState error={today.error} onRetry={today.refetch} /> : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm text-slate-500">{fmtDate(today.data.date)}</div>
              <div className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
                <Clock className="h-5 w-5 text-slate-400" />
                {now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi' })}
              </div>
            </div>
            {rec ? <Badge status={rec.checkOutAt ? rec.status : rec.isLate ? 'late' : 'present'} /> : today.data.onLeave ? <Badge status="on_leave" /> : <Badge>not checked in</Badge>}
          </div>
          {today.data.onLeave && <p className="text-sm text-blue-700 dark:text-blue-300">You are on approved {today.data.onLeave} leave today.</p>}
          {rec && (
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div><div className="text-xs text-slate-500">Check in</div>{fmtTime(rec.checkInAt)}</div>
              <div><div className="text-xs text-slate-500">Check out</div>{fmtTime(rec.checkOutAt)}</div>
              <div><div className="text-xs text-slate-500">Worked</div>{hours(rec.workedMinutes)}</div>
            </div>
          )}
          {!rec && !today.data.onLeave && (
            <Button className="w-full" loading={checkIn.isPending} onClick={() => checkIn.mutate()}><LogIn className="h-4 w-4" /> Check in</Button>
          )}
          {rec && !rec.checkOutAt && (
            <Button variant="secondary" className="w-full" loading={checkOut.isPending} onClick={() => checkOut.mutate()}><LogOut className="h-4 w-4" /> Check out</Button>
          )}
          {rec?.checkOutAt && <p className="text-center text-xs text-slate-500">Done for today. Mistake? <Link to="/attendance/corrections" className="text-brand-700">Request a correction</Link></p>}
          <p className="text-[11px] text-slate-400">Time is recorded by the server.</p>
        </div>
      )}
    </Card>
  );
}

// ---------------- Daily board (Admin/HR) ----------------
export function AttendanceBoard() {
  const [date, setDate] = useState(todayStr());
  const [departmentId, setDepartmentId] = useState('');
  const depts = useDepartments();
  const q = useQuery({
    queryKey: ['board', date, departmentId],
    queryFn: () => get('/attendance/board', { date, departmentId: departmentId || undefined }),
  });
  return (
    <div>
      <PageHeader title="Daily attendance board" subtitle="Every employee's status for the selected day" />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="Date"><input type="date" className="input" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value || todayStr())} /></Field>
          <Field label="Department">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} placeholder="All departments"
              options={(depts.data || []).map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
        </div>
        <QueryState q={q} isEmpty={(d) => !d.rows.length} rows={5}
          empty={<Empty title="No employees for this day">Register employees to see them on the board.</Empty>}>
          {(d) => (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {Object.entries(d.counts).map(([s, n]) => <Badge key={s} status={s}>{s.replace(/_/g, ' ')}: {n}</Badge>)}
              </div>
              <Table>
                <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Check in</th><th>Check out</th><th>Hours</th><th>Leave</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.employeeId}>
                      <td><div className="font-medium">{r.fullName}</div><div className="text-xs text-slate-500">{r.employeeCode}</div></td>
                      <td>{r.departmentName}</td>
                      <td><Badge status={r.status} />{r.isLate && r.status !== 'late' && <span className="ml-1 text-xs text-amber-600">late</span>}</td>
                      <td>{fmtTime(r.checkInAt)}{r.source === 'camera' && <Camera className="ml-1 inline h-3 w-3 text-slate-400" />}</td>
                      <td>{fmtTime(r.checkOutAt)}</td>
                      <td>{hours(r.workedMinutes)}</td>
                      <td>{r.leaveType || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

// ---------------- Correction request form ----------------
function CorrectionModal({ open, date, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ date: date || todayStr(), requestedCheckIn: '', requestedCheckOut: '', reason: '' });
  useEffect(() => { if (open) setForm({ date: date || todayStr(), requestedCheckIn: '', requestedCheckOut: '', reason: '' }); }, [open, date]);
  const m = useMutation({
    mutationFn: () => api.post('/attendance/corrections', {
      date: form.date, reason: form.reason,
      requestedCheckIn: form.requestedCheckIn || null, requestedCheckOut: form.requestedCheckOut || null,
    }),
    onSuccess: () => { toast.success('Correction request sent to HR'); qc.invalidateQueries({ queryKey: ['corrections'] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Request attendance correction"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Send request</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" className="sm:col-span-3"><input type="date" className="input" max={todayStr()} value={form.date} onChange={set('date')} /></Field>
        <Field label="Check-in time"><input type="time" className="input" value={form.requestedCheckIn} onChange={set('requestedCheckIn')} /></Field>
        <Field label="Check-out time"><input type="time" className="input" value={form.requestedCheckOut} onChange={set('requestedCheckOut')} /></Field>
        <Field label="Reason" className="sm:col-span-3" hint="At least 5 characters. HR will review it.">
          <textarea className="input" rows={3} value={form.reason} onChange={set('reason')} placeholder="e.g. Forgot to check out, left at 18:10" />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------- Calendar ----------------
const shiftMonth = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export function AttendanceCalendar() {
  const { user } = useAuth();
  const staff = user.role !== 'employee';
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [params] = useSearchParams();
  // Staff can open another employee's calendar (e.g. from Employee 360 via ?employeeId=).
  const [employeeId, setEmployeeId] = useState((staff && params.get('employeeId')) || user.employeeId || '');
  const [correctionDate, setCorrectionDate] = useState(null);
  const emps = useQuery({ queryKey: ['employees', 'picker'], queryFn: () => get('/employees', { pageSize: 100 }), enabled: staff });
  const q = useQuery({
    queryKey: ['calendar', month, employeeId],
    queryFn: () => get('/attendance/calendar', { month, employeeId: staff ? employeeId : undefined }),
    enabled: !staff || !!employeeId,
  });
  const canRequest = user.role !== 'admin' && (!staff || employeeId === user.employeeId);
  const firstDow = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0

  return (
    <div>
      <PageHeader title={staff && employeeId !== user.employeeId ? 'Attendance calendar' : 'My attendance'}
        actions={canRequest && <Button variant="secondary" onClick={() => setCorrectionDate(todayStr())}><Plus className="h-4 w-4" /> Request correction</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          {staff && (
            <Field label="Employee" className="min-w-56 flex-1 sm:flex-none">
              <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="Choose an employee"
                options={(emps.data?.items || []).map((e) => ({ value: e.id, label: `${e.fullName} (${e.employeeCode})` }))} />
            </Field>
          )}
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <div className="w-36 text-center text-sm font-semibold">{monthName(month)}</div>
            <Button variant="secondary" size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
        {staff && !employeeId ? <Empty title="Choose an employee">Select an employee to see their month.</Empty> : (
          <QueryState q={q} rows={6} isEmpty={(d) => !d.days.length}
            empty={<Empty title="No days in this month">The employee had not joined yet in this month.</Empty>}>
            {(d) => (
              <>
                <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase text-slate-500">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => <div key={x}>{x}</div>)}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                  {Array.from({ length: firstDow }).map((_, i) => <div key={`b${i}`} />)}
                  {d.days.map((day) => {
                    const clickable = canRequest && day.date <= todayStr() && !['weekend', 'holiday', 'upcoming', 'on_leave'].includes(day.status);
                    return (
                      <button key={day.date} type="button" disabled={!clickable} onClick={() => setCorrectionDate(day.date)}
                        title={`${day.date}: ${day.status.replace(/_/g, ' ')}${day.leaveType ? ` (${day.leaveType})` : ''}`}
                        className={cx('min-h-16 rounded-lg p-1 text-left text-[11px] leading-tight sm:min-h-20 sm:p-1.5', DAY_COLORS[day.status] || DAY_COLORS.upcoming,
                          clickable && 'cursor-pointer hover:ring-2 hover:ring-brand-600/40')}>
                        <div className="text-xs font-semibold">{Number(day.date.slice(8))}</div>
                        <div className="hidden capitalize sm:block">{day.status === 'on_leave' && day.leaveType ? day.leaveType : day.status.replace(/_/g, ' ')}</div>
                        {day.checkInAt && <div className="hidden tabular-nums sm:block">{fmtTime(day.checkInAt)}–{day.checkOutAt ? fmtTime(day.checkOutAt) : '?'}</div>}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  {Object.entries(d.totals).map(([s, n]) => (
                    <span key={s} className={cx('rounded-full px-2 py-0.5 capitalize', DAY_COLORS[s])}>{s.replace(/_/g, ' ')}: {n}</span>
                  ))}
                </div>
                {canRequest && <p className="mt-2 text-xs text-slate-500">Tip: click a past day to request a correction.</p>}
              </>
            )}
          </QueryState>
        )}
      </Card>
      <CorrectionModal open={!!correctionDate} date={correctionDate} onClose={() => setCorrectionDate(null)} />
    </div>
  );
}

// ---------------- Corrections ----------------
export function Corrections() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const staff = user.role !== 'employee';
  const [status, setStatus] = useState(staff ? 'pending' : '');
  const [newOpen, setNewOpen] = useState(false);
  const [decision, setDecision] = useState(null); // { row, approve }
  const [comment, setComment] = useState('');
  const q = useQuery({ queryKey: ['corrections', status], queryFn: () => get('/attendance/corrections', { status: status || undefined }) });
  const decide = useMutation({
    mutationFn: () => api.post(`/attendance/corrections/${decision.row.id}/${decision.approve ? 'approve' : 'reject'}`, { comment: comment || undefined }),
    onSuccess: () => {
      toast.success(decision.approve ? 'Correction approved and attendance updated' : 'Correction rejected');
      ['corrections', 'board', 'calendar', 'hr-dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setDecision(null);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const tabs = staff ? [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']] : [];

  return (
    <div>
      <PageHeader title="Attendance corrections"
        subtitle={user.role === 'hr' ? 'Approve or reject requests; your own requests go to another HR user' : user.role === 'admin' ? 'View only — HR approves corrections' : 'Ask HR to fix a wrong or missing check-in/out'}
        actions={user.role !== 'admin' && <Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> New request</Button>} />
      <Card>
        {tabs.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1">
            {tabs.map(([v, l]) => (
              <button key={l} onClick={() => setStatus(v)}
                className={cx('rounded-lg px-3 py-1.5 text-sm font-medium', status === v ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>{l}</button>
            ))}
          </div>
        )}
        <QueryState q={q} isEmpty={(d) => !d.length}
          empty={<Empty title="No correction requests">{staff ? 'Requests from employees will appear here.' : 'Use "New request" if a check-in or check-out is wrong.'}</Empty>}>
          {(rows) => (
            <Table>
              <thead><tr>{staff && <th>Employee</th>}<th>Date</th><th>Requested in</th><th>Requested out</th><th>Reason</th><th>Status</th><th>Review</th>{user.role === 'hr' && <th />}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {staff && <td><div className="font-medium">{r.fullName}</div><div className="text-xs text-slate-500">{r.employeeCode}</div></td>}
                    <td className="whitespace-nowrap">{fmtDate(r.workDate)}</td>
                    <td>{fmtTime(r.requestedCheckIn)}</td>
                    <td>{fmtTime(r.requestedCheckOut)}</td>
                    <td className="max-w-xs">{r.reason}</td>
                    <td><Badge status={r.status} /></td>
                    <td className="text-xs text-slate-500">{r.reviewerName ? <>{r.reviewerName}{r.reviewComment && `: ${r.reviewComment}`}<div>{fmtDateTime(r.reviewedAt)}</div></> : '—'}</td>
                    {user.role === 'hr' && (
                      <td className="whitespace-nowrap">
                        {r.status === 'pending' && r.employeeId !== user.employeeId && (
                          <div className="flex gap-1">
                            <Button size="sm" onClick={() => { setComment(''); setDecision({ row: r, approve: true }); }}>Approve</Button>
                            <Button size="sm" variant="secondary" onClick={() => { setComment(''); setDecision({ row: r, approve: false }); }}>Reject</Button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
      <CorrectionModal open={newOpen} onClose={() => setNewOpen(false)} />
      <Modal open={!!decision} onClose={() => setDecision(null)} title={decision?.approve ? 'Approve correction' : 'Reject correction'}
        footer={<>
          <Button variant="secondary" onClick={() => setDecision(null)}>Cancel</Button>
          <Button variant={decision?.approve ? 'primary' : 'danger'} loading={decide.isPending}
            disabled={!decision?.approve && comment.trim().length < 2} onClick={() => decide.mutate()}>
            {decision?.approve ? 'Approve' : 'Reject'}
          </Button>
        </>}>
        {decision && (
          <div className="space-y-3 text-sm">
            <p><b>{decision.row.fullName}</b> — {fmtDate(decision.row.workDate)}: in {fmtTime(decision.row.requestedCheckIn)}, out {fmtTime(decision.row.requestedCheckOut)}</p>
            <p className="text-slate-500">“{decision.row.reason}”</p>
            <Field label={decision.approve ? 'Comment (optional)' : 'Comment (required)'}>
              <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
