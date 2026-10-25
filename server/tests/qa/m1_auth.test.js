// QA — M1 Auth and Access (HCM_Lite_Test_Plan.md §3). Fresh schema qa_m1, baseline via API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { qa } from './helpers.js';

let ctx;
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
const HASH_RE = /password_?hash|passwordHash|\$2[aby]\$\d\d\$/i;

// The login limiter allows 10 attempts/min per IP (a security feature, tested in X-tests); give each
// test login its own client IP (app trusts one proxy hop) so the suite isn't throttled.
let ipSeq = 0;
const nextIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const loginRes = (email, password) => ctx.api.post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });

beforeAll(async () => {
  ctx = await qa('qa_m1');
  ctx.login = async (email, password) => {
    const res = await loginRes(email, password);
    if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token;
  };
  ctx.firstLogin = async (email, temp, password) => {
    const t = await ctx.login(email, temp);
    return (await ctx.as(t).post('/auth/change-password', { currentPassword: temp, newPassword: password })).body.token;
  };
});
afterAll(async () => ctx?.close());

describe('M1 Auth and Access', () => {
  it('M1-01 valid login for each role issues a JWT with that role', async () => {
    for (const [email, pw, role] of [['admin@test.co', 'Admin1234', 'admin'], ['hr@test.co', 'Hrpass123', 'hr'], ['ali@test.co', 'Alipass123', 'employee']]) {
      const res = await loginRes(email, pw);
      expect(res.status).toBe(200);
      expect(res.body.token.split('.')).toHaveLength(3);
      expect(res.body.user.role).toBe(role);
      const me = await ctx.as(res.body.token).get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.role).toBe(role);
    }
  });

  it('M1-02 wrong password is rejected with a generic message and no token', async () => {
    const res = await loginRes('ali@test.co', 'Wrongpass1');
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(res.body.error.message).toBe('Email or password is incorrect');
  });

  it('M1-03 unknown email gets the same generic message as M1-02', async () => {
    const res = await loginRes('nobody@test.co', 'Whatever1');
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(res.body.error.message).toBe('Email or password is incorrect');
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('M1-04 empty or malformed login input is rejected with 400 field messages', async () => {
    const blank = await loginRes('', '');
    expect(blank.status).toBe(400);
    expect(blank.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['email', 'password']));
    const noAt = await loginRes('ali.test.co', 'Alipass123');
    expect(noAt.status).toBe(400);
    expect(noAt.body.error.details.map((d) => d.field)).toContain('email');
    expect(noAt.body.token).toBeUndefined();
  });

  it('M1-05 logout succeeds and is audited (token clearing / Back button is UI — MANUAL)', async () => {
    const t = await ctx.login('sara@test.co', 'Sarapass123');
    const res = await ctx.as(t).post('/auth/logout');
    expect(res.status).toBe(204);
    expect(await ctx.count('audit_logs', "action = 'LOGOUT'")).toBeGreaterThanOrEqual(1);
  });

  it('M1-06 protected API without Authorization header returns 401', async () => {
    for (const url of ['/employees', '/auth/me', '/analytics/hr', '/payslips', '/attendance/today', '/leave/balance', '/audit', '/settings']) {
      const res = await ctx.as(null).get(url);
      expect(res.status, url).toBe(401);
    }
  });

  it('M1-07 expired token returns 401', async () => {
    const user = await ctx.db.one("select id, role from users where email = 'ali@test.co'");
    const expired = jwt.sign({ sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) - 60 }, ctx.env.JWT_SECRET);
    const res = await ctx.as(expired).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('M1-08 tampered token (role → admin) returns 401 and gains no privilege', async () => {
    const [h, p, s] = ctx.tok.ali.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.role = 'admin';
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    expect((await ctx.as(forged).get('/audit')).status).toBe(401);
    expect((await ctx.as(forged).get('/auth/me')).status).toBe(401);
    // A token signed with a different secret is also rejected
    const wrongKey = jwt.sign({ sub: payload.sub, role: 'admin' }, 'not-the-secret-not-the-secret');
    expect((await ctx.as(wrongKey).get('/audit')).status).toBe(401);
  });

  it('M1-09 passwords are stored as bcrypt hashes, never plaintext', async () => {
    const rows = await ctx.db.query('select email, password_hash from users');
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.passwordHash).toMatch(/^\$2[ab]\$\d\d\$/);
      expect(r.passwordHash).not.toMatch(/pass123|Admin1234/i);
    }
  });

  it('M1-10 no password or hash field is returned by any user / employee API', async () => {
    const A = ctx.as(ctx.tok.admin);
    const H = ctx.as(ctx.tok.hr);
    const E = ctx.as(ctx.tok.ali);
    const responses = [
      await loginRes('admin@test.co', 'Admin1234'),
      await A.get('/auth/me'), await H.get('/auth/me'), await E.get('/auth/me'),
      await A.get('/users'),
      await A.get('/employees'), await H.get('/employees'), await E.get('/employees'),
      await A.get(`/employees/${ctx.emp.ali.id}`), await H.get(`/employees/${ctx.emp.ali.id}/360`), await E.get('/employees/me'),
      await A.get('/audit'),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(HASH_RE);
    }
    // Responses that create logins return only the one-time temp password, never a hash
    const created = await H.post('/employees', { employeeCode: 'EMP-050', fullName: 'Leak Check', email: 'leak@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 30000 });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toMatch(HASH_RE);
    const reset = await A.post(`/users/${created.body.user.id}/reset-password`);
    expect(JSON.stringify(reset.body)).not.toMatch(HASH_RE);
  });

  it('M1-11 change password (valid): new password works, old one fails', async () => {
    const t = await ctx.login('usman@test.co', 'Usmanpass123');
    const res = await ctx.as(t).post('/auth/change-password', { currentPassword: 'Usmanpass123', newPassword: 'Usmannew456' });
    expect(res.status).toBe(200);
    expect((await loginRes('usman@test.co', 'Usmannew456')).status).toBe(200);
    expect((await loginRes('usman@test.co', 'Usmanpass123')).status).toBe(401);
    ctx.tok.usman = (await loginRes('usman@test.co', 'Usmannew456')).body.token;
  });

  it('M1-12 change password (invalid): wrong current / weak / same as old are rejected and nothing changes', async () => {
    const t = await ctx.login('sara@test.co', 'Sarapass123');
    const S = ctx.as(t);
    const before = (await ctx.db.one("select password_hash from users where email = 'sara@test.co'")).passwordHash;
    const wrong = await S.post('/auth/change-password', { currentPassword: 'Nope12345', newPassword: 'Saranew123' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.message).toMatch(/incorrect/i);
    const short = await S.post('/auth/change-password', { currentPassword: 'Sarapass123', newPassword: 'a1' });
    expect(short.status).toBe(400);
    const weak = await S.post('/auth/change-password', { currentPassword: 'Sarapass123', newPassword: 'onlyletters' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details[0].reason).toMatch(/digit/i);
    const same = await S.post('/auth/change-password', { currentPassword: 'Sarapass123', newPassword: 'Sarapass123' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('SAME_PASSWORD');
    const after = (await ctx.db.one("select password_hash from users where email = 'sara@test.co'")).passwordHash;
    expect(after).toBe(before);
    expect((await loginRes('sara@test.co', 'Sarapass123')).status).toBe(200);
  });

  it('M1-13 temporary password: forced to change first, every other API is blocked until then', async () => {
    const reg = await ctx.as(ctx.tok.hr).post('/employees', { employeeCode: 'EMP-051', fullName: 'Temp User', email: 'temp@test.co', departmentId: ctx.ids.sales, joinDate: '2026-01-01', basicSalary: 30000 });
    expect(reg.status).toBe(201);
    const login = await loginRes('temp@test.co', reg.body.tempPassword);
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    const T = ctx.as(login.body.token);
    for (const url of ['/employees', '/attendance/today', '/leave/balance', '/payslips', '/announcements', '/notifications', '/analytics/me']) {
      const r = await T.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await T.post('/attendance/check-in')).status).toBe(403);
    expect(await ctx.count('attendance', 'employee_id = $1', [reg.body.employee.id])).toBe(0);
    expect((await T.get('/auth/me')).status).toBe(200);
    const changed = await T.post('/auth/change-password', { currentPassword: reg.body.tempPassword, newPassword: 'Tempnew123' });
    expect(changed.status).toBe(200);
    expect((await ctx.as(changed.body.token).get('/employees')).status).toBe(200);
    ctx.ids.tempUserId = reg.body.user.id;
  });

  it('M1-14 deactivated user cannot log in', async () => {
    const A = ctx.as(ctx.tok.admin);
    expect((await A.post(`/users/${ctx.ids.tempUserId}/deactivate`)).status).toBe(200);
    const res = await loginRes('temp@test.co', 'Tempnew123');
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('M1-15 deactivated user with a live token is rejected on the next request', async () => {
    const A = ctx.as(ctx.tok.admin);
    expect((await A.post(`/users/${ctx.ids.tempUserId}/reactivate`)).status).toBe(200);
    const live = await ctx.login('temp@test.co', 'Tempnew123');
    expect((await ctx.as(live).get('/auth/me')).status).toBe(200);
    expect((await A.post(`/users/${ctx.ids.tempUserId}/deactivate`)).status).toBe(200);
    const next = await ctx.as(live).get('/employees');
    expect(next.status).toBe(401);
    expect(next.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('M1-16 Admin resets a login: new temp password, must change, old password stops working', async () => {
    const A = ctx.as(ctx.tok.admin);
    const sara = await ctx.db.one("select id from users where email = 'sara@test.co'");
    const reset = await A.post(`/users/${sara.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect(reset.body.tempPassword).toHaveLength(12);
    expect((await loginRes('sara@test.co', 'Sarapass123')).status).toBe(401);
    const login = await loginRes('sara@test.co', reset.body.tempPassword);
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await ctx.as(login.body.token).get('/employees')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    ctx.tok.sara = await ctx.firstLogin('sara@test.co', reset.body.tempPassword, 'Sarapass123x');
  });

  it('M1-17 Employee token is refused on Admin/HR endpoints (403) and nothing changes', async () => {
    const E = ctx.as(ctx.tok.ali);
    const beforeEmp = await ctx.count('employees');
    const beforeRuns = await ctx.count('payroll_runs');
    const checks = [
      await E.put('/settings', { graceMinutes: 60 }),
      await E.post('/employees', { employeeCode: 'X1', fullName: 'Hack', email: 'h@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 1 }),
      await E.post(`/leave/requests/${RANDOM_ID}/approve`, {}),
      await E.post('/payroll/runs', { month: '2026-10' }),
      await E.get('/audit'),
    ];
    for (const r of checks) expect(r.status).toBe(403);
    expect(await ctx.count('employees')).toBe(beforeEmp);
    expect(await ctx.count('payroll_runs')).toBe(beforeRuns);
    expect((await ctx.db.one('select grace_minutes from company_settings')).graceMinutes).toBe(15);
  });

  it('M1-18 HR token is refused on Admin endpoints (403) and nothing changes', async () => {
    const H = ctx.as(ctx.tok.hr);
    const beforeUsers = await ctx.count('users');
    const checks = [
      await H.put('/settings', { graceMinutes: 60 }),
      await H.post('/users', { role: 'hr', employeeCode: 'HR-9', fullName: 'Another HR', email: 'hr9@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 1000 }),
      await H.post(`/payroll/runs/${RANDOM_ID}/finalize`),
      await H.get('/audit'),
    ];
    for (const r of checks) expect(r.status).toBe(403);
    expect(await ctx.count('users')).toBe(beforeUsers);
    expect((await ctx.db.one('select grace_minutes from company_settings')).graceMinutes).toBe(15);
  });

  it("M1-19 Employee cannot read another employee's profile, attendance, leave or payslip", async () => {
    const E = ctx.as(ctx.tok.ali);
    const sara = ctx.emp.sara.id;
    // Leave request + payslip for Sara so real IDs exist
    const leave = await ctx.as(ctx.tok.sara).post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-04', endDate: '2026-11-04', reason: 'x' });
    expect(leave.status).toBe(201);
    const run = await ctx.as(ctx.tok.hr).post('/payroll/runs', { month: '2026-10' });
    expect(run.status).toBe(201);
    expect((await ctx.as(ctx.tok.admin).post(`/payroll/runs/${run.body.id}/finalize`)).status).toBe(200);
    const saraSlip = (await ctx.as(ctx.tok.admin).get('/payslips', { employeeId: sara })).body[0];
    expect(saraSlip).toBeTruthy();

    const results = {
      profile: await E.get(`/employees/${sara}`),
      profile360: await E.get(`/employees/${sara}/360`),
      salary: await E.get(`/employees/${sara}/salary`),
      calendar: await E.get('/attendance/calendar', { employeeId: sara, month: '2026-11' }),
      leaveById: await E.get(`/leave/requests/${leave.body.id}`),
      leaveCancel: await E.post(`/leave/requests/${leave.body.id}/cancel`),
      payslip: await E.get(`/payslips/${saraSlip.id}`),
      payslipPdf: await E.get(`/payslips/${saraSlip.id}/pdf`),
    };
    for (const [k, r] of Object.entries(results)) {
      expect([403, 404], k).toContain(r.status);
      expect(JSON.stringify(r.body), k).not.toMatch(/Sara Ahmed|80000|120000/);
    }
    expect((await ctx.db.one('select status from leave_requests where id = $1', [leave.body.id])).status).toBe('pending');
  });

  it('M1-20 parameter tampering on own endpoints is ignored or rejected (only own rows)', async () => {
    const E = ctx.as(ctx.tok.ali);
    const sara = ctx.emp.sara.id;
    const own = (await E.get('/leave/balance')).body;
    const tampered = await E.get('/leave/balance', { employeeId: sara });
    expect(tampered.status).toBe(200);
    expect(tampered.body).toEqual(own);
    const list = await E.get('/employees', { q: 'Sara', departmentId: ctx.ids.eng });
    expect(list.body.items.every((e) => e.id === ctx.emp.ali.id)).toBe(true);
    const slips = await E.get('/payslips', { employeeId: sara });
    expect(slips.body.every((p) => p.employeeId === ctx.emp.ali.id)).toBe(true);
    const leaves = await E.get('/leave/requests', { employeeId: sara });
    expect(leaves.body.every((l) => l.employeeId === ctx.emp.ali.id)).toBe(true);
    const corrections = await E.get('/attendance/corrections');
    expect(corrections.body.every((c) => c.employeeId === ctx.emp.ali.id)).toBe(true);
    // employee_id in a request body is ignored: the leave is created for the caller
    const created = await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-05', endDate: '2026-11-05', reason: 'tamper', employeeId: sara });
    expect(created.status).toBe(201);
    expect(created.body.employeeId).toBe(ctx.emp.ali.id);
    const patch = await E.patch('/employees/me', { phone: '0300-0000000', employeeId: sara });
    expect([400, 403, 422]).toContain(patch.status);
    expect((await ctx.db.one('select phone from employees where id = $1', [sara])).phone).toBeNull();
  });

  it('M1-21 menus per role — API part: each role reaches only its own areas (menus are UI — MANUAL)', async () => {
    const E = ctx.as(ctx.tok.ali);
    const H = ctx.as(ctx.tok.hr);
    expect((await E.get('/analytics/me')).status).toBe(200);
    expect((await E.get('/analytics/hr')).status).toBe(403);
    expect((await H.get('/analytics/hr')).status).toBe(200);
    expect((await H.get('/analytics/admin')).status).toBe(403);
    expect((await ctx.as(ctx.tok.admin).get('/analytics/admin')).status).toBe(200);
  });

  it('M1-22 forbidden admin/HR data URLs return 403 with no data (page redirect is UI — MANUAL)', async () => {
    const E = ctx.as(ctx.tok.ali);
    for (const url of ['/users', '/audit', '/attendance/board', '/payroll/runs', '/settings', '/ai/logs']) {
      const r = await E.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error).toBeTruthy();
      expect(Array.isArray(r.body)).toBe(false);
    }
  });

  it('M1-23 session survives refresh — API part: the same token keeps working on /auth/me (UI refresh — MANUAL)', async () => {
    const t = ctx.tok.hr;
    const a = await ctx.as(t).get('/auth/me');
    const b = await ctx.as(t).get('/auth/me');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.user.id).toBe(a.body.user.id);
  });
});
