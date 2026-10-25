import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { activeUserIds, notify } from '../lib/notify.js';
import { conflict, forbidden, locked, notFound, unprocessable } from '../lib/errors.js';
import { workingDaysBetween } from '../lib/rules/calendar.js';
import { latePenaltyDays } from '../lib/rules/attendance.js';
import { computePayslip } from '../lib/rules/payroll.js';
import { getSettings, holidaySet } from '../lib/settings.js';
import { maxDate, minDate, monthEnd, todayLocal } from '../lib/time.js';
import { renderPayslipPdf } from '../lib/pdf/payslipPdf.js';
import { protect, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';

const router = Router();
const idParam = z.object({ id: z.string().uuid() });
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Builds payslip rows for every employee employed during the month who has a salary structure.
async function generatePayslips(q, run, month) {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const settings = await getSettings(q);
  const holidays = await holidaySet(start, end, q);
  const workingDays = workingDaysBetween(start, end, settings.weekendDays, holidays);
  const employees = await q.query(
    `select e.id, e.employee_code, e.full_name, e.join_date, e.exit_date, e.department_id, d.name as department, g.title as designation
     from employees e join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
     where e.join_date <= $2 and (e.exit_date is null or e.exit_date >= $1) order by e.employee_code`, [start, end]);
  const counts = await q.query(
    `select employee_id,
            count(*) filter (where status = 'absent')::int as absent,
            count(*) filter (where status = 'half_day')::int as half_days,
            count(*) filter (where status = 'on_leave' and leave_is_paid = false)::int as unpaid,
            count(*) filter (where is_late)::int as lates
     from fn_daily_status($1::date, $2::date, null, null) where is_working_day group by employee_id`, [start, end]);
  const byEmp = new Map(counts.map((c) => [c.employeeId, c]));
  const warnings = [];
  let totals = { gross: 0, deductions: 0, tax: 0, net: 0, count: 0 };
  for (const e of employees) {
    const lastDay = e.exitDate ? minDate(e.exitDate, end) : end;
    const salary = await q.one(
      `select basic from salary_structures where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1`, [e.id, lastDay]);
    if (!salary) { warnings.push(`${e.employeeCode} ${e.fullName}: no salary structure`); continue; }
    const employedWorkingDays = workingDaysBetween(maxDate(e.joinDate, start), lastDay, settings.weekendDays, holidays);
    const c = byEmp.get(e.id) || { absent: 0, halfDays: 0, unpaid: 0, lates: 0 };
    const penalty = settings.latePenaltyEnabled ? latePenaltyDays(c.lates) : 0;
    const p = computePayslip({ basic: salary.basic, workingDays, employedWorkingDays, absentDays: c.absent,
      unpaidLeaveDays: c.unpaid, halfDays: c.halfDays, latePenaltyDays: penalty });
    await q.query(
      `insert into payslips (payroll_run_id, employee_id, employee_snapshot, basic, hra, medical, gross, working_days, employed_working_days,
         proration_factor, prorated_gross, absent_days, unpaid_leave_days, half_days, late_count, late_penalty_days, deduction_days,
         per_day_rate, deduction_amount, tax, net_pay)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [run.id, e.id, JSON.stringify({ code: e.employeeCode, name: e.fullName, department: e.department, departmentId: e.departmentId, designation: e.designation }),
        p.basic, p.hra, p.medical, p.gross, workingDays, employedWorkingDays, p.prorationFactor, p.proratedGross, c.absent, c.unpaid,
        c.halfDays, c.lates, penalty, p.deductionDays, p.perDayRate, p.deductionAmount, p.tax, p.netPay]);
    totals = { gross: totals.gross + p.proratedGross, deductions: totals.deductions + p.deductionAmount, tax: totals.tax + p.tax,
      net: totals.net + p.netPay, count: totals.count + 1 };
  }
  return q.one(
    `update payroll_runs set working_days = $1, total_gross = $2, total_deductions = $3, total_tax = $4, total_net = $5,
       employee_count = $6, warnings = $7, updated_at = now() where id = $8 returning *`,
    [workingDays, totals.gross, totals.deductions, totals.tax, totals.net, totals.count, JSON.stringify(warnings), run.id]);
}

router.get('/payroll/runs', ...protect, requireRole('admin', 'hr'), h(async (_req, res) => {
  res.json(await db.query(
    `select r.*, to_char(r.period_month, 'YYYY-MM') as month, c.full_name as created_by_name, f.full_name as finalized_by_name
     from payroll_runs r left join users c on c.id = r.created_by left join users f on f.id = r.finalized_by order by r.period_month desc`));
}));

router.post('/payroll/runs', ...protect, requireRole('hr'),
  validate({ body: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }) }),
  h(async (req, res) => {
    if (req.body.month > todayLocal().slice(0, 7)) throw unprocessable('FUTURE_MONTH', 'Payroll cannot be generated for a future month');
    const run = await tx(async (q) => {
      if (await q.one('select id from payroll_runs where period_month = $1', [`${req.body.month}-01`])) {
        throw conflict('RUN_EXISTS', `A payroll run for ${req.body.month} already exists`);
      }
      const created = await q.one(
        'insert into payroll_runs (period_month, working_days, created_by) values ($1, 0, $2) returning *', [`${req.body.month}-01`, req.user.id]);
      const full = await generatePayslips(q, created, req.body.month);
      if (!full.employeeCount) throw unprocessable('NO_SALARIED_EMPLOYEES', 'No employees with a salary structure were employed in this month');
      await audit({ q, actor: req.user, action: 'PAYROLL_DRAFT_CREATED', entityType: 'payroll_run', entityId: full.id, after: full, req });
      await notify(await activeUserIds(['admin'], q), { type: 'PAYROLL_READY_FOR_FINALIZE',
        title: `Payroll draft for ${monthLabel(req.body.month)} is ready to finalize`, link: `/payroll/${full.id}` }, q);
      return full;
    });
    res.status(201).json(run);
  }));

async function loadRun(id) {
  const run = await db.one(`select r.*, to_char(r.period_month, 'YYYY-MM') as month from payroll_runs r where r.id = $1`, [id]);
  if (!run) throw notFound('Payroll run not found');
  return run;
}

router.get('/payroll/runs/:id', ...protect, requireRole('admin', 'hr'), validate({ params: idParam }), h(async (req, res) => {
  const run = await loadRun(req.params.id);
  const payslips = await db.query('select * from payslips where payroll_run_id = $1 order by employee_snapshot->>\'code\'', [run.id]);
  res.json({ ...run, payslips });
}));

router.post('/payroll/runs/:id/recalculate', ...protect, requireRole('hr'), validate({ params: idParam }), h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status === 'finalized') throw locked();
  const after = await tx(async (q) => {
    await q.query('delete from payslips where payroll_run_id = $1', [run.id]);
    const full = await generatePayslips(q, run, run.month);
    await audit({ q, actor: req.user, action: 'PAYROLL_RECALCULATED', entityType: 'payroll_run', entityId: run.id, before: run, after: full, req });
    return full;
  });
  res.json(after);
}));

router.delete('/payroll/runs/:id', ...protect, requireRole('hr'), validate({ params: idParam }), h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status === 'finalized') throw locked();
  await db.query('delete from payroll_runs where id = $1', [run.id]);
  await audit({ actor: req.user, action: 'PAYROLL_DRAFT_DELETED', entityType: 'payroll_run', entityId: run.id, before: run, req });
  res.status(204).end();
}));

// Only Admin can finalize; finalized runs are locked (service check + DB trigger).
router.post('/payroll/runs/:id/finalize', ...protect, requireRole('admin'), validate({ params: idParam }), h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status === 'finalized') throw locked('This payroll run is already finalized');
  const after = await tx(async (q) => {
    const updated = await q.one(
      `update payroll_runs set status = 'finalized', finalized_by = $1, finalized_at = now(), updated_at = now() where id = $2 returning *`,
      [req.user.id, run.id]);
    await audit({ q, actor: req.user, action: 'PAYROLL_FINALIZED', entityType: 'payroll_run', entityId: run.id, before: run, after: updated, req });
    const users = await q.query('select e.user_id from payslips p join employees e on e.id = p.employee_id where p.payroll_run_id = $1', [run.id]);
    await notify(users.map((u) => u.userId), { type: 'PAYSLIP_READY', title: `Your payslip for ${monthLabel(run.month)} is ready`, link: '/payslips' }, q);
    return updated;
  });
  res.json(after);
}));

// ---- Payslips: Admin/HR all, Employee own and only from finalized runs ----
const PAYSLIP_SELECT = `select p.*, to_char(r.period_month, 'YYYY-MM') as month, r.status as run_status, e.user_id
  from payslips p join payroll_runs r on r.id = p.payroll_run_id join employees e on e.id = p.employee_id`;

router.get('/payslips', ...protect,
  validate({ query: z.object({ month: z.string().optional(), employeeId: z.string().uuid().optional(), mine: z.enum(['true', 'false']).optional() }) }),
  h(async (req, res) => {
    const params = [];
    const where = [];
    if (req.user.role === 'employee' || req.query.mine === 'true') {
      params.push(req.user.employeeId); where.push(`p.employee_id = $${params.length}`); where.push("r.status = 'finalized'");
    } else if (req.query.employeeId) { params.push(req.query.employeeId); where.push(`p.employee_id = $${params.length}`); }
    if (req.query.month) { params.push(`${req.query.month}-01`); where.push(`r.period_month = $${params.length}`); }
    res.json(await db.query(`${PAYSLIP_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by r.period_month desc, p.employee_snapshot->>'code'`, params));
  }));

async function loadPayslip(req) {
  const p = await db.one(`${PAYSLIP_SELECT} where p.id = $1`, [req.params.id]);
  if (!p) throw notFound('Payslip not found');
  const own = p.employeeId === req.user.employeeId;
  if (req.user.role === 'employee' && !own) throw forbidden('You can only view your own payslips');
  if (req.user.role !== 'admin' && own && p.runStatus !== 'finalized') throw notFound('Payslip not available yet');
  return p;
}

router.get('/payslips/:id', ...protect, validate({ params: idParam }), h(async (req, res) => res.json(await loadPayslip(req))));

router.get('/payslips/:id/pdf', ...protect, validate({ params: idParam }), h(async (req, res) => {
  const p = await loadPayslip(req);
  const settings = await getSettings();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.employeeSnapshot.code}-${p.month}.pdf"`);
  renderPayslipPdf(res, { payslip: p, companyName: settings.companyName, monthLabel: monthLabel(p.month) });
}));

export default router;
