// AI tools. Each tool reuses the same services and scope rules as the REST API.
// Tools a role may not use are never sent to the model, and employee tools are forced to the caller's own employee_id.
import { z } from 'zod';
import { db } from '../../lib/db.js';
import { todayLocal } from '../../lib/time.js';
import * as analytics from '../analytics.service.js';
import { leaveBalances, onLeave, previewLeave } from '../leave.service.js';
import { listEmployees } from '../employees.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function resolveDepartment(name) {
  if (!name) return null;
  const dept = await db.one('select id, name from departments where lower(name) = lower($1) or lower(code) = lower($1)', [name.trim()]);
  if (dept) return dept;
  const known = (await db.query('select name from departments order by name')).map((d) => d.name);
  throw new Error(`Unknown department '${name}'. Known departments: ${known.join(', ') || 'none yet'}`);
}

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});

const P = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD' },
  to: { type: 'string', description: 'End date YYYY-MM-DD' },
  departmentName: { type: 'string', description: 'Department name, e.g. Engineering' },
};

export const TOOLS = [
  {
    roles: ['admin', 'hr'],
    schema: fn('get_headcount', 'Number of employees employed (active + probation) on a date, optionally for one department. Same as the dashboard headcount.',
      { departmentName: P.departmentName, asOf: { type: 'string', description: 'Date YYYY-MM-DD, default today' } }),
    args: z.object({ departmentName: z.string().optional(), asOf: date.optional() }),
    async run(a) {
      const dept = await resolveDepartment(a.departmentName);
      const hc = await analytics.headcount({ asOf: a.asOf || todayLocal(), departmentId: dept?.id });
      return { department: dept?.name ?? 'All departments', asOf: a.asOf || todayLocal(), ...hc,
        byDepartment: dept ? undefined : await analytics.headcountByDepartment(a.asOf || todayLocal()) };
    },
  },
  {
    roles: ['admin', 'hr', 'employee'],
    schema: fn('get_attendance_summary', 'Attendance counts by status and the attendance rate, late % and absenteeism for a date range. For employees this is always their own attendance.',
      { ...P, employeeName: { type: 'string', description: 'Optional employee name (Admin/HR only)' } }, ['from', 'to']),
    args: z.object({ from: date, to: date, departmentName: z.string().optional(), employeeName: z.string().optional() }),
    async run(a, actor) {
      if (actor.role === 'employee') return analytics.attendanceSummary({ from: a.from, to: a.to, employeeId: actor.employeeId });
      const dept = await resolveDepartment(a.departmentName);
      let employeeId = null;
      if (a.employeeName) {
        const { items } = await listEmployees(actor, { q: a.employeeName, pageSize: 2 });
        if (!items.length) return { error: `No employee matching '${a.employeeName}'` };
        employeeId = items[0].id;
      }
      return { department: dept?.name ?? 'All departments', ...(await analytics.attendanceSummary({ from: a.from, to: a.to, departmentId: dept?.id, employeeId })) };
    },
  },
  {
    roles: ['admin', 'hr'],
    schema: fn('get_late_comers', 'Employees who checked in late most often in a date range, sorted by late count. Same as the dashboard "Top late-comers".',
      { ...P, limit: { type: 'integer', description: '1-20, default 5' } }, ['from', 'to']),
    args: z.object({ from: date, to: date, departmentName: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    async run(a) {
      const dept = await resolveDepartment(a.departmentName);
      return { lateComers: await analytics.lateComers({ from: a.from, to: a.to, departmentId: dept?.id, limit: a.limit || 5 }) };
    },
  },
  {
    roles: ['admin', 'hr', 'employee'],
    schema: fn('get_leave_summary', 'Who is on leave (approved) or has pending leave on a date or in a range, with totals by leave type. For employees only their own requests.',
      { date: { type: 'string', description: 'Single date YYYY-MM-DD (e.g. today)' }, from: P.from, to: P.to, departmentName: P.departmentName,
        status: { type: 'string', enum: ['approved', 'pending'] } }),
    args: z.object({ date: date.optional(), from: date.optional(), to: date.optional(), departmentName: z.string().optional(), status: z.enum(['approved', 'pending']).optional() }),
    async run(a, actor) {
      const from = a.date || a.from || todayLocal();
      const to = a.date || a.to || from;
      const dept = actor.role === 'employee' ? null : await resolveDepartment(a.departmentName);
      const rows = await onLeave({ from, to, departmentId: dept?.id, employeeId: actor.role === 'employee' ? actor.employeeId : null, status: a.status || 'approved' });
      const byType = {};
      for (const r of rows) byType[r.leaveType] = (byType[r.leaveType] || 0) + 1;
      return { from, to, status: a.status || 'approved', count: rows.length, byType,
        people: rows.map((r) => ({ name: r.fullName, department: r.departmentName, type: r.leaveType, start: r.startDate, end: r.endDate, days: r.days })) };
    },
  },
  {
    roles: ['hr', 'employee'],
    schema: fn('get_my_leave_balance', "The current user's own leave balance per type: quota, approved, pending, remaining.",
      { year: { type: 'integer' }, leaveType: { type: 'string', description: 'e.g. Sick, Casual, Annual' } }),
    args: z.object({ year: z.number().int().optional(), leaveType: z.string().optional() }),
    async run(a, actor) {
      const rows = await leaveBalances(actor.employeeId, a.year || Number(todayLocal().slice(0, 4)));
      const filtered = a.leaveType ? rows.filter((r) => r.name.toLowerCase().includes(a.leaveType.toLowerCase()) || r.code.toLowerCase() === a.leaveType.toLowerCase()) : rows;
      return { year: a.year || Number(todayLocal().slice(0, 4)),
        balances: filtered.map((r) => ({ type: r.name, quota: r.quota ?? 'unlimited', approvedTaken: r.approved, pending: r.pending, remaining: r.remaining ?? 'unlimited' })) };
    },
  },
  {
    roles: ['admin', 'hr', 'employee'],
    schema: fn('get_payroll_summary', 'Payroll totals for a month (Admin/HR: totals, average gross by department, run status). Employees: only their own finalized payslips.',
      { month: { type: 'string', description: 'YYYY-MM' }, departmentName: P.departmentName }),
    args: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), departmentName: z.string().optional() }),
    async run(a, actor) {
      if (actor.role === 'employee') {
        return { myPayslips: await db.query(
          `select to_char(r.period_month,'YYYY-MM') as month, p.gross, p.deduction_amount, p.tax, p.net_pay from payslips p
           join payroll_runs r on r.id = p.payroll_run_id where p.employee_id = $1 and r.status = 'finalized'
             and ($2::text is null or to_char(r.period_month,'YYYY-MM') = $2) order by r.period_month desc limit 6`, [actor.employeeId, a.month ?? null]) };
      }
      const dept = await resolveDepartment(a.departmentName);
      const runs = await db.query(
        `select to_char(period_month,'YYYY-MM') as month, status, employee_count, total_gross, total_deductions, total_tax, total_net
         from payroll_runs where ($1::text is null or to_char(period_month,'YYYY-MM') = $1) order by period_month desc limit 6`, [a.month ?? null]);
      const cost = (await analytics.payrollCost({ departmentId: dept?.id, months: 12 })).filter((c) => !a.month || c.month === a.month);
      return { runs, costByDepartment: cost, averageSalary: await analytics.averageSalary({ departmentId: dept?.id }) };
    },
  },
  {
    roles: ['admin', 'hr', 'employee'],
    schema: fn('search_employees', 'Find employees by name, code, department or status (no salary data). Employees can only find themselves.',
      { query: { type: 'string' }, departmentName: P.departmentName, status: { type: 'string', enum: ['probation', 'active', 'resigned', 'terminated'] } }),
    args: z.object({ query: z.string().optional(), departmentName: z.string().optional(), status: z.enum(['probation', 'active', 'resigned', 'terminated']).optional() }),
    async run(a, actor) {
      const dept = actor.role === 'employee' ? null : await resolveDepartment(a.departmentName);
      const { items, total } = await listEmployees(actor, { q: actor.role === 'employee' ? undefined : a.query, departmentId: dept?.id, status: a.status, pageSize: 25 });
      return { total, employees: items.map((e) => ({ name: e.fullName, code: e.employeeCode, department: e.departmentName, designation: e.designationTitle, status: e.status, joinDate: e.joinDate })) };
    },
  },
  {
    roles: ['hr', 'employee'],
    schema: fn('draft_leave_request', 'Prepare (NOT submit) a leave request for the current user from their plain-language message. The user must confirm the pre-filled form.',
      { type: { type: 'string', description: 'Leave type code: CASUAL (weddings, family events, personal), SICK (illness, doctor), ANNUAL (vacation, trip), UNPAID (without pay)' },
        start: { type: 'string', description: 'YYYY-MM-DD' }, end: { type: 'string', description: 'YYYY-MM-DD' }, reason: { type: 'string' } },
      ['type', 'start', 'end']),
    args: z.object({ type: z.string(), start: date, end: date, reason: z.string().optional() }),
    async run(a, actor) {
      return buildLeaveDraft(actor, a);
    },
  },
];

export async function buildLeaveDraft(actor, { type, start, end, reason }) {
  const lt = await db.one(
    'select id, name, code from leave_types where is_active and (lower(code) = lower($1) or lower(name) = lower($1)) limit 1', [type.trim()]);
  if (!lt) return { error: `Unknown leave type '${type}'` };
  if (end < start) return { error: 'End date is before start date' };
  if (start < todayLocal()) return { error: 'Leave cannot start in the past' };
  const preview = await previewLeave(actor.employeeId, { leaveTypeId: lt.id, startDate: start, endDate: end });
  return { draft: { type: lt.code, leaveTypeId: lt.id, leaveTypeName: lt.name, start, end, reason: reason || '', workingDays: preview.workingDays,
    available: preview.available, ok: preview.ok, problems: preview.problems } };
}

export const toolsFor = (role) => TOOLS.filter((t) => t.roles.includes(role));
