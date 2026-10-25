import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { db, tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { hashPassword, tempPassword } from '../lib/password.js';
import { forbidden, notFound, unprocessable } from '../lib/errors.js';
import { todayLocal } from '../lib/time.js';
import { containsPattern, csvSafeRows } from '../lib/text.js';
import { protect, requireEmployee, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';
import {
  assertCanSeeEmployee, createEmployeeWithLogin, currentSalary, employeeFields, getEmployee, listEmployees, updateEmployee,
} from './employees.service.js';
import { leaveBalances } from './leave.service.js';

const router = Router();
const idParam = z.object({ id: z.string().uuid() });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// ---------------- Users / logins (Admin) ----------------
router.get('/users', ...protect, requireRole('admin'), h(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.role) { params.push(req.query.role); where.push(`u.role = $${params.length}`); }
  if (req.query.q) { params.push(containsPattern(req.query.q)); where.push(`(u.full_name ilike $${params.length} or u.email ilike $${params.length})`); }
  res.json(await db.query(
    `select u.id, u.email, u.role, u.full_name, u.is_active, u.must_change_password, u.last_login_at, u.created_at,
            e.id as employee_id, e.employee_code
     from users u left join employees e on e.user_id = u.id ${where.length ? `where ${where.join(' and ')}` : ''}
     order by u.created_at desc`, params));
}));

// Admin creates HR logins. HR are also employees (they check in, take leave, get payslips).
router.post('/users', ...protect, requireRole('admin'),
  validate({ body: employeeFields.extend({ role: z.string(), basicSalary: z.coerce.number().positive().optional() }) }),
  h(async (req, res) => {
    if (req.body.role !== 'hr') throw unprocessable('ROLE_NOT_ALLOWED', 'Admin can only create HR logins here; HR registers employees');
    const result = await tx((q) => createEmployeeWithLogin(q, req.body, { role: 'hr', actor: req.user, req }));
    res.status(201).json(result);
  }));

async function setActive(req, res, isActive) {
  if (req.params.id === req.user.id) throw unprocessable('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own login');
  const before = await db.one('select id, email, role, full_name, is_active from users where id = $1', [req.params.id]);
  if (!before) throw notFound('User not found');
  const after = await db.one('update users set is_active = $1, updated_at = now() where id = $2 returning id, email, role, full_name, is_active', [isActive, req.params.id]);
  await audit({ actor: req.user, action: isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', entityType: 'user', entityId: after.id, before, after, req });
  res.json(after);
}
router.post('/users/:id/deactivate', ...protect, requireRole('admin'), validate({ params: idParam }), h((req, res) => setActive(req, res, false)));
router.post('/users/:id/reactivate', ...protect, requireRole('admin'), validate({ params: idParam }), h((req, res) => setActive(req, res, true)));

router.post('/users/:id/reset-password', ...protect, requireRole('admin'), validate({ params: idParam }), h(async (req, res) => {
  const user = await db.one('select id, role from users where id = $1', [req.params.id]);
  if (!user) throw notFound('User not found');
  const password = tempPassword();
  await db.query('update users set password_hash = $1, must_change_password = true, updated_at = now() where id = $2', [await hashPassword(password), user.id]);
  await audit({ actor: req.user, action: 'PASSWORD_RESET', entityType: 'user', entityId: user.id, req });
  await notify([user.id], { type: 'PASSWORD_RESET', title: 'Your password was reset by Admin', body: 'Please set a new password.' });
  res.json({ tempPassword: password });
}));

// ---------------- Employees ----------------
const listQuery = z.object({
  q: z.string().optional(), departmentId: z.string().uuid().optional(), designationId: z.string().uuid().optional(),
  status: z.enum(['probation', 'active', 'resigned', 'terminated']).optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  sort: z.enum(['name', 'code', 'joinDate']).optional(), order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/employees', ...protect, validate({ query: listQuery }), h(async (req, res) => res.json(await listEmployees(req.user, req.query))));

router.get('/employees/next-code', ...protect, requireRole('hr'), h(async (_req, res) => {
  const row = await db.one(
    "select coalesce(max((substring(employee_code from '(\\d+)$'))::int), 0) + 1 as n from employees where employee_code ~* '^EMP-\\d+$'");
  res.json({ code: `EMP-${String(row.n).padStart(3, '0')}` });
}));

router.post('/employees', ...protect, requireRole('hr'), validate({ body: employeeFields }), h(async (req, res) => {
  const result = await tx((q) => createEmployeeWithLogin(q, req.body, { role: 'employee', actor: req.user, req }));
  res.status(201).json(result);
}));

router.get('/employees/me', ...protect, requireEmployee, h(async (req, res) => res.json(await getEmployee(req.user, req.user.employeeId))));

// Employees may only edit their own phone and address.
router.patch('/employees/me', ...protect, requireEmployee, h(async (req, res) => {
  const extra = Object.keys(req.body || {}).filter((k) => !['phone', 'address'].includes(k));
  if (extra.length) throw unprocessable('FIELD_NOT_EDITABLE', `You can only edit phone and address (not ${extra.join(', ')})`);
  const body = z.object({ phone: z.string().trim().max(30).nullable().optional(), address: z.string().trim().max(300).nullable().optional() }).parse(req.body);
  const after = await tx((q) => updateEmployee(q, req.user.employeeId, body, { actor: req.user, req }));
  res.json(after);
}));

// CSV ---------------------------------------------------------
const CSV_COLUMNS = ['employee_code', 'full_name', 'email', 'phone', 'gender', 'department', 'designation', 'employment_type', 'join_date', 'basic_salary', 'address'];

router.get('/employees/import/template', ...protect, requireRole('hr'), (_req, res) => {
  res.type('text/csv').attachment('employees-template.csv').send(`${CSV_COLUMNS.join(',')}\n`);
});

router.get('/employees/export.csv', ...protect, requireRole('hr'), validate({ query: listQuery }), h(async (req, res) => {
  const { items } = await listEmployees(req.user, { ...req.query, page: 1, pageSize: 100000 });
  const rows = items.map((e) => [e.employeeCode, e.fullName, e.email, e.phone ?? '', e.gender ?? '', e.departmentName,
    e.designationTitle ?? '', e.employmentType, e.joinDate, e.status]);
  res.type('text/csv').attachment(`employees-${todayLocal()}.csv`)
    .send(stringify([['employee_code', 'full_name', 'email', 'phone', 'gender', 'department', 'designation', 'employment_type', 'join_date', 'status'], ...csvSafeRows(rows)]));
}));

// Dry run returns every problem as { row, field, reason }; commit is all-or-nothing.
async function validateCsv(buffer) {
  let records;
  try {
    records = parse(buffer, { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    throw unprocessable('BAD_CSV', `Could not read CSV: ${e.message}`);
  }
  if (records.length > 500) throw unprocessable('TOO_MANY_ROWS', 'Maximum 500 rows per import');
  const departments = await db.query('select id, name, code from departments where is_active');
  const designations = await db.query('select id, title from designations');
  const existing = await db.query('select lower(employee_code) as code, lower(email) as email from employees');
  const codes = new Set(existing.map((e) => e.code));
  const emails = new Set((await db.query('select lower(email) as email from users')).map((u) => u.email));
  const errors = [];
  const valid = [];
  records.forEach((r, i) => {
    const row = i + 2; // header is row 1
    const err = (field, reason) => errors.push({ row, field, reason });
    const before = errors.length;
    for (const f of ['employee_code', 'full_name', 'email', 'department', 'join_date', 'basic_salary']) {
      if (!r[f]) err(f, 'Required');
    }
    if (r.email && !z.string().email().safeParse(r.email).success) err('email', 'Invalid email');
    const code = (r.employee_code || '').toLowerCase();
    const email = (r.email || '').toLowerCase();
    if (code && codes.has(code)) err('employee_code', 'Duplicate code');
    if (email && emails.has(email)) err('email', 'Duplicate email');
    const dept = departments.find((d) => [d.name.toLowerCase(), d.code.toLowerCase()].includes((r.department || '').toLowerCase()));
    if (r.department && !dept) err('department', `Unknown department '${r.department}'`);
    const desig = r.designation ? designations.find((d) => d.title.toLowerCase() === r.designation.toLowerCase()) : null;
    if (r.designation && !desig) err('designation', `Unknown designation '${r.designation}'`);
    if (r.join_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.join_date) || (r.join_date && Number.isNaN(Date.parse(r.join_date)))) err('join_date', 'Use ISO date YYYY-MM-DD');
    const salary = Number(r.basic_salary);
    if (r.basic_salary && !(salary > 0)) err('basic_salary', 'Salary must be a number greater than 0');
    if (r.gender && !['male', 'female', 'other'].includes(r.gender.toLowerCase())) err('gender', 'Use male, female or other');
    const type = (r.employment_type || 'full_time').toLowerCase();
    if (!['full_time', 'part_time', 'contract', 'intern'].includes(type)) err('employment_type', 'Use full_time, part_time, contract or intern');
    if (code) codes.add(code);
    if (email) emails.add(email);
    if (errors.length === before) {
      valid.push({
        employeeCode: r.employee_code, fullName: r.full_name, email, phone: r.phone || null, address: r.address || null,
        gender: r.gender ? r.gender.toLowerCase() : null, departmentId: dept.id, designationId: desig?.id ?? null,
        employmentType: type, status: 'probation', joinDate: r.join_date, basicSalary: salary,
      });
    }
  });
  return { totalRows: records.length, validRows: valid.length, errors, valid };
}

router.post('/employees/import', ...protect, requireRole('hr'), upload.single('file'), h(async (req, res) => {
  if (!req.file) throw unprocessable('FILE_REQUIRED', 'Upload a CSV file in the "file" field');
  const dryRun = req.query.dryRun !== 'false';
  const { totalRows, validRows, errors, valid } = await validateCsv(req.file.buffer);
  if (dryRun) return res.json({ dryRun: true, totalRows, validRows, errors });
  if (errors.length || !valid.length) throw unprocessable('IMPORT_HAS_ERRORS', 'Fix all errors before importing', errors);
  const created = await tx(async (q) => {
    const out = [];
    for (const data of valid) {
      const r = await createEmployeeWithLogin(q, data, { role: 'employee', actor: req.user, req });
      out.push([r.employee.employeeCode, r.employee.email, r.tempPassword]);
    }
    await audit({ q, actor: req.user, action: 'EMPLOYEE_IMPORTED', entityType: 'employee', after: { count: out.length }, req });
    return out;
  });
  res.status(201).json({ created: created.length, credentialsCsv: stringify([['employee_code', 'email', 'temp_password'], ...csvSafeRows(created)]) });
}));

// Single employee ---------------------------------------------
router.get('/employees/:id', ...protect, validate({ params: idParam }), h(async (req, res) => res.json(await getEmployee(req.user, req.params.id))));

const updateSchema = employeeFields.omit({ basicSalary: true }).partial().extend({
  status: z.enum(['probation', 'active', 'resigned', 'terminated']).optional(),
  exitDate: z.string().date().nullable().optional(),
  exitReason: z.string().max(300).nullable().optional(),
});

router.put('/employees/:id', ...protect, requireRole('hr'), validate({ params: idParam, body: updateSchema }), h(async (req, res) => {
  if (['resigned', 'terminated'].includes(req.body.status) && !req.body.exitDate) {
    throw unprocessable('EXIT_DATE_REQUIRED', 'Exit date is required for resigned/terminated', [{ field: 'exitDate', reason: 'Required' }]);
  }
  res.json(await tx((q) => updateEmployee(q, req.params.id, req.body, { actor: req.user, req })));
}));

// Employee 360: everything about one person on one page.
router.get('/employees/:id/360', ...protect, validate({ params: idParam }), h(async (req, res) => {
  const id = req.params.id;
  const profile = await getEmployee(req.user, id);
  const today = todayLocal();
  const month = today.slice(0, 7);
  const [attendance] = await db.query(
    `select count(*) filter (where status = 'present')::int as present, count(*) filter (where status = 'late')::int as late,
            count(*) filter (where status = 'half_day')::int as half_day, count(*) filter (where status = 'absent')::int as absent,
            count(*) filter (where status = 'on_leave')::int as on_leave, count(*) filter (where status = 'missing_checkout')::int as missing_checkout
     from fn_daily_status($1::date, $2::date, null, $3) where is_working_day`, [`${month}-01`, today, id]);
  const isStaff = req.user.role !== 'employee';
  const payslipFilter = isStaff ? '' : "and r.status = 'finalized'";
  const [leaves, payslips, corrections, salaryHistory, timeline] = await Promise.all([
    db.query(`select l.*, t.name as leave_type_name from leave_requests l join leave_types t on t.id = l.leave_type_id
              where l.employee_id = $1 order by l.created_at desc limit 10`, [id]),
    db.query(`select p.id, r.period_month, r.status as run_status, p.gross, p.net_pay from payslips p join payroll_runs r on r.id = p.payroll_run_id
              where p.employee_id = $1 ${payslipFilter} order by r.period_month desc limit 12`, [id]),
    db.query('select * from attendance_corrections where employee_id = $1 order by created_at desc limit 10', [id]),
    isStaff ? db.query('select * from salary_structures where employee_id = $1 order by effective_from desc', [id]) : [],
    req.user.role === 'admin'
      ? db.query("select id, action, actor_name, created_at from audit_logs where entity_type = 'employee' and entity_id = $1 order by created_at desc limit 20", [id])
      : [],
  ]);
  res.json({
    profile, attendanceThisMonth: attendance, leaveBalances: await leaveBalances(id, Number(today.slice(0, 4))),
    recentLeaves: leaves, payslips, corrections, salaryHistory, timeline,
  });
}));

// Salary structure (HR manage, Admin view). Gross = 1.5 x basic is computed by the DB.
router.get('/employees/:id/salary', ...protect, requireRole('admin', 'hr'), validate({ params: idParam }), h(async (req, res) => {
  res.json({
    current: await currentSalary(req.params.id),
    history: await db.query('select * from salary_structures where employee_id = $1 order by effective_from desc', [req.params.id]),
  });
}));

router.post('/employees/:id/salary', ...protect, requireRole('hr'),
  validate({ params: idParam, body: z.object({ basic: z.coerce.number().positive('Salary must be greater than 0'), effectiveFrom: z.string().date() }) }),
  h(async (req, res) => {
    assertCanSeeEmployee(req.user, req.params.id);
    if (req.user.employeeId === req.params.id) throw forbidden('You cannot change your own salary');
    const before = await currentSalary(req.params.id);
    const row = await db.one(
      `insert into salary_structures (employee_id, basic, effective_from, created_by) values ($1,$2,$3,$4)
       on conflict (employee_id, effective_from) do update set basic = excluded.basic returning *`,
      [req.params.id, req.body.basic, req.body.effectiveFrom, req.user.id]);
    await audit({ actor: req.user, action: 'SALARY_CHANGED', entityType: 'employee', entityId: req.params.id, before, after: row, req });
    res.status(201).json(row);
  }));

export default router;
