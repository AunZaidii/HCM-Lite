// End-to-end API tests: first run, roles and data scope ("Cannot" lists), business rules, payroll lock,
// audit log, CSV dry run, and AI guardrails. Runs against the throwaway hcm_test schema (see vitest.config.js).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { applySchema, pool } from '../scripts/schema.js';
import { app } from '../src/app.js';
import { db } from '../src/lib/db.js';
import { addDays, isoWeekday, todayLocal } from '../src/lib/time.js';
import { toolsFor } from '../src/modules/ai/tools.js';

const api = request(app);
const as = (token) => ({
  get: (url) => api.get(`/api${url}`).set('Authorization', `Bearer ${token}`),
  post: (url, body) => api.post(`/api${url}`).set('Authorization', `Bearer ${token}`).send(body),
  put: (url, body) => api.put(`/api${url}`).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url, body) => api.patch(`/api${url}`).set('Authorization', `Bearer ${token}`).send(body),
});

const today = todayLocal();
const nextMonday = (() => { let d = addDays(today, 1); while (isoWeekday(d) !== 1) d = addDays(d, 1); return d; })();
const month = today.slice(0, 7);

const S = {}; // shared state across the ordered tests

async function login(email, password) {
  const res = await api.post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token;
}

async function firstLogin(email, tempPassword, newPassword) {
  const t = await login(email, tempPassword);
  const res = await as(t).post('/auth/change-password', { currentPassword: tempPassword, newPassword });
  expect(res.status).toBe(200);
  return res.body.token;
}

beforeAll(async () => {
  await applySchema({ reset: true });
});

afterAll(async () => {
  await pool.end();
});

describe('M1 first run and auth', () => {
  it('starts empty and requires setup', async () => {
    expect((await api.get('/api/setup/status')).body.setupComplete).toBe(false);
    expect((await api.post('/api/auth/login').send({ email: 'a@b.co', password: 'x' })).status).toBe(409);
  });

  it('validates setup input', async () => {
    const res = await api.post('/api/setup').send({ companyName: 'X', admin: { fullName: 'A', email: 'bad', password: 'short' } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['companyName', 'admin.email', 'admin.password']));
  });

  it('creates company + Admin once (second setup = 409)', async () => {
    const res = await api.post('/api/setup').send({ companyName: 'Test Co', admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'Admin1234' } });
    expect(res.status).toBe(201);
    S.admin = res.body.token;
    const again = await api.post('/api/setup').send({ companyName: 'Other', admin: { fullName: 'Bob', email: 'b@test.co', password: 'Admin1234' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SETUP_ALREADY_DONE');
  });

  it('stores bcrypt hashes, never plain passwords', async () => {
    const u = await db.one("select password_hash from users where email = 'admin@test.co'");
    expect(u.passwordHash).toMatch(/^\$2[aby]\$10\$/);
  });

  it('rejects wrong credentials and missing tokens', async () => {
    expect((await api.post('/api/auth/login').send({ email: 'admin@test.co', password: 'nope1234' })).status).toBe(401);
    expect((await api.get('/api/employees')).status).toBe(401);
  });
});

describe('M2 organization setup', () => {
  it('Admin configures departments, designations, leave types, holidays, settings', async () => {
    const A = as(S.admin);
    S.eng = (await A.post('/departments', { name: 'Engineering', code: 'ENG' })).body;
    S.sales = (await A.post('/departments', { name: 'Sales', code: 'SAL' })).body;
    expect(S.eng.id).toBeTruthy();
    expect((await A.post('/departments', { name: 'engineering', code: 'X' })).status).toBe(409);
    S.dev = (await A.post('/designations', { title: 'Developer', departmentId: S.eng.id })).body;
    const std = await A.post('/leave-types/standard');
    expect(std.status).toBe(201);
    expect(std.body.map((t) => [t.code, t.yearlyQuota])).toEqual(expect.arrayContaining([['ANNUAL', 14], ['SICK', 8], ['CASUAL', 10], ['UNPAID', null]]));
    S.types = Object.fromEntries(std.body.map((t) => [t.code, t.id]));
    expect((await A.put('/settings', { officeLat: 24.8607, officeLng: 67.0011, officeRadiusM: 150, cameraCheckinEnabled: true })).status).toBe(200);
  });

  it('Admin creates an HR login (temporary password); Admin role cannot be created', async () => {
    const A = as(S.admin);
    const hr = await A.post('/users', { role: 'hr', employeeCode: 'HR-001', fullName: 'Hina HR', email: 'hr@test.co', departmentId: S.eng.id, joinDate: '2026-01-01', basicSalary: 100000, status: 'active' });
    expect(hr.status).toBe(201);
    expect(hr.body.tempPassword).toHaveLength(12);
    S.hrEmp = hr.body.employee;
    expect((await A.post('/users', { role: 'admin', employeeCode: 'A2', fullName: 'Evil', email: 'evil@test.co', departmentId: S.eng.id, joinDate: '2026-01-01', basicSalary: 1 })).status).toBe(422);
    // Temporary password must be changed before anything else.
    const t = await login('hr@test.co', hr.body.tempPassword);
    const blocked = await as(t).get('/employees');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    S.hr = (await as(t).post('/auth/change-password', { currentPassword: hr.body.tempPassword, newPassword: 'Hrpass123' })).body.token;
  });

  it('HR cannot change settings, create logins, or view the audit log', async () => {
    const H = as(S.hr);
    expect((await H.put('/settings', { graceMinutes: 30 })).status).toBe(403);
    expect((await H.post('/departments', { name: 'Ops', code: 'OPS' })).status).toBe(403);
    expect((await H.post('/users', {})).status).toBe(403);
    expect((await H.get('/audit')).status).toBe(403);
    expect((await H.get('/settings')).status).toBe(200); // view only
  });
});

describe('M3 employees', () => {
  it('HR registers employees (creates logins) with validation and uniqueness', async () => {
    const H = as(S.hr);
    expect((await H.get('/employees/next-code')).body.code).toBe('EMP-001');
    const ali = await H.post('/employees', { employeeCode: 'EMP-001', fullName: 'Ali Khan', email: 'ali@test.co', departmentId: S.eng.id, designationId: S.dev.id, joinDate: '2026-01-15', basicSalary: 40000, gender: 'male' });
    expect(ali.status).toBe(201);
    S.ali = ali.body.employee;
    S.aliToken = await firstLogin('ali@test.co', ali.body.tempPassword, 'Alipass123');
    const sara = await H.post('/employees', { employeeCode: 'EMP-002', fullName: 'Sara Ahmed', email: 'sara@test.co', departmentId: S.sales.id, joinDate: '2026-02-01', basicSalary: 60000, gender: 'female', status: 'active' });
    S.sara = sara.body.employee;
    S.saraToken = await firstLogin('sara@test.co', sara.body.tempPassword, 'Sarapass123');
    expect((await H.post('/employees', { employeeCode: 'EMP-001', fullName: 'Dup', email: 'dup@test.co', departmentId: S.eng.id, joinDate: '2026-01-01', basicSalary: 1 })).status).toBe(409);
    const bad = await H.post('/employees', { employeeCode: 'E9', fullName: 'Bad', email: 'not-an-email', departmentId: S.eng.id, joinDate: '01/01/2026', basicSalary: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['email', 'joinDate', 'basicSalary']));
  });

  it('directory supports server-side search, filters and paging', async () => {
    const H = as(S.hr);
    const res = await H.get(`/employees?q=sara&departmentId=${S.sales.id}&page=1&pageSize=1`);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].fullName).toBe('Sara Ahmed');
    expect((await H.get('/employees?pageSize=1')).body.items).toHaveLength(1);
  });

  it("employees only see themselves and edit only phone/address", async () => {
    const E = as(S.aliToken);
    const list = await E.get('/employees');
    expect(list.body.items.map((e) => e.id)).toEqual([S.ali.id]);
    expect((await E.get(`/employees/${S.sara.id}`)).status).toBe(403);
    expect((await E.get(`/employees/${S.sara.id}/360`)).status).toBe(403);
    expect((await E.get(`/employees/${S.sara.id}/salary`)).status).toBe(403);
    expect((await E.patch('/employees/me', { basicSalary: 999999 })).status).toBe(422);
    expect((await E.patch('/employees/me', { role: 'admin' })).status).toBe(422);
    expect((await E.patch('/employees/me', { phone: '0300-1112223', address: 'Karachi' })).body.phone).toBe('0300-1112223');
    expect((await E.get(`/employees/${S.ali.id}`)).body.salary).toBeUndefined();
  });

  it('salary structure: gross = 1.5 x basic (HR manages, Admin views, nobody edits own)', async () => {
    const sal = await as(S.admin).get(`/employees/${S.ali.id}/salary`);
    expect(sal.body.current).toMatchObject({ basic: 40000, hra: 16000, medical: 4000, gross: 60000 });
    expect((await as(S.admin).post(`/employees/${S.ali.id}/salary`, { basic: 1, effectiveFrom: today })).status).toBe(403);
    expect((await as(S.hr).post(`/employees/${S.hrEmp.id}/salary`, { basic: 999999, effectiveFrom: today })).status).toBe(403);
  });

  it('CSV import dry run reports row + field + reason and writes nothing', async () => {
    const csv = [
      'employee_code,full_name,email,phone,gender,department,designation,employment_type,join_date,basic_salary,address',
      'EMP-010,Good Row,good@test.co,,male,ENG,Developer,full_time,2026-03-01,50000,',
      'EMP-011,Bad Email,bad-email,,male,ENG,,full_time,2026-03-01,50000,',
      'EMP-012,Unknown Dept,u@test.co,,male,Marketing,,full_time,2026-03-01,50000,',
      'EMP-001,Dup Code,d@test.co,,male,ENG,,full_time,2026/03/01,0,',
    ].join('\n');
    const res = await api.post('/api/employees/import?dryRun=true').set('Authorization', `Bearer ${S.hr}`).attach('file', Buffer.from(csv), 'e.csv');
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(4);
    expect(res.body.validRows).toBe(1);
    expect(res.body.errors).toEqual(expect.arrayContaining([
      { row: 3, field: 'email', reason: 'Invalid email' },
      { row: 4, field: 'department', reason: "Unknown department 'Marketing'" },
      { row: 5, field: 'employee_code', reason: 'Duplicate code' },
      { row: 5, field: 'join_date', reason: 'Use ISO date YYYY-MM-DD' },
      { row: 5, field: 'basic_salary', reason: 'Salary must be a number greater than 0' },
    ]));
    expect((await db.one("select count(*)::int as n from employees where email = 'good@test.co'")).n).toBe(0);
    const commit = await api.post('/api/employees/import?dryRun=false').set('Authorization', `Bearer ${S.hr}`).attach('file', Buffer.from(csv), 'e.csv');
    expect(commit.status).toBe(422); // all-or-nothing
  });
});

describe('M4 attendance', () => {
  it('server stamps check-in; second check-in = 409; check-out works', async () => {
    const E = as(S.aliToken);
    const first = await E.post('/attendance/check-in', { checkInAt: '2020-01-01T00:00:00Z' });
    expect(first.status).toBe(201);
    expect(Math.abs(new Date(first.body.checkInAt) - Date.now())).toBeLessThan(60_000); // client time ignored
    expect(first.body.ruleOfficeStart).toBe('09:00:00');
    const second = await E.post('/attendance/check-in');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_IN');
    const out = await E.post('/attendance/check-out');
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('half_day'); // worked under 5 h
    expect((await E.post('/attendance/check-out')).status).toBe(409);
  });

  it('Admin cannot check in (no employee profile); employees cannot view the board', async () => {
    expect((await as(S.admin).post('/attendance/check-in')).status).toBe(403);
    expect((await as(S.aliToken).get('/attendance/board')).status).toBe(403);
    expect((await as(S.aliToken).get(`/attendance/calendar?employeeId=${S.sara.id}`)).status).toBe(403);
  });

  it('camera check-in is decided by the server (faces, accuracy, distance)', async () => {
    const E = as(S.saraToken);
    const base = { lat: 24.8607, lng: 67.0011, accuracy: 20, faceCount: 1 };
    expect((await E.post('/attendance/camera-check-in', { ...base, faceCount: 0 })).body.error.code).toBe('NO_FACE');
    expect((await E.post('/attendance/camera-check-in', { ...base, faceCount: 2 })).body.error.code).toBe('MULTIPLE_FACES');
    expect((await E.post('/attendance/camera-check-in', { ...base, accuracy: 150 })).body.error.code).toBe('LOW_ACCURACY');
    expect((await E.post('/attendance/camera-check-in', { ...base, lat: 24.87 })).body.error.code).toBe('OUTSIDE_RADIUS');
    const ok = await E.post('/attendance/camera-check-in', base);
    expect(ok.status).toBe(201);
    expect(ok.body.source).toBe('camera');
    expect(ok.body.distanceM).toBeLessThanOrEqual(150);
    expect((await db.one('select count(*)::int as n from checkin_attempts')).n).toBe(4);
  });

  it('face match (bonus): enrolled descriptor + blink required when Admin enables it', async () => {
    const H = as(S.hr);
    const face = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10);
    const stranger = face.map((v) => v + 0.1);
    expect((await H.post('/attendance/face/enroll', { descriptor: face.slice(0, 10) })).status).toBe(400);
    expect((await H.post('/attendance/face/enroll', { descriptor: face })).status).toBe(204);
    expect((await H.get('/attendance/face')).body.enrolled).toBe(true);
    await as(S.admin).put('/settings', { faceMatchRequired: true });
    const base = { lat: 24.8607, lng: 67.0011, accuracy: 20, faceCount: 1 };
    expect((await H.post('/attendance/camera-check-in', { ...base, descriptor: stranger, livenessPassed: true })).body.error.code).toBe('FACE_MISMATCH');
    expect((await H.post('/attendance/camera-check-in', { ...base, descriptor: face, livenessPassed: false })).body.error.code).toBe('LIVENESS_FAILED');
    const ok = await H.post('/attendance/camera-check-in', { ...base, descriptor: face, livenessPassed: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ faceVerified: true, livenessPassed: true });
    expect(JSON.stringify(await db.query('select * from attendance where id = $1', [ok.body.id]))).not.toMatch(/photo|image/i);
    await as(S.admin).put('/settings', { faceMatchRequired: false });
  });

  it('correction: employee requests, HR approves, record updated and audited', async () => {
    const req = await as(S.aliToken).post('/attendance/corrections', { date: today, requestedCheckOut: '23:59', reason: 'Forgot to check out' });
    expect(req.status).toBe(201);
    expect((await as(S.aliToken).post(`/attendance/corrections/${req.body.id}/approve`, {})).status).toBe(403);
    const ok = await as(S.hr).post(`/attendance/corrections/${req.body.id}/approve`, { comment: 'ok' });
    expect(ok.body.status).toBe('approved');
    const rec = await db.one('select source from attendance where employee_id = $1 and work_date = $2', [S.ali.id, today]);
    expect(rec.source).toBe('correction');
  });
});

describe('M5 leave', () => {
  it('counts working days only and rejects overlap / over-balance with 422', async () => {
    const E = as(S.aliToken);
    const tue = addDays(nextMonday, 1);
    const preview = await E.post('/leave/preview', { leaveTypeId: S.types.CASUAL, startDate: addDays(nextMonday, -3), endDate: tue });
    expect(preview.body.workingDays).toBe(3); // Fri, Mon, Tue (weekend skipped)
    const ok = await E.post('/leave/requests', { leaveTypeId: S.types.CASUAL, startDate: nextMonday, endDate: tue, reason: "Sister's wedding" });
    expect(ok.status).toBe(201);
    expect(ok.body.days).toBe(2);
    S.aliLeave = ok.body;
    const overlap = await E.post('/leave/requests', { leaveTypeId: S.types.SICK, startDate: tue, endDate: tue });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
    const over = await E.post('/leave/requests', { leaveTypeId: S.types.SICK, startDate: addDays(nextMonday, 7), endDate: addDays(nextMonday, 20) });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('holidays are skipped', async () => {
    await as(S.admin).post('/holidays', { date: addDays(nextMonday, 9), name: 'Test holiday' }); // Wednesday of the following week
    const p = await as(S.saraToken).post('/leave/preview', { leaveTypeId: S.types.ANNUAL, startDate: addDays(nextMonday, 7), endDate: addDays(nextMonday, 11) });
    expect(p.body.workingDays).toBe(4);
  });

  it('only HR approves, with a comment to reject, never their own; balance updates', async () => {
    expect((await as(S.aliToken).post(`/leave/requests/${S.aliLeave.id}/approve`, {})).status).toBe(403);
    expect((await as(S.admin).post(`/leave/requests/${S.aliLeave.id}/approve`, {})).status).toBe(403);
    expect((await as(S.hr).post(`/leave/requests/${S.aliLeave.id}/reject`, {})).status).toBe(400);
    const ok = await as(S.hr).post(`/leave/requests/${S.aliLeave.id}/approve`, { comment: 'Enjoy' });
    expect(ok.body.status).toBe('approved');
    const casual = (await as(S.aliToken).get('/leave/balance')).body.find((b) => b.code === 'CASUAL');
    expect(casual).toMatchObject({ quota: 10, approved: 2, remaining: 8 });
    const hrOwn = await as(S.hr).post('/leave/requests', { leaveTypeId: S.types.ANNUAL, startDate: addDays(nextMonday, 14), endDate: addDays(nextMonday, 14) });
    const self = await as(S.hr).post(`/leave/requests/${hrOwn.body.id}/approve`, {});
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
  });

  it('cancelling future approved leave restores the balance', async () => {
    const extra = await as(S.saraToken).post('/leave/requests', { leaveTypeId: S.types.SICK, startDate: addDays(nextMonday, 21), endDate: addDays(nextMonday, 21) });
    await as(S.hr).post(`/leave/requests/${extra.body.id}/approve`, {});
    expect((await as(S.saraToken).get('/leave/balance')).body.find((b) => b.code === 'SICK').remaining).toBe(7);
    expect((await as(S.aliToken).post(`/leave/requests/${extra.body.id}/cancel`)).status).toBe(403);
    expect((await as(S.saraToken).post(`/leave/requests/${extra.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await as(S.saraToken).get('/leave/balance')).body.find((b) => b.code === 'SICK').remaining).toBe(8);
  });

  it('notifies the employee of the decision', async () => {
    const n = await as(S.aliToken).get('/notifications');
    expect(n.body.items.some((x) => x.type === 'LEAVE_DECIDED')).toBe(true);
  });
});

describe('M6 payroll', () => {
  it('HR creates the draft (one per month); employees cannot see draft payslips', async () => {
    const run = await as(S.hr).post('/payroll/runs', { month });
    expect(run.status).toBe(201);
    expect(run.body.employeeCount).toBe(3);
    S.run = run.body;
    expect((await as(S.hr).post('/payroll/runs', { month })).status).toBe(409);
    expect((await as(S.aliToken).get('/payroll/runs')).status).toBe(403);
    expect((await as(S.aliToken).get('/payslips')).body).toHaveLength(0);
    const detail = await as(S.admin).get(`/payroll/runs/${S.run.id}`);
    const p = detail.body.payslips.find((x) => x.employeeId === S.ali.id);
    expect(p).toMatchObject({ basic: 40000, hra: 16000, medical: 4000, gross: 60000, tax: 500 });
  });

  it('only Admin finalizes; finalized runs are locked (API 423 + DB trigger)', async () => {
    expect((await as(S.hr).post(`/payroll/runs/${S.run.id}/finalize`)).status).toBe(403);
    expect((await as(S.admin).post(`/payroll/runs/${S.run.id}/finalize`)).body.status).toBe('finalized');
    expect((await as(S.hr).post(`/payroll/runs/${S.run.id}/recalculate`)).status).toBe(423);
    expect((await as(S.admin).post(`/payroll/runs/${S.run.id}/finalize`)).status).toBe(423);
    await expect(db.query('update payslips set net_pay = 1 where payroll_run_id = $1', [S.run.id])).rejects.toThrow(/locked/);
    await expect(db.query('delete from payroll_runs where id = $1', [S.run.id])).rejects.toThrow(/locked/);
  });

  it('employees download only their own payslip PDF', async () => {
    const mine = await as(S.aliToken).get('/payslips');
    expect(mine.body).toHaveLength(1);
    const pdf = await api.get(`/api/payslips/${mine.body[0].id}/pdf`).set('Authorization', `Bearer ${S.aliToken}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const saras = (await as(S.admin).get(`/payslips?employeeId=${S.sara.id}`)).body[0];
    expect((await as(S.aliToken).get(`/payslips/${saras.id}/pdf`)).status).toBe(403);
    expect((await as(S.aliToken).get('/notifications')).body.items.some((x) => x.type === 'PAYSLIP_READY')).toBe(true);
  });
});

describe('M7 dashboards', () => {
  it('role-scoped dashboards with filters', async () => {
    expect((await as(S.aliToken).get('/analytics/hr')).status).toBe(403);
    expect((await as(S.hr).get('/analytics/admin')).status).toBe(403);
    const hr = await as(S.hr).get(`/analytics/hr?departmentId=${S.eng.id}`);
    expect(hr.status).toBe(200);
    expect(hr.body.kpis.headcount).toBe(2);
    const admin = await as(S.admin).get('/analytics/admin');
    expect(admin.body.kpis.headcount).toBe(3);
    expect(admin.body.kpis.payrollMonth).toBe(month);
    expect((await as(S.aliToken).get('/analytics/me')).status).toBe(200);
  });

  it('AI tools return exactly the dashboard numbers', async () => {
    const hrActor = await db.one("select u.*, e.id as employee_id from users u join employees e on e.user_id = u.id where u.email = 'hr@test.co'");
    const tool = (name) => toolsFor('hr').find((t) => t.schema.function.name === name);
    const dash = (await as(S.hr).get(`/analytics/hr?from=${month}-01&to=${today}`)).body;
    const summary = await tool('get_attendance_summary').run({ from: `${month}-01`, to: today }, hrActor);
    expect(summary.attendanceRate).toBe(dash.kpis.attendanceRate);
    const head = await tool('get_headcount').run({ departmentName: 'engineering' }, hrActor);
    expect(head.total).toBe(2);
  });
});

describe('M8 AI guardrails', () => {
  it('employees never get company-wide tools, and their tools are forced to their own data', async () => {
    const names = toolsFor('employee').map((t) => t.schema.function.name);
    expect(names).not.toContain('get_headcount');
    expect(names).not.toContain('get_late_comers');
    const ali = await db.one("select u.*, e.id as employee_id from users u join employees e on e.user_id = u.id where u.email = 'ali@test.co'");
    const tool = (name) => toolsFor('employee').find((t) => t.schema.function.name === name);
    const search = await tool('search_employees').run({ query: 'Sara' }, ali);
    expect(search.employees.map((e) => e.name)).toEqual(['Ali Khan']);
    expect(JSON.stringify(search)).not.toMatch(/salary|gross|basic/i);
    const pay = await tool('get_payroll_summary').run({}, ali);
    expect(Object.keys(pay)).toEqual(['myPayslips']);
    expect(pay.myPayslips).toHaveLength(1);
    const leave = await tool('get_leave_summary').run({ from: '2026-01-01', to: '2026-12-31' }, ali);
    expect(leave.people.every((p) => p.name === 'Ali Khan')).toBe(true);
  });

  it('fails gracefully without a provider and logs every call', async () => {
    const chat = await as(S.aliToken).post('/ai/chat', { messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(503);
    const smart = await as(S.aliToken).post('/ai/smart-leave', { text: 'next monday off' });
    expect(smart.body).toMatchObject({ ok: false, fallback: 'form' });
    const summary = await as(S.hr).post('/ai/summary', { dashboard: 'hr' });
    expect(summary.body.fallback).toBe(true);
    expect((await as(S.aliToken).post('/ai/summary', { dashboard: 'hr' })).status).toBe(403);
    expect((await db.one('select count(*)::int as n from ai_logs')).n).toBeGreaterThanOrEqual(3);
  });

  it('limits each user to 20 AI requests per hour', async () => {
    const sara = await db.one("select id from users where email = 'sara@test.co'");
    await db.query("insert into ai_logs (user_id, role, feature, status) select $1, 'employee', 'chat', 'ok' from generate_series(1, 20)", [sara.id]);
    const res = await as(S.saraToken).post('/ai/chat', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AI_RATE_LIMIT');
  });
});

describe('M9 comms and audit', () => {
  it('announcements: Admin/HR post, employees read only', async () => {
    expect((await as(S.hr).post('/announcements', { title: 'Eid holidays', body: 'Office closed', audience: 'all' })).status).toBe(201);
    expect((await as(S.aliToken).post('/announcements', { title: 'Hi all', body: 'x', audience: 'all' })).status).toBe(403);
    expect((await as(S.aliToken).get('/announcements')).body[0].title).toBe('Eid holidays');
  });

  it('audit log records actor, action, entity and before/after, and is append-only', async () => {
    const audit = await as(S.admin).get('/audit?action=LEAVE_APPROVED');
    const row = audit.body.items[0];
    expect(row).toMatchObject({ actorName: 'Hina HR', actorRole: 'hr', entityType: 'leave_request' });
    expect(row.before.status).toBe('pending');
    expect(row.after.status).toBe('approved');
    const all = await as(S.admin).get('/audit');
    expect(JSON.stringify(all.body)).not.toMatch(/password_?hash/i);
    await expect(db.query('update audit_logs set action = $1', ['X'])).rejects.toThrow(/append-only/);
    await expect(db.query('delete from audit_logs')).rejects.toThrow(/append-only/);
  });

  it('deactivated users are locked out immediately', async () => {
    const sara = await db.one("select id from users where email = 'sara@test.co'");
    expect((await as(S.admin).post(`/users/${sara.id}/deactivate`)).status).toBe(200);
    const res = await as(S.saraToken).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});
