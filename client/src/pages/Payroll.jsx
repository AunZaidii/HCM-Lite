import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Download, Lock, Play, RefreshCw, Trash2, Wallet } from 'lucide-react';
import { api, download, errMsg, get } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, Empty, Field, Kpi, Modal, PageHeader, QueryState, Table, fmtDateTime, monthName, pkr, pkr2, todayStr,
} from '../ui';

function useInvalidatePayroll() {
  const qc = useQueryClient();
  return () => ['payroll-runs', 'payroll-run', 'payslips', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

async function downloadPdf(id) {
  try {
    await download(`/payslips/${id}/pdf`, 'payslip.pdf');
  } catch (err) {
    toast.error(errMsg(err));
  }
}

export function PayrollRuns() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const invalidate = useInvalidatePayroll();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const q = useQuery({ queryKey: ['payroll-runs'], queryFn: () => get('/payroll/runs') });
  const create = useMutation({
    mutationFn: () => api.post('/payroll/runs', { month }).then((r) => r.data),
    onSuccess: (run) => {
      invalidate();
      toast.success(`Payroll draft for ${monthName(month)} created`);
      setOpen(false);
      navigate(`/payroll/${run.id}`);
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  const isHr = user.role === 'hr';

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle={isHr ? 'Create and review monthly payroll drafts. Admin finalizes and locks the month.' : 'Review drafts prepared by HR and finalize them to lock the month.'}
        actions={isHr && <Button onClick={() => setOpen(true)}><Play className="h-4 w-4" /> Run payroll</Button>}
      />
      <Card bodyClass="p-0 sm:p-0">
        <div className="p-4">
          <QueryState q={q} isEmpty={(d) => !d.length} empty={(
            <Empty title="No payroll runs yet" icon={Wallet}>
              HR creates a monthly draft from attendance and leave, then Admin reviews and finalizes it. Finalized payslips become visible to employees.
            </Empty>
          )}>
            {(runs) => (
              <Table>
                <thead>
                  <tr><th>Month</th><th>Status</th><th>Employees</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Tax</th><th className="text-right">Net</th><th>Created by</th><th>Finalized by</th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => navigate(`/payroll/${r.id}`)}>
                      <td className="font-medium"><Link to={`/payroll/${r.id}`} className="text-brand-700 hover:underline dark:text-brand-500">{monthName(r.month)}</Link></td>
                      <td><Badge status={r.status} /></td>
                      <td className="tabular-nums">{r.employeeCount}</td>
                      <td className="text-right tabular-nums">{pkr(r.totalGross)}</td>
                      <td className="text-right tabular-nums">{pkr(r.totalDeductions)}</td>
                      <td className="text-right tabular-nums">{pkr(r.totalTax)}</td>
                      <td className="text-right font-medium tabular-nums">{pkr(r.totalNet)}</td>
                      <td>{r.createdByName || '—'}</td>
                      <td>{r.finalizedByName ? <span>{r.finalizedByName}<span className="block text-xs text-slate-500">{fmtDateTime(r.finalizedAt)}</span></span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </QueryState>
        </div>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Run payroll"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} disabled={!month} onClick={() => create.mutate()}>Create draft</Button></>}>
        <Field label="Month" hint="One run per month. Absences, unpaid leave and half days up to today are deducted.">
          <input type="month" className="input" value={month} max={todayStr().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);

export function PayrollRun() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const invalidate = useInvalidatePayroll();
  const [confirm, setConfirm] = useState(null); // 'finalize' | 'delete'
  const q = useQuery({ queryKey: ['payroll-run', id], queryFn: () => get(`/payroll/runs/${id}`) });

  const action = useMutation({
    mutationFn: (kind) => {
      if (kind === 'recalculate') return api.post(`/payroll/runs/${id}/recalculate`);
      if (kind === 'finalize') return api.post(`/payroll/runs/${id}/finalize`);
      return api.delete(`/payroll/runs/${id}`);
    },
    onSuccess: (_r, kind) => {
      invalidate();
      setConfirm(null);
      if (kind === 'delete') { toast.success('Draft deleted'); navigate('/payroll'); return; }
      toast.success(kind === 'finalize' ? 'Payroll finalized and locked. Employees were notified.' : 'Draft recalculated');
    },
    onError: (err) => { toast.error(errMsg(err)); setConfirm(null); },
  });

  return (
    <QueryState q={q} rows={6}>
      {(run) => {
        const draft = run.status === 'draft';
        const slips = run.payslips || [];
        const warnings = Array.isArray(run.warnings) ? run.warnings : [];
        return (
          <>
            <PageHeader
              title={`Payroll — ${monthName(run.month)}`}
              subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge status={run.status} />
                {!draft && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><Lock className="h-3.5 w-3.5" /> Finalized — locked{run.finalizedAt ? ` on ${fmtDateTime(run.finalizedAt)}` : ''}</span>}
                {draft && <span>Draft — review before Admin finalizes</span>}</span>}
              actions={<>
                <Button variant="secondary" onClick={() => navigate('/payroll')}>Back</Button>
                {draft && user.role === 'hr' && <>
                  <Button variant="secondary" loading={action.isPending && action.variables === 'recalculate'} onClick={() => action.mutate('recalculate')}><RefreshCw className="h-4 w-4" /> Recalculate</Button>
                  <Button variant="danger" onClick={() => setConfirm('delete')}><Trash2 className="h-4 w-4" /> Delete draft</Button>
                </>}
                {draft && user.role === 'admin' && <Button onClick={() => setConfirm('finalize')}><Lock className="h-4 w-4" /> Finalize</Button>}
              </>}
            />

            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label="Employees" value={run.employeeCount} tone="slate" />
              <Kpi label="Working days" value={run.workingDays} tone="slate" />
              <Kpi label="Gross (prorated)" value={pkr(run.totalGross)} />
              <Kpi label="Deductions" value={pkr(run.totalDeductions)} tone="amber" />
              <Kpi label="Tax" value={pkr(run.totalTax)} tone="violet" />
              <Kpi label="Net pay" value={pkr(run.totalNet)} tone="brand" />
            </div>

            {warnings.length > 0 && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Skipped employees</div>
                <ul className="list-disc pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            )}

            <Card title="Payslips" actions={<span className="text-xs text-slate-500">Gross = 1.5 × basic · per day = gross ÷ working days · deductions = absent + unpaid + 0.5 × half days</span>}>
              {!slips.length ? <Empty title="No payslips in this run" /> : (
                <Table>
                  <thead>
                    <tr>
                      <th>Employee</th><th className="text-right">Basic</th><th className="text-right">Gross</th><th className="text-right">Proration</th>
                      <th className="text-right">Prorated gross</th><th className="text-right">Absent</th><th className="text-right">Unpaid</th>
                      <th className="text-right">Half days</th><th className="text-right">Lates</th><th className="text-right">Deduction</th>
                      <th className="text-right">Tax</th><th className="text-right">Net</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {slips.map((p) => (
                      <tr key={p.id}>
                        <td className="min-w-40">
                          <div className="font-medium">{p.employeeSnapshot?.name}</div>
                          <div className="text-xs text-slate-500">{p.employeeSnapshot?.code} · {p.employeeSnapshot?.department}</div>
                        </td>
                        <td className="text-right tabular-nums">{pkr(p.basic)}</td>
                        <td className="text-right tabular-nums">{pkr(p.gross)}</td>
                        <td className="text-right tabular-nums">{Number(p.prorationFactor).toFixed(2)}</td>
                        <td className="text-right tabular-nums">{pkr2(p.proratedGross)}</td>
                        <td className="text-right tabular-nums">{p.absentDays}</td>
                        <td className="text-right tabular-nums">{p.unpaidLeaveDays}</td>
                        <td className="text-right tabular-nums">{p.halfDays}</td>
                        <td className="text-right tabular-nums">{p.lateCount}{Number(p.latePenaltyDays) > 0 && <span className="block text-xs text-amber-600">−{p.latePenaltyDays}d</span>}</td>
                        <td className="text-right tabular-nums">{pkr2(p.deductionAmount)}</td>
                        <td className="text-right tabular-nums">{pkr2(p.tax)}</td>
                        <td className="text-right font-semibold tabular-nums">{pkr2(p.netPay)}</td>
                        <td><Button size="sm" variant="ghost" onClick={() => downloadPdf(p.id)} aria-label="Download payslip PDF"><Download className="h-4 w-4" /></Button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pkr(sum(slips, 'basic'))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pkr(sum(slips, 'gross'))}</td>
                      <td />
                      <td className="px-3 py-2 text-right tabular-nums">{pkr2(sum(slips, 'proratedGross'))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(slips, 'absentDays')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(slips, 'unpaidLeaveDays')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(slips, 'halfDays')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(slips, 'lateCount')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pkr2(sum(slips, 'deductionAmount'))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pkr2(sum(slips, 'tax'))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pkr2(sum(slips, 'netPay'))}</td>
                      <td />
                    </tr>
                  </tfoot>
                </Table>
              )}
            </Card>

            <Modal open={confirm === 'finalize'} onClose={() => setConfirm(null)} title={`Finalize ${monthName(run.month)}?`}
              footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate('finalize')}><Lock className="h-4 w-4" /> Finalize</Button></>}>
              <p className="text-sm text-slate-600 dark:text-slate-300">This locks the month; payslips become visible to employees and cannot be edited.</p>
              <p className="mt-2 text-sm">Net pay total: <b>{pkr2(run.totalNet)}</b> for {run.employeeCount} employee(s).</p>
            </Modal>
            <Modal open={confirm === 'delete'} onClose={() => setConfirm(null)} title="Delete this draft?"
              footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={action.isPending} onClick={() => action.mutate('delete')}>Delete draft</Button></>}>
              <p className="text-sm text-slate-600 dark:text-slate-300">The draft and its payslips will be removed. You can run payroll for this month again afterwards.</p>
            </Modal>
          </>
        );
      }}
    </QueryState>
  );
}

export function Payslips() {
  const { user } = useAuth();
  const staff = user.role !== 'employee';
  const [month, setMonth] = useState('');
  const [mine, setMine] = useState(false);
  const params = { ...(month ? { month } : {}), ...(staff && mine ? { mine: 'true' } : {}) };
  const q = useQuery({ queryKey: ['payslips', params], queryFn: () => get('/payslips', params) });

  return (
    <>
      <PageHeader title={staff ? 'Payslips' : 'My payslips'} subtitle={staff ? 'All payslips across payroll runs.' : 'Your payslips from finalized payroll runs.'} />
      <Card
        actions={(
          <>
            {staff && <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Filter by month" />}
            {staff && month && <Button size="sm" variant="ghost" onClick={() => setMonth('')}>Clear</Button>}
            {user.role === 'hr' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only
              </label>
            )}
          </>
        )}
        title={staff ? 'Filter' : undefined}
      >
        <QueryState q={q} isEmpty={(d) => !d.length} empty={<Empty title="No payslips yet">They appear after Admin finalizes payroll.</Empty>}>
          {(rows) => (
            <Table>
              <thead>
                <tr><th>Month</th>{staff && <th>Employee</th>}<th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Tax</th><th className="text-right">Net</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">{monthName(p.month)}</td>
                    {staff && <td><div>{p.employeeSnapshot?.name}</div><div className="text-xs text-slate-500">{p.employeeSnapshot?.code} · {p.employeeSnapshot?.department}</div></td>}
                    <td className="text-right tabular-nums">{pkr2(p.proratedGross ?? p.gross)}</td>
                    <td className="text-right tabular-nums">{pkr2(p.deductionAmount)}</td>
                    <td className="text-right tabular-nums">{pkr2(p.tax)}</td>
                    <td className="text-right font-semibold tabular-nums">{pkr2(p.netPay)}</td>
                    <td><Badge status={p.runStatus} /></td>
                    <td><Button size="sm" variant="secondary" onClick={() => downloadPdf(p.id)}><Download className="h-4 w-4" /> PDF</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
