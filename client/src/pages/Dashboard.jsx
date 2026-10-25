import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CalendarDays, Clock, Download, Sparkles, UserCheck, Users, Wallet } from 'lucide-react';
import { api, download, errMsg, get } from '../api';
import { useAuth } from '../auth';
import { AiBadge, Badge, Button, Card, Empty, ErrorState, Kpi, Loading, PageHeader, Table, fmtDate, fmtDateTime, monthName, pkr, todayStr } from '../ui';
import { CheckInWidget } from './Attendance';
import { AnnouncementsWidget } from './Comms';

const BRAND = '#0d9488';
const tooltipStyle = { contentStyle: { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }, cursor: { fill: 'rgba(148,163,184,0.12)' } };
const axis = { tick: { fontSize: 11, fill: '#64748b' }, tickLine: false, axisLine: false };

function presetRange(p) {
  const t = todayStr();
  const d = new Date(`${t}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  if (p === 'today') return { from: t, to: t };
  if (p === 'week') { const dow = d.getUTCDay() || 7; const s = new Date(d); s.setUTCDate(d.getUTCDate() - dow + 1); return { from: iso(s), to: t }; }
  if (p === 'last-month') { const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); return { from: iso(s), to: iso(e) }; }
  if (p === 'year') return { from: `${t.slice(0, 4)}-01-01`, to: t };
  return { from: `${t.slice(0, 7)}-01`, to: t };
}

// One filter row above the charts: date-range presets + custom range + department.
function FilterBar({ filters, setFilters }) {
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => get('/departments') });
  const [preset, setPreset] = useState('month');
  const choose = (p) => { setPreset(p); if (p !== 'custom') setFilters({ ...filters, ...presetRange(p) }); };
  return (
    <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
      <div className="flex flex-wrap gap-1">
        {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['last-month', 'Last month'], ['year', 'This year'], ['custom', 'Custom']].map(([k, l]) => (
          <button key={k} onClick={() => choose(k)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${preset === k ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}>{l}</button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="flex gap-2">
          <input type="date" className="input w-auto" value={filters.from} max={filters.to} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From" />
          <input type="date" className="input w-auto" value={filters.to} min={filters.from} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To" />
        </div>
      )}
      <select className="input w-auto min-w-40" value={filters.departmentId} onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })} aria-label="Department">
        <option value="">All departments</option>
        {depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <span className="ml-auto text-xs text-slate-500">{fmtDate(filters.from)} → {fmtDate(filters.to)}</span>
    </div>
  );
}

function SummaryCard({ dashboard, filters }) {
  const m = useMutation({ mutationFn: () => api.post('/ai/summary', { dashboard, ...clean(filters) }).then((r) => r.data) });
  return (
    <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-600" /> AI summary</span>}
      actions={<Button size="sm" variant="secondary" loading={m.isPending} onClick={() => m.mutate()}>Summarize</Button>}>
      {!m.data && !m.isError && !m.isPending && <p className="text-sm text-slate-500">Click Summarize for 3–5 insights based only on the numbers above.</p>}
      {m.isPending && <Loading rows={3} />}
      {m.isError && <p className="text-sm text-red-600">{errMsg(m.error)}</p>}
      {m.data?.fallback && <p className="text-sm text-amber-700">{m.data.message}</p>}
      {m.data?.bullets && (
        <div className="space-y-2">
          <AiBadge />
          <ul className="list-disc space-y-1 pl-5 text-sm">{m.data.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}

const clean = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v));

function ChartBox({ data, empty = 'No data for this period yet', children, height = 220 }) {
  if (!data?.length) return <Empty title={empty} />;
  return <div style={{ height }}><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;
}

function SimpleBar({ data, x, y, unit = '', format }) {
  return (
    <ChartBox data={data}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#e2e8f0" strokeOpacity={0.6} />
        <XAxis dataKey={x} {...axis} interval={0} />
        <YAxis {...axis} allowDecimals={false} tickFormatter={format} />
        <Tooltip {...tooltipStyle} formatter={(v) => [format ? format(v) : `${v}${unit}`, '']} separator="" />
        <Bar dataKey={y} fill={BRAND} radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ChartBox>
  );
}

function HrDashboard() {
  const [filters, setFilters] = useState({ ...presetRange('month'), departmentId: '' });
  const q = useQuery({ queryKey: ['hr-dashboard', filters], queryFn: () => get('/analytics/hr', clean(filters)) });
  const d = q.data;
  return (
    <>
      <PageHeader title="HR dashboard" subtitle="Live numbers from attendance, leave and approvals" />
      <FilterBar filters={filters} setFilters={setFilters} />
      {q.isLoading && <Loading rows={6} />}
      {q.isError && <ErrorState error={q.error} onRetry={q.refetch} />}
      {d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Headcount" value={d.kpis.headcount} icon={Users} />
            <Kpi label="Present today" value={d.kpis.presentToday} icon={UserCheck} />
            <Kpi label="On leave today" value={d.kpis.onLeaveToday} tone="blue" icon={CalendarDays} />
            <Kpi label="Late today" value={d.kpis.lateToday} tone="amber" icon={Clock} />
            <Kpi label="Pending approvals" value={d.kpis.pendingApprovals} tone="violet" sub={`${d.kpis.pendingLeave} leave · ${d.kpis.pendingCorrections} corrections`} />
            <Kpi label="Attendance rate" value={d.kpis.attendanceRate === null ? '—' : `${d.kpis.attendanceRate}%`} sub={`Late ${d.kpis.latePct ?? 0}% of arrivals`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Attendance trend (rate %)" className="lg:col-span-2">
              <ChartBox data={d.attendanceTrend}>
                <LineChart data={d.attendanceTrend} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" strokeOpacity={0.6} />
                  <XAxis dataKey="date" {...axis} tickFormatter={(v) => v.slice(8)} />
                  <YAxis {...axis} domain={[0, 100]} />
                  <Tooltip {...tooltipStyle} labelFormatter={fmtDate} formatter={(v) => [`${v}%`, 'Attendance']} />
                  <Line type="monotone" dataKey="rate" stroke={BRAND} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ChartBox>
            </Card>
            <SummaryCard dashboard="hr" filters={filters} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Absenteeism by department (%)"><SimpleBar data={d.absenteeismByDepartment} x="department" y="absenteeismPct" unit="%" /></Card>
            <Card title="Leave days by type"><SimpleBar data={d.leaveByType} x="leaveType" y="days" unit=" days" /></Card>
            <Card title="Top 5 late-comers">
              {!d.topLateComers.length ? <Empty title="No late arrivals in this period" /> : (
                <Table>
                  <thead><tr><th>Employee</th><th>Dept</th><th className="text-right">Lates</th></tr></thead>
                  <tbody>{d.topLateComers.map((r) => <tr key={r.employeeId}><td>{r.fullName}</td><td>{r.department}</td><td className="text-right font-semibold tabular-nums">{r.lateCount}</td></tr>)}</tbody>
                </Table>
              )}
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Late % and absenteeism by department">
              {!d.absenteeismByDepartment.length ? <Empty title="No attendance yet" /> : (
                <Table>
                  <thead><tr><th>Department</th><th className="text-right">Late</th><th className="text-right">Late %</th><th className="text-right">Absent</th><th className="text-right">Absenteeism</th></tr></thead>
                  <tbody>{d.absenteeismByDepartment.map((r) => (
                    <tr key={r.department}><td>{r.department}</td><td className="text-right tabular-nums">{r.late}</td><td className="text-right tabular-nums">{r.latePct ?? '—'}{r.latePct !== null && '%'}</td>
                      <td className="text-right tabular-nums">{r.absent}</td><td className="text-right tabular-nums">{r.absenteeismPct ?? '—'}{r.absenteeismPct !== null && '%'}</td></tr>
                  ))}</tbody>
                </Table>
              )}
            </Card>
            <Card title={`Leave utilization ${filters.to.slice(0, 4)} (approved ÷ quota)`}>
              {!d.leaveUtilization.length ? <Empty title="No leave types or employees yet" /> : (
                <Table>
                  <thead><tr><th>Department</th><th>Leave type</th><th className="text-right">Approved days</th><th className="text-right">Quota × staff</th><th className="text-right">Utilization</th></tr></thead>
                  <tbody>{d.leaveUtilization.map((r) => (
                    <tr key={`${r.department}-${r.leaveType}`}><td>{r.department}</td><td>{r.leaveType}</td><td className="text-right tabular-nums">{r.approvedDays}</td>
                      <td className="text-right tabular-nums">{r.quota === null ? 'Unlimited' : r.quota * r.headcount}</td>
                      <td className="text-right tabular-nums">{r.utilizationPct === null ? '—' : `${r.utilizationPct}%`}</td></tr>
                  ))}</tbody>
                </Table>
              )}
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={<span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> Absence anomaly flags</span>}>
              {!d.anomalyFlags.length ? <Empty title="No unusual patterns" /> : (
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {d.anomalyFlags.map((f, i) => <li key={i} className="flex flex-wrap justify-between gap-2 py-2"><span><b>{f.employee}</b> — {f.flag}</span><span className="text-slate-500">{f.evidence}</span></li>)}
                </ul>
              )}
            </Card>
            <AnnouncementsWidget />
          </div>
        </div>
      )}
    </>
  );
}

// Payroll cost: sum of gross and net by month (chart) and by month × department (table).
function PayrollByMonth({ rows }) {
  const byMonth = Object.values(rows.reduce((acc, r) => {
    acc[r.month] ??= { month: r.month, gross: 0, net: 0 };
    acc[r.month].gross += r.gross;
    acc[r.month].net += r.net;
    return acc;
  }, {}));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Payroll cost by month (gross)">
        <SimpleBar data={byMonth.map((m) => ({ ...m, label: monthName(m.month).slice(0, 3) }))} x="label" y="gross" format={(v) => `${Math.round(v / 1000)}k`} />
      </Card>
      <Card title="Payroll cost by month and department" className="lg:col-span-2">
        {!rows.length ? <Empty title="No payroll runs yet">HR creates a monthly draft; Admin finalizes it.</Empty> : (
          <Table>
            <thead><tr><th>Month</th><th>Department</th><th>Status</th><th className="text-right">Employees</th><th className="text-right">Gross</th><th className="text-right">Net</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.month}-${r.department}`}><td>{monthName(r.month)}</td><td>{r.department}</td><td><Badge status={r.status} /></td>
                <td className="text-right tabular-nums">{r.employees}</td><td className="text-right tabular-nums">{pkr(r.gross)}</td><td className="text-right tabular-nums">{pkr(r.net)}</td></tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function AdminDashboard() {
  const [filters, setFilters] = useState({ ...presetRange('month'), departmentId: '' });
  const q = useQuery({ queryKey: ['admin-dashboard', filters], queryFn: () => get('/analytics/admin', clean(filters)) });
  const d = q.data;
  const latestCost = d ? d.payrollCostByDepartment.filter((c) => c.month === d.kpis.payrollMonth) : [];
  return (
    <>
      <PageHeader title="Company dashboard" subtitle="Headcount, attrition and payroll across the company" />
      <FilterBar filters={filters} setFilters={setFilters} />
      {q.isLoading && <Loading rows={6} />}
      {q.isError && <ErrorState error={q.error} onRetry={q.refetch} />}
      {d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Headcount" value={d.kpis.headcount} icon={Users} />
            <Kpi label="Attrition YTD" value={`${d.kpis.attritionYtdPct}%`} tone="amber" sub={`${d.kpis.exitsYtd} exit(s) this year`} />
            <Kpi label={`Payroll cost${d.kpis.payrollMonth ? ` · ${monthName(d.kpis.payrollMonth)}` : ''}`} value={d.kpis.payrollMonth ? pkr(d.kpis.payrollGross) : '—'} sub={d.kpis.payrollMonth ? `Net ${pkr(d.kpis.payrollNet)}` : 'No payroll run yet'} icon={Wallet} />
            <Kpi label="Average gross salary" value={d.kpis.avgSalary ? pkr(d.kpis.avgSalary) : '—'} tone="slate" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Headcount by department"><SimpleBar data={d.headcountByDepartment} x="department" y="headcount" /></Card>
            <Card title={`Payroll cost by department${d.kpis.payrollMonth ? ` · ${monthName(d.kpis.payrollMonth)}` : ''}`}>
              <SimpleBar data={latestCost} x="department" y="gross" format={(v) => `${Math.round(v / 1000)}k`} />
            </Card>
            <SummaryCard dashboard="admin" filters={filters} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Gender"><SimpleBar data={d.gender} x="gender" y="count" /></Card>
            <Card title="Tenure"><SimpleBar data={d.tenure} x="band" y="count" /></Card>
            <Card title="Average gross salary">
              {!d.averageSalary.byDepartment.length ? <Empty title="No salaries yet" /> : (
                <Table>
                  <thead><tr><th>By department</th><th className="text-right">Avg gross</th></tr></thead>
                  <tbody>{d.averageSalary.byDepartment.map((r) => <tr key={r.department}><td>{r.department}</td><td className="text-right tabular-nums">{pkr(r.avgGross)}</td></tr>)}</tbody>
                  <thead><tr><th>By designation</th><th className="text-right">Avg gross</th></tr></thead>
                  <tbody>{d.averageSalary.byDesignation.map((r) => <tr key={r.designation}><td>{r.designation}</td><td className="text-right tabular-nums">{pkr(r.avgGross)}</td></tr>)}</tbody>
                </Table>
              )}
            </Card>
          </div>
          <PayrollByMonth rows={d.payrollCostByDepartment} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Audit feed" actions={<Link to="/audit" className="text-xs font-medium text-brand-700">View all</Link>} className="lg:col-span-1">
              {!d.auditFeed.length ? <Empty title="No activity yet" /> : (
                <ul className="space-y-2 text-sm">{d.auditFeed.map((a) => (
                  <li key={a.id} className="flex justify-between gap-2"><span><b>{a.actorName || 'System'}</b> <span className="font-mono text-xs">{a.action}</span></span><span className="shrink-0 text-xs text-slate-500">{fmtDateTime(a.createdAt)}</span></li>
                ))}</ul>
              )}
            </Card>
            <Card title="Attrition risk (heuristic)">
              {!d.attritionRisk.length ? <Empty title="No employees yet" /> : (
                <ul className="space-y-2 text-sm">{d.attritionRisk.map((r) => (
                  <li key={r.employeeId} className="flex items-start justify-between gap-2">
                    <span><b>{r.employee}</b><span className="block text-xs text-slate-500">{r.factors.join(', ') || 'no risk factors'}</span></span>
                    <Badge status={r.level === 'High' ? 'absent' : r.level === 'Medium' ? 'late' : 'present'}>{r.level} · {r.score}</Badge>
                  </li>
                ))}</ul>
              )}
            </Card>
            <AnnouncementsWidget />
          </div>
        </div>
      )}
    </>
  );
}

export function EmployeeDashboard() {
  const { user } = useAuth();
  const me = useQuery({ queryKey: ['me-dashboard'], queryFn: () => get('/analytics/me') });
  const balances = useQuery({ queryKey: ['leave-balance'], queryFn: () => get('/leave/balance') });
  const d = me.data;
  return (
    <>
      <PageHeader title={`Hello, ${user.fullName.split(' ')[0]}`} subtitle="Your day at a glance" />
      <div className="grid gap-4 lg:grid-cols-3">
        <CheckInWidget />
        <Card title="This week">
          {me.isLoading ? <Loading /> : me.isError ? <ErrorState error={me.error} onRetry={me.refetch} /> : (
            <div className="space-y-3">
              <div className="flex items-end justify-between"><span className="text-3xl font-semibold tabular-nums">{d.hoursThisWeek}h</span><span className="text-sm text-slate-500">of {d.hoursTarget}h</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={d.hoursThisWeek} aria-valuemax={40}>
                <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, (d.hoursThisWeek / d.hoursTarget) * 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
                <div><div className="text-xs text-slate-500">Late this month</div><div className="text-xl font-semibold text-amber-600">{d.lateCountThisMonth}</div></div>
                <div><div className="text-xs text-slate-500">Attendance rate</div><div className="text-xl font-semibold">{d.attendanceThisMonth.attendanceRate ?? '—'}{d.attendanceThisMonth.attendanceRate !== null && '%'}</div></div>
              </div>
            </div>
          )}
        </Card>
        <Card title="Last payslip">
          {me.isLoading ? <Loading /> : !d?.lastPayslip ? <Empty title="No payslip yet">Payslips appear after Admin finalizes payroll.</Empty> : (
            <div className="space-y-2">
              <div className="text-sm text-slate-500">{monthName(d.lastPayslip.month)}</div>
              <div className="text-3xl font-semibold tabular-nums text-brand-700">{pkr(d.lastPayslip.netPay)}</div>
              <div className="text-xs text-slate-500">Gross {pkr(d.lastPayslip.gross)}</div>
              <Button size="sm" variant="secondary" onClick={() => download(`/payslips/${d.lastPayslip.id}/pdf`, 'payslip.pdf').catch((e) => toast.error(errMsg(e)))}><Download className="h-4 w-4" /> Download PDF</Button>
            </div>
          )}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Leave balance" actions={<Link to="/leave" className="text-xs font-medium text-brand-700">Apply for leave</Link>}>
          {balances.isLoading ? <Loading /> : balances.isError ? <ErrorState error={balances.error} /> : !balances.data.length ? <Empty title="No leave types configured yet" /> : (
            <ul className="space-y-2 text-sm">{balances.data.map((b) => (
              <li key={b.leaveTypeId} className="flex justify-between"><span>{b.name}</span><span className="font-semibold tabular-nums">{b.quota === null ? 'Unlimited' : `${b.remaining} / ${b.quota}`}</span></li>
            ))}</ul>
          )}
        </Card>
        <AnnouncementsWidget />
        <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-600" /> Ask my assistant</span>}>
          <p className="text-sm text-slate-600 dark:text-slate-300">Try: “How many sick leaves do I have left?”, “What was my attendance this month?”, or “I need next Monday and Tuesday off for my sister's wedding”.</p>
          <Link to="/assistant" className="mt-3 inline-flex rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700">Open assistant</Link>
        </Card>
      </div>
    </>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  if (user.role === 'admin') return <AdminDashboard />;
  if (user.role === 'hr') return <HrDashboard />;
  return <EmployeeDashboard />;
}
