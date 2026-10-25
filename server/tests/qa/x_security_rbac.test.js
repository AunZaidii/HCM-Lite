// §12.1 RBAC negative matrix (table-driven, API level, every refused role, verifying no data change),
// §12.3 security & robustness (X-08..X-15) and §12.4 X-18/X-19. Schema: qa_x.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

const LONG = 1_200_000;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let ctx; let A; let H; let E; let S; let U;

const TABLES = ['company_settings', 'users', 'departments', 'designations', 'employees', 'salary_structures', 'leave_types', 'holidays', 'attendance',
  'attendance_corrections', 'leave_requests', 'payroll_runs', 'payslips', 'announcements', 'notifications', 'audit_logs', 'face_profiles', 'checkin_attempts'];
// One hash over every business table: any write (even an audit row or notification) changes it.
const fingerprint = () => ctx.db.one(`select ${TABLES.map((t) => `(select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${t} x) as ${t}`).join(', ')}`);

beforeAll(async () => {
  ctx = await qa('qa_x', { clock: '2026-11-03T10:00' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr); E = ctx.as(ctx.tok.ali); S = ctx.as(ctx.tok.sara); U = ctx.as(ctx.tok.usman);
  ctx.ids.saraLeave = (await S.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-10', endDate: '2026-11-10', reason: 'x' })).body.id;
  ctx.ids.aliCorr = (await E.post('/attendance/corrections', { date: '2026-11-02', requestedCheckIn: '09:00', reason: 'Forgot to check in' })).body.id;
  ctx.ids.run = (await H.post('/payroll/runs', { month: '2026-10' })).body.id;
  ctx.ids.saraSlip = (await H.get('/payslips', { employeeId: ctx.emp.sara.id })).body[0].id;
}, LONG);
afterAll(async () => ctx?.close());

describe('12.1 RBAC negative matrix', () => {
  const T = () => ({ A, H, E, none: ctx.as(null) });
  const id = () => ctx.ids;
  const emp = () => ctx.emp;
  const rows = [
    ['01', 'First-run setup after completion', ['A', 'H', 'E', 'none'], 'post', () => '/setup', { companyName: 'Evil Co', admin: { fullName: 'Evil', email: 'evil@x.co', password: 'Evil12345' } }, [403, 409]],
    ['03', 'Edit company settings', ['H', 'E'], 'put', () => '/settings', { graceMinutes: 59 }],
    ['04', 'Create department', ['H', 'E'], 'post', () => '/departments', { name: 'Ops', code: 'OPS' }],
    ['04', 'Edit department', ['H', 'E'], 'put', () => `/departments/${id().sales}`, { name: 'Sales X' }],
    ['04', 'Delete holiday', ['H', 'E'], 'del', () => `/holidays/${id().holiday}`],
    ['04', 'Create leave type', ['H', 'E'], 'post', () => '/leave-types', { name: 'Study', code: 'STUDY', yearlyQuota: 5, isPaid: true }],
    ['04', 'Create holiday', ['H', 'E'], 'post', () => '/holidays', { date: '2026-12-25', name: 'Xmas' }],
    ['05', 'Create HR login', ['H', 'E'], 'post', () => '/users', { role: 'hr', employeeCode: 'HR-9', fullName: 'X', email: 'x@x.co', departmentId: id().eng, joinDate: '2026-01-01' }],
    ['05', 'Deactivate a login', ['H', 'E'], 'post', () => `/users/${emp().sara.userId}/deactivate`],
    ['05', 'Reset a login', ['H', 'E'], 'post', () => `/users/${emp().sara.userId}/reset-password`],
    ['06', 'Register employee', ['A', 'E'], 'post', () => '/employees', { employeeCode: 'EMP-099', fullName: 'New', email: 'new@x.co', departmentId: id().eng, joinDate: '2026-01-01', basicSalary: 1000 }],
    ['06', 'Edit employee', ['A', 'E'], 'put', () => `/employees/${emp().usman.id}`, { phone: '000' }],
    ['07', "Other employee's profile", ['E'], 'get', () => `/employees/${emp().sara.id}`],
    ['07', "Other employee's 360", ['E'], 'get', () => `/employees/${emp().sara.id}/360`],
    ['08', 'CSV export', ['A', 'E'], 'get', () => '/employees/export.csv'],
    ['08', 'CSV template / import', ['A', 'E'], 'get', () => '/employees/import/template'],
    ['08', 'CSV import', ['A', 'E'], 'post', () => '/employees/import?dryRun=true', {}],
    ['09', 'Check in', ['A'], 'post', () => '/attendance/check-in'],
    ['09', 'Check out', ['A'], 'post', () => '/attendance/check-out'],
    ['10', 'Daily attendance board', ['E'], 'get', () => '/attendance/board'],
    ['10', "Other employee's calendar", ['E'], 'get', () => `/attendance/calendar?employeeId=${emp().sara.id}`],
    ['11', 'Approve correction', ['A', 'E'], 'post', () => `/attendance/corrections/${id().aliCorr}/approve`, {}],
    ['11', 'Reject correction', ['A', 'E'], 'post', () => `/attendance/corrections/${id().aliCorr}/reject`, { comment: 'no no' }],
    ['12', 'Apply for leave', ['A'], 'post', () => '/leave/requests', { leaveTypeId: id().types.CASUAL, startDate: '2026-11-12', endDate: '2026-11-12' }],
    ['12', "Cancel someone else's leave", ['E'], 'post', () => `/leave/requests/${id().saraLeave}/cancel`],
    ['13', 'Approve leave', ['A', 'E'], 'post', () => `/leave/requests/${id().saraLeave}/approve`, {}],
    ['13', 'Reject leave', ['A', 'E'], 'post', () => `/leave/requests/${id().saraLeave}/reject`, { comment: 'no no' }],
    ['14', 'Salary structure edit', ['A', 'E'], 'post', () => `/employees/${emp().usman.id}/salary`, { basic: 1, effectiveFrom: '2026-11-01' }],
    ['14', 'Salary structure view', ['E'], 'get', () => `/employees/${emp().usman.id}/salary`],
    ['15', 'Create payroll draft', ['A', 'E'], 'post', () => '/payroll/runs', { month: '2026-09' }],
    ['15', 'Review payroll runs', ['E'], 'get', () => '/payroll/runs'],
    ['15', 'Review a payroll draft', ['E'], 'get', () => `/payroll/runs/${id().run}`],
    ['15', 'Recalculate draft', ['A', 'E'], 'post', () => `/payroll/runs/${id().run}/recalculate`],
    ['16', 'Finalize payroll', ['H', 'E'], 'post', () => `/payroll/runs/${id().run}/finalize`],
    ['17', "Other employee's payslip", ['E'], 'get', () => `/payslips/${id().saraSlip}`],
    ['17', "Other employee's payslip PDF", ['E'], 'get', () => `/payslips/${id().saraSlip}/pdf`],
    ['18', 'Admin dashboard', ['H', 'E'], 'get', () => '/analytics/admin'],
    ['18', 'HR dashboard', ['E'], 'get', () => '/analytics/hr'],
    ['20', 'AI dashboard summary', ['E'], 'post', () => '/ai/summary', { dashboard: 'hr' }],
    ['21', 'Smart leave', ['A'], 'post', () => '/ai/smart-leave', { text: 'next monday off' }],
    ['23', 'Post announcement', ['E'], 'post', () => '/announcements', { title: 'Hello', body: 'Hello all', audience: 'all' }],
    ['25', 'Audit log', ['H', 'E'], 'get', () => '/audit'],
  ];

  for (const [num, name, roles, method, url, body, allowed = [403]] of rows) {
    for (const role of roles) {
      it(`RBAC-${num} ${name} — refused for ${role}, nothing changes`, async () => {
        const before = await fingerprint();
        const res = await T()[role][method](url(), body);
        expect(allowed, `${role} ${method.toUpperCase()} ${url()} → ${res.status}`).toContain(res.status);
        expect(res.body?.error?.message || res.text).toBeTruthy();
        expect(await fingerprint()).toEqual(before);
      });
    }
  }

  it('RBAC-all no token → 401 on every protected endpoint', async () => {
    const none = ctx.as(null);
    for (const [method, url] of [['get', '/employees'], ['put', '/settings'], ['get', '/audit'], ['post', '/attendance/check-in'], ['get', '/payslips'], ['post', '/ai/chat'], ['get', `/payslips/${ctx.ids.saraSlip}/pdf`]]) {
      expect((await none[method](url, {})).status, url).toBe(401);
    }
  });

  it('RBAC-06b Employee may edit own phone and address only', async () => {
    expect((await E.patch('/employees/me', { phone: '0300-1111111', address: 'Karachi' })).status).toBe(200);
    expect((await E.patch('/employees/me', { departmentId: ctx.ids.sales })).status).toBe(422);
  });
});

describe('12.3 Security and robustness', () => {
  it('X-08 SQL/NoSQL injection in login, search, filters → no error, no bypass', async () => {
    const r1 = await ctx.api.post('/api/auth/login').send({ email: "admin@test.co' OR '1'='1", password: "x' OR '1'='1" });
    expect([400, 401]).toContain(r1.status);
    expect(r1.body.token).toBeUndefined();
    const r2 = await ctx.api.post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(r2.status).toBe(400);
    const r3 = await H.get('/employees', { q: "'); drop table employees; --" });
    expect(r3.status).toBe(200);
    expect(r3.body.total).toBe(0);
    expect(await ctx.count('employees')).toBe(4);
    expect((await H.get('/employees', { status: "active' OR '1'='1" })).status).toBe(400);
    const r4 = await E.get('/employees', { q: "' OR 1=1 --" });
    expect(r4.body.items.every((e) => e.id === ctx.emp.ali.id)).toBe(true);
  });

  it('X-09 script tags in names, reasons, comments and announcements are stored and returned as text', async () => {
    const xss = '<script>alert(1)</script>';
    await H.put(`/employees/${ctx.emp.usman.id}`, { fullName: `${xss} Usman` });
    expect((await H.get(`/employees/${ctx.emp.usman.id}`)).body.fullName).toBe(`${xss} Usman`);
    const leave = await U.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-13', endDate: '2026-11-13', reason: xss });
    expect(leave.body.reason).toBe(xss);
    const corr = await U.post('/attendance/corrections', { date: '2026-11-02', requestedCheckIn: '09:00', reason: xss });
    expect(corr.body.reason).toBe(xss);
    const ann = await H.post('/announcements', { title: xss, body: xss, audience: 'all' });
    expect(ann.body.title).toBe(xss);
    const src = execSync('git grep -n "dangerouslySetInnerHTML\\|innerHTML" -- client/src || true', { cwd: repo }).toString();
    expect(src).toBe('');
  });

  it('X-10 mass assignment: extra fields (role, salary, employee_id, status) are ignored or rejected', async () => {
    const leave = await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.ANNUAL, startDate: '2026-11-16', endDate: '2026-11-16', reason: 'x',
      employeeId: ctx.emp.sara.id, status: 'approved', days: 99, reviewerId: ctx.emp.hr.userId });
    expect(leave.status).toBe(201);
    expect(leave.body).toMatchObject({ employeeId: ctx.emp.ali.id, status: 'pending', days: 1, reviewerId: null });
    await H.put(`/employees/${ctx.emp.sara.id}`, { role: 'admin', userId: ctx.emp.hr.userId, basicSalary: 1 });
    const sara = await ctx.db.one('select u.role, e.user_id from employees e join users u on u.id = e.user_id where e.id = $1', [ctx.emp.sara.id]);
    expect(sara).toEqual({ role: 'employee', userId: ctx.emp.sara.userId });
    expect((await E.patch('/employees/me', { phone: '1', role: 'admin' })).status).toBe(422);
    await A.put('/settings', { id: 2, companyName: 'QA Co 2' });
    expect(await ctx.count('company_settings')).toBe(1);
    ctx.at('2026-11-03T09:00');
    const ci = await S.post('/attendance/check-in', { checkInAt: '2020-01-01T00:00:00Z', employeeId: ctx.emp.ali.id, status: 'present' });
    expect(ci.body.employeeId).toBe(ctx.emp.sara.id);
    expect(ci.body.checkInAt).toBe(new Date('2026-11-03T09:00:00+05:00').toISOString());
  });

  it('X-11 CORS: only the configured front end is allowed', async () => {
    const evil = await ctx.api.get('/api/health').set('Origin', 'http://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const good = await ctx.api.get('/api/health').set('Origin', 'http://localhost:5173');
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('X-12 no secrets in tracked files (no commits yet → no history)', () => {
    const tracked = execSync('git ls-files --cached', { cwd: repo }).toString().split('\n');
    expect(tracked.filter((f) => /(^|\/)\.env$/.test(f))).toEqual([]);
    const hits = execSync('git grep --cached -n -I -E "AQ\\.Ab8|Aunzaidi110|sb_publishable_" -- . || true', { cwd: repo }).toString();
    expect(hits).toBe('');
  });

  it('X-13 errors never leak stack traces or SQL; production hides 500 details', async () => {
    const bad = await ctx.api.post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
    const responses = [bad,
      await H.get('/employees/not-a-uuid'),
      await A.post('/departments', { name: 'Engineering', code: 'ENG2' }),
      await ctx.api.get('/api/nope'),
    ];
    for (const r of responses) expect(JSON.stringify(r.body)).not.toMatch(/\n\s+at |\.js:\d+|select |insert into|update \w+ set/i);
    // Force an unexpected error (upload over the 1 MB limit) with NODE_ENV=production.
    const prev = ctx.env.NODE_ENV;
    ctx.env.NODE_ENV = 'production';
    const big = await ctx.api.post('/api/employees/import?dryRun=true').set('Authorization', `Bearer ${ctx.tok.hr}`).attach('file', Buffer.alloc(1_100_000, 'a'), 'big.csv');
    ctx.env.NODE_ENV = prev;
    expect(big.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(big.body)).not.toMatch(/\n\s+at |\.js:\d+|multer|node_modules/i);
  });

  it('X-14 concurrency: two HR approve the same leave → one decision; double check-in → one record; parallel edits both kept', async () => {
    const hr2 = await A.post('/users', { role: 'hr', employeeCode: 'HR-002', fullName: 'Hamid HR', email: 'hr2@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 50000 });
    const H2 = ctx.as(await ctx.firstLogin('hr2@test.co', hr2.body.tempPassword, 'Hr2pass123'));
    const before = await ctx.count('notifications', "type = 'LEAVE_DECIDED'");
    const [a, b] = await Promise.all([H.post(`/leave/requests/${ctx.ids.saraLeave}/approve`, {}), H2.post(`/leave/requests/${ctx.ids.saraLeave}/approve`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await ctx.count('notifications', "type = 'LEAVE_DECIDED'")).toBe(before + 1);
    expect(await ctx.count('audit_logs', "action = 'LEAVE_APPROVED' and entity_id = $1", [ctx.ids.saraLeave])).toBe(1);
    ctx.at('2026-11-03T09:10');
    const [c1, c2] = await Promise.all([U.post('/attendance/check-in'), U.post('/attendance/check-in')]);
    expect([c1.status, c2.status].sort()).toEqual([201, 409]);
    expect(await ctx.count('attendance', 'employee_id = $1', [ctx.emp.usman.id])).toBe(1);
    await Promise.all([H.put(`/employees/${ctx.emp.ali.id}`, { address: 'Lahore' }), H2.put(`/employees/${ctx.emp.ali.id}`, { designationId: ctx.ids.hrOfficer })]);
    const ali = await ctx.db.one('select address, designation_id from employees where id = $1', [ctx.emp.ali.id]);
    expect(ali).toEqual({ address: 'Lahore', designationId: ctx.ids.hrOfficer });
  });

  it('X-15 timezone: records land on the correct Karachi date around midnight and month ends', async () => {
    const day = async (client, local) => { ctx.at(local); return (await client.post('/attendance/check-in')).body.workDate; };
    expect(await day(S, '2026-11-04T23:59')).toBe('2026-11-04');
    expect(await day(E, '2026-11-05T00:01')).toBe('2026-11-05');
    expect(await day(U, '2026-11-30T23:58')).toBe('2026-11-30');
    expect(await day(S, '2026-12-01T00:00')).toBe('2026-12-01');
  });
});

describe('12.4 README and .env.example', () => {
  it('X-18 README has stack, how to run, first Admin, AI key, done and not done', () => {
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    for (const h of [/## Stack/, /## Run it locally/, /### How to create the first Admin/, /### How to set the AI key/, /## What is done/, /## What is not done/]) expect(readme).toMatch(h);
  });

  it('X-19 .env.example files list every variable with placeholders and no real secrets', () => {
    const server = fs.readFileSync(path.join(repo, 'server', '.env.example'), 'utf8');
    for (const key of ['NODE_ENV', 'PORT', 'CLIENT_ORIGIN', 'DATABASE_URL', 'JWT_SECRET', 'JWT_EXPIRES_IN', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'AI_BASE_URL', 'AI_MODEL',
      'AI_FALLBACK_MODEL', 'AI_REASONING_EFFORT', 'AI_API_KEY', 'AI_TIMEOUT_MS', 'AI_RATE_LIMIT_PER_HOUR']) {
      expect(server).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    expect(server).toMatch(/\[YOUR-PASSWORD\]/);
    expect(server).toMatch(/^JWT_SECRET=change-me\r?$/m);
    expect(server).toMatch(/^AI_API_KEY=\r?$/m);
    expect(server).not.toMatch(/AQ\.Ab8|Aunzaidi/);
    expect(fs.readFileSync(path.join(repo, 'client', '.env.example'), 'utf8')).toMatch(/^VITE_API_URL=http:\/\/localhost:4000\/api/m);
  });
});
