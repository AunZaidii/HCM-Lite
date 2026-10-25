import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { hashPassword, tempPassword } from '../lib/password.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { todayLocal } from '../lib/time.js';
import { containsPattern } from '../lib/text.js';

export const employeeFields = z.object({
  employeeCode: z.string().trim().min(1).max(20),
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  dateOfBirth: z.string().date().optional().nullable(),
  departmentId: z.string().uuid(),
  designationId: z.string().uuid().optional().nullable(),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).default('full_time'),
  status: z.enum(['probation', 'active']).default('probation'),
  joinDate: z.string().date(),
  basicSalary: z.coerce.number().positive('Salary must be greater than 0'),
});

const COLUMNS = {
  employeeCode: 'employee_code', fullName: 'full_name', email: 'email', phone: 'phone', address: 'address',
  gender: 'gender', dateOfBirth: 'date_of_birth', departmentId: 'department_id', designationId: 'designation_id',
  employmentType: 'employment_type', status: 'status', joinDate: 'join_date', exitDate: 'exit_date', exitReason: 'exit_reason',
};

// Creates the login (temporary password, must change), the employee profile and the first salary structure.
// Used by HR registration, Admin "create HR login" and CSV import. Must run inside tx().
export async function createEmployeeWithLogin(q, data, { role = 'employee', actor, req }) {
  const department = await q.one('select id from departments where id = $1 and is_active', [data.departmentId]);
  if (!department) throw unprocessable('UNKNOWN_DEPARTMENT', 'Department not found', [{ field: 'departmentId', reason: 'Unknown department' }]);
  if (await q.one('select 1 as ok from users where email = $1', [data.email])) {
    throw conflict('DUPLICATE_EMAIL', `Email ${data.email} is already registered`);
  }
  if (await q.one('select 1 as ok from employees where employee_code = $1', [data.employeeCode])) {
    throw conflict('DUPLICATE_CODE', `Employee code ${data.employeeCode} already exists`);
  }
  const password = tempPassword();
  const user = await q.one(
    `insert into users (email, password_hash, role, full_name, must_change_password, created_by)
     values ($1,$2,$3,$4,true,$5) returning id, email, role, full_name`,
    [data.email, await hashPassword(password), role, data.fullName, actor.id],
  );
  const employee = await q.one(
    `insert into employees (user_id, employee_code, full_name, email, phone, address, gender, date_of_birth, department_id,
       designation_id, employment_type, status, join_date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [user.id, data.employeeCode, data.fullName, data.email, data.phone ?? null, data.address ?? null, data.gender ?? null,
      data.dateOfBirth ?? null, data.departmentId, data.designationId ?? null, data.employmentType ?? 'full_time',
      data.status ?? 'probation', data.joinDate, actor.id],
  );
  if (data.basicSalary) {
    await q.query(
      'insert into salary_structures (employee_id, basic, effective_from, created_by) values ($1,$2,$3,$4)',
      [employee.id, data.basicSalary, data.joinDate, actor.id],
    );
  }
  await audit({ q, actor, action: role === 'hr' ? 'USER_CREATED' : 'EMPLOYEE_CREATED', entityType: 'employee', entityId: employee.id,
    after: { ...employee, role, basicSalary: data.basicSalary }, req });
  return { user, employee, tempPassword: password };
}

export async function updateEmployee(q, id, patch, { actor, req }) {
  const before = await q.one('select * from employees where id = $1', [id]);
  if (!before) throw notFound('Employee not found');
  const keys = Object.keys(patch).filter((k) => COLUMNS[k]);
  if (!keys.length) return before;
  const after = await q.one(
    `update employees set ${keys.map((k, i) => `${COLUMNS[k]} = $${i + 1}`).join(', ')}, updated_at = now()
     where id = $${keys.length + 1} returning *`,
    [...keys.map((k) => patch[k] ?? null), id],
  );
  if (patch.email && patch.email !== before.email) {
    await q.query('update users set email = $1 where id = $2', [patch.email, before.userId]);
  }
  if (patch.fullName) await q.query('update users set full_name = $1 where id = $2', [patch.fullName, before.userId]);
  // A leaver loses access once their exit date has passed.
  if (['resigned', 'terminated'].includes(after.status) && after.exitDate && after.exitDate <= todayLocal()) {
    await q.query('update users set is_active = false where id = $1', [before.userId]);
  }
  await audit({ q, actor, action: 'EMPLOYEE_UPDATED', entityType: 'employee', entityId: id, before, after, req });
  return after;
}

const SORTS = { name: 'e.full_name', code: 'e.employee_code', joinDate: 'e.join_date' };

// Directory with server-side search, filters and paging. Employees only ever see themselves.
export async function listEmployees(actor, f = {}) {
  const params = [];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (actor.role === 'employee') add('e.id = ?', actor.employeeId);
  if (f.q) add("(e.full_name ilike ? or e.employee_code ilike $X or e.email ilike $X)".replace(/\$X/g, `$${params.length + 1}`), containsPattern(f.q));
  if (f.departmentId) add('e.department_id = ?', f.departmentId);
  if (f.designationId) add('e.designation_id = ?', f.designationId);
  if (f.status) add('e.status = ?', f.status);
  if (f.employmentType) add('e.employment_type = ?', f.employmentType);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 20));
  const order = `${SORTS[f.sort] || 'e.full_name'} ${f.order === 'desc' ? 'desc' : 'asc'}`;
  const base = `from employees e join departments d on d.id = e.department_id
                left join designations g on g.id = e.designation_id join users u on u.id = e.user_id ${whereSql}`;
  const [{ total }] = await db.query(`select count(*)::int as total ${base}`, params);
  const items = await db.query(
    `select e.id, e.employee_code, e.full_name, e.email, e.phone, e.gender, e.status, e.employment_type, e.join_date, e.exit_date,
            e.department_id, d.name as department_name, e.designation_id, g.title as designation_title, u.role, u.is_active
     ${base} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  return { items, total, page, pageSize };
}

export function assertCanSeeEmployee(actor, employeeId) {
  if (actor.role === 'employee' && actor.employeeId !== employeeId) throw forbidden('You can only view your own profile');
}

export async function getEmployee(actor, id) {
  assertCanSeeEmployee(actor, id);
  const emp = await db.one(
    `select e.*, d.name as department_name, g.title as designation_title, u.role, u.is_active, u.last_login_at
     from employees e join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
     join users u on u.id = e.user_id where e.id = $1`, [id]);
  if (!emp) throw notFound('Employee not found');
  if (actor.role !== 'employee') emp.salary = await currentSalary(id);
  return emp;
}

export async function currentSalary(employeeId, onDate = todayLocal()) {
  return (await db.one(
    `select * from salary_structures where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1`,
    [employeeId, onDate],
  )) ?? (await db.one('select * from salary_structures where employee_id = $1 order by effective_from limit 1', [employeeId]));
}
