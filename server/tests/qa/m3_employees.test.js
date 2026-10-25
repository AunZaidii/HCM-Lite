// QA — M3 Employees (HCM_Lite_Test_Plan.md §5, M3-01..M3-27). Schema qa_m3, baseline via API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { qa } from './helpers.js';

let ctx;
let A; let H; let E;
let ip = 0;
const loginRes = (email, password) => ctx.api.post('/api/auth/login').set('X-Forwarded-For', `10.4.0.${++ip}`).send({ email, password });
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
const HEADER = 'employee_code,full_name,email,phone,gender,department,designation,employment_type,join_date,basic_salary,address';

const upload = (token, csv, dryRun = true, name = 'employees.csv') => ctx.api
  .post(`/api/employees/import?dryRun=${dryRun}`).set('Authorization', `Bearer ${token}`)
  .attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), name);
const exportCsv = (token, query = {}) => ctx.api.get('/api/employees/export.csv').query(query).set('Authorization', `Bearer ${token}`).buffer(true)
  .parse((res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); });

const newEmp = (over = {}) => ({
  employeeCode: 'EMP-100', fullName: 'Bilal Ahmed', email: 'bilal@test.co', departmentId: ctx.ids.sales, designationId: ctx.ids.salesExec,
  joinDate: '2026-03-01', basicSalary: 55000, gender: 'male', phone: '0301-1111111', ...over,
});

beforeAll(async () => {
  ctx = await qa('qa_m3');
  A = ctx.as(ctx.tok.admin);
  H = ctx.as(ctx.tok.hr);
  E = ctx.as(ctx.tok.ali);
});
afterAll(async () => ctx?.close());

describe('M3 register and edit (06)', () => {
  it('M3-01 HR registers an employee: employee + login created, temp password shown once, in directory, audited', async () => {
    const res = await H.post('/employees', newEmp());
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toHaveLength(12);
    expect(res.body.user.role).toBe('employee');
    ctx.emp.bilal = res.body.employee;
    expect((await loginRes('bilal@test.co', res.body.tempPassword)).status).toBe(200);
    const dir = await H.get('/employees', { q: 'Bilal' });
    expect(dir.body.items.map((e) => e.employeeCode)).toEqual(['EMP-100']);
    const audit = (await A.get('/audit', { action: 'EMPLOYEE_CREATED' })).body.items.find((a) => a.entityId === res.body.employee.id);
    expect(audit).toBeTruthy();
    expect(audit.actorName).toBe('Hina HR');
    expect(audit.after.basicSalary).toBe(55000);
  });

  it('M3-02 each required field left blank is rejected with a field message; nothing saved', async () => {
    const before = await ctx.count('employees');
    const required = { fullName: 'fullName', employeeCode: 'employeeCode', email: 'email', departmentId: 'departmentId', joinDate: 'joinDate', basicSalary: 'basicSalary' };
    for (const [key, field] of Object.entries(required)) {
      for (const blank of ['', undefined]) {
        const body = newEmp({ employeeCode: `EMP-2${key.length}`, email: `blank${key}@test.co` });
        if (blank === undefined) delete body[key]; else body[key] = blank;
        const res = await H.post('/employees', body);
        expect(res.status, `${key}=${blank}`).toBe(400);
        expect(res.body.error.details.map((d) => d.field), key).toContain(field);
      }
    }
    expect(await ctx.count('employees')).toBe(before);
  });

  it('M3-03 duplicate employee code and duplicate email are both rejected', async () => {
    const before = await ctx.count('employees');
    const dupCode = await H.post('/employees', newEmp({ email: 'other@test.co' }));
    expect([409, 422]).toContain(dupCode.status);
    expect(dupCode.body.error.code).toBe('DUPLICATE_CODE');
    const dupEmail = await H.post('/employees', newEmp({ employeeCode: 'EMP-101', email: 'BILAL@test.co' }));
    expect([409, 422]).toContain(dupEmail.status);
    expect(dupEmail.body.error.code).toBe('DUPLICATE_EMAIL');
    expect(await ctx.count('employees')).toBe(before);
    expect(await ctx.count('users', "email = 'other@test.co'")).toBe(0);
  });

  it('M3-04 invalid data (bad email, unknown department, salary 0/negative/text, invalid date) is rejected', async () => {
    const before = await ctx.count('employees');
    const cases = [
      [{ email: 'bad-email' }, 400, 'email'],
      [{ departmentId: RANDOM_ID }, 422, 'departmentId'],
      [{ departmentId: 'not-a-uuid' }, 400, 'departmentId'],
      [{ basicSalary: 0 }, 400, 'basicSalary'],
      [{ basicSalary: -5000 }, 400, 'basicSalary'],
      [{ basicSalary: 'fifty thousand' }, 400, 'basicSalary'],
      [{ joinDate: '2026-02-30' }, 400, 'joinDate'],
      [{ joinDate: '15/03/2026' }, 400, 'joinDate'],
    ];
    let i = 0;
    for (const [over, status, field] of cases) {
      const res = await H.post('/employees', newEmp({ employeeCode: `EMP-3${i}`, email: `inv${i++}@test.co`, ...over }));
      expect(res.status, JSON.stringify(over)).toBe(status);
      expect(res.body.error.details.map((d) => d.field), JSON.stringify(over)).toContain(field);
    }
    expect(await ctx.count('employees')).toBe(before);
  });

  it('M3-05 HR edits designation, phone and department: saved and audited with before/after', async () => {
    const res = await H.put(`/employees/${ctx.emp.bilal.id}`, { designationId: ctx.ids.dev, phone: '0333-2222222', departmentId: ctx.ids.eng });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ designationId: ctx.ids.dev, phone: '0333-2222222', departmentId: ctx.ids.eng });
    const audit = (await A.get('/audit', { action: 'EMPLOYEE_UPDATED' })).body.items.find((a) => a.entityId === ctx.emp.bilal.id);
    expect(audit.before).toMatchObject({ phone: '0301-1111111', departmentId: ctx.ids.sales, designationId: ctx.ids.salesExec });
    expect(audit.after).toMatchObject({ phone: '0333-2222222', departmentId: ctx.ids.eng, designationId: ctx.ids.dev });
  });

  it('M3-06 Admin cannot register or edit employees (view only, 403)', async () => {
    const before = await ctx.count('employees');
    expect((await A.post('/employees', newEmp({ employeeCode: 'EMP-400', email: 'a400@test.co' }))).status).toBe(403);
    expect((await A.put(`/employees/${ctx.emp.bilal.id}`, { phone: '000' })).status).toBe(403);
    expect(await ctx.count('employees')).toBe(before);
    expect((await ctx.db.one('select phone from employees where id = $1', [ctx.emp.bilal.id])).phone).toBe('0333-2222222');
    expect((await A.get(`/employees/${ctx.emp.bilal.id}`)).status).toBe(200);
  });

  it('M3-07 Employee cannot register employees (403)', async () => {
    const before = await ctx.count('employees');
    expect((await E.post('/employees', newEmp({ employeeCode: 'EMP-401', email: 'e401@test.co' }))).status).toBe(403);
    expect((await E.put(`/employees/${ctx.emp.ali.id}`, { phone: '000' })).status).toBe(403);
    expect(await ctx.count('employees')).toBe(before);
  });

  it('M3-08 Employee edits own phone and address', async () => {
    const res = await E.patch('/employees/me', { phone: '0300-7654321', address: 'House 5, Gulshan, Karachi' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '0300-7654321', address: 'House 5, Gulshan, Karachi' });
    expect((await E.get('/employees/me')).body.address).toBe('House 5, Gulshan, Karachi');
  });

  it('M3-09 Employee cannot change salary, role, department, name or email via the API', async () => {
    const before = await ctx.db.one('select e.*, u.role from employees e join users u on u.id = e.user_id where e.id = $1', [ctx.emp.ali.id]);
    const salaryBefore = await ctx.db.one('select count(*)::int as n from salary_structures where employee_id = $1', [ctx.emp.ali.id]);
    for (const body of [{ basicSalary: 999999 }, { role: 'admin' }, { departmentId: ctx.ids.sales }, { fullName: 'Boss' }, { email: 'boss@test.co' }, { phone: '1', status: 'active' }]) {
      const res = await E.patch('/employees/me', body);
      expect([400, 403, 422], JSON.stringify(body)).toContain(res.status);
    }
    expect((await E.post(`/employees/${ctx.emp.ali.id}/salary`, { basic: 999999, effectiveFrom: '2026-11-01' })).status).toBe(403);
    const after = await ctx.db.one('select e.*, u.role from employees e join users u on u.id = e.user_id where e.id = $1', [ctx.emp.ali.id]);
    expect(after).toMatchObject({ fullName: before.fullName, email: before.email, departmentId: before.departmentId, role: 'employee', phone: before.phone });
    expect((await ctx.db.one('select count(*)::int as n from salary_structures where employee_id = $1', [ctx.emp.ali.id])).n).toBe(salaryBefore.n);
  });

  it('M3-10 deactivated employee is excluded from active headcount, keeps history, cannot log in', async () => {
    const hcBefore = (await H.get('/analytics/hr')).body.kpis.headcount;
    const user = await ctx.db.one('select user_id from employees where id = $1', [ctx.emp.bilal.id]);
    expect((await A.post(`/users/${user.userId}/deactivate`)).status).toBe(200);
    expect((await loginRes('bilal@test.co', 'whatever1')).status).toBe(401);
    expect(await ctx.count('employees', 'id = $1', [ctx.emp.bilal.id])).toBe(1);
    expect((await H.get(`/employees/${ctx.emp.bilal.id}`)).status).toBe(200);
    const hcAfter = (await H.get('/analytics/hr')).body.kpis.headcount;
    expect(hcAfter).toBe(hcBefore - 1);
    expect((await A.post(`/users/${user.userId}/reactivate`)).status).toBe(200);
  });
});

describe('M3 directory and Employee 360 (07)', () => {
  it('M3-11 search by name, partial name, code, email and mixed case (server-side)', async () => {
    const find = async (q) => (await H.get('/employees', { q })).body.items.map((e) => e.fullName);
    expect(await find('Ali Khan')).toEqual(['Ali Khan']);
    expect(await find('ahm')).toEqual(expect.arrayContaining(['Sara Ahmed', 'Bilal Ahmed']));
    expect(await find('EMP-003')).toEqual(['Usman Tariq']);
    expect(await find('sara@test.co')).toEqual(['Sara Ahmed']);
    expect(await find('uSmAn')).toEqual(['Usman Tariq']);
    const res = await H.get('/employees', { q: 'ali', pageSize: 1 });
    expect(res.body).toHaveProperty('total'); // the server returns the filtered total — search happens on the server
  });

  it('M3-12 filters by department, designation and status give correct subsets and counts', async () => {
    const eng = await H.get('/employees', { departmentId: ctx.ids.eng });
    expect(eng.body.total).toBe(eng.body.items.length);
    expect(eng.body.items.every((e) => e.departmentId === ctx.ids.eng)).toBe(true);
    expect(eng.body.total).toBe(await ctx.count('employees', 'department_id = $1', [ctx.ids.eng]));
    const devs = await H.get('/employees', { designationId: ctx.ids.dev });
    expect(devs.body.items.every((e) => e.designationId === ctx.ids.dev)).toBe(true);
    expect(devs.body.total).toBe(await ctx.count('employees', 'designation_id = $1', [ctx.ids.dev]));
    const active = await H.get('/employees', { status: 'active' });
    expect(active.body.items.every((e) => e.status === 'active')).toBe(true);
    expect(active.body.total).toBe(await ctx.count('employees', "status = 'active'"));
  });

  it('M3-13 paging through 25+ employees: correct page size and total, no duplicates or gaps', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => `P-${String(i).padStart(3, '0')},Pager ${i},pager${i}@test.co,,male,SAL,,full_time,2026-04-01,40000,`);
    const commit = await upload(ctx.tok.hr, [HEADER, ...rows].join('\n'), false);
    expect(commit.status).toBe(201);
    expect(commit.body.created).toBe(26);
    const total = await ctx.count('employees');
    const seen = [];
    for (let page = 1; page <= Math.ceil(total / 10); page++) {
      const res = await H.get('/employees', { page, pageSize: 10, sort: 'code' });
      expect(res.body.total).toBe(total);
      expect(res.body.pageSize).toBe(10);
      expect(res.body.items.length).toBe(Math.min(10, total - (page - 1) * 10));
      seen.push(...res.body.items.map((e) => e.id));
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('M3-14 search + filter + paging together keep results and counts correct', async () => {
    const all = await H.get('/employees', { q: 'Pager', departmentId: ctx.ids.sales, pageSize: 100 });
    expect(all.body.total).toBe(26);
    const p3 = await H.get('/employees', { q: 'Pager', departmentId: ctx.ids.sales, page: 3, pageSize: 10, sort: 'code' });
    expect(p3.body.total).toBe(26);
    expect(p3.body.items.map((e) => e.employeeCode)).toEqual(['P-020', 'P-021', 'P-022', 'P-023', 'P-024', 'P-025']);
    const none = await H.get('/employees', { q: 'Pager', departmentId: ctx.ids.eng });
    expect(none.body.total).toBe(0);
  });

  it('M3-15 no results returns an empty list (friendly empty state is UI — MANUAL)', async () => {
    const res = await H.get('/employees', { q: 'Zzyzx Nonexistent' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('M3-16 special characters in search: quotes, percent, Urdu — no error, no injection, correct result', async () => {
    expect((await H.post('/employees', newEmp({ employeeCode: 'EMP-500', email: 'oneil@test.co', fullName: "Sean O'Neil" }))).status).toBe(201);
    expect((await H.post('/employees', newEmp({ employeeCode: 'EMP-501', email: 'urdu@test.co', fullName: 'علی رضا' }))).status).toBe(201);
    const quote = await H.get('/employees', { q: "O'Neil" });
    expect(quote.status).toBe(200);
    expect(quote.body.items.map((e) => e.fullName)).toEqual(["Sean O'Neil"]);
    const urdu = await H.get('/employees', { q: 'علی' });
    expect(urdu.body.items.map((e) => e.fullName)).toEqual(['علی رضا']);
    for (const q of ["' OR '1'='1", '"; drop table employees; --', ')(', '\\']) {
      const r = await H.get('/employees', { q });
      expect(r.status, q).toBe(200);
      expect(r.body.total, q).toBe(0);
    }
    expect(await ctx.count('employees')).toBeGreaterThan(30);
    // A literal "%" or "_" must not act as a wildcard: no employee name contains them
    const pct = await H.get('/employees', { q: '%' });
    expect(pct.status).toBe(200);
    expect(pct.body.total).toBe(0);
    const under = await H.get('/employees', { q: '_' });
    expect(under.body.total).toBe(0);
  });

  it('M3-17 Employee 360 for HR and Admin shows profile, attendance, leave and payroll sections', async () => {
    ctx.at('2026-11-03T09:05');
    await E.post('/attendance/check-in');
    for (const t of [ctx.tok.hr, ctx.tok.admin]) {
      const res = await ctx.as(t).get(`/employees/${ctx.emp.ali.id}/360`);
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ fullName: 'Ali Khan', employeeCode: 'EMP-001', departmentName: 'Engineering', designationTitle: 'Developer' });
      expect(res.body.profile.salary).toMatchObject({ basic: 100000, gross: 150000 });
      expect(res.body.attendanceThisMonth.present).toBe(1);
      expect(res.body.leaveBalances.find((b) => b.code === 'SICK')).toMatchObject({ quota: 8, remaining: 8 });
      expect(Array.isArray(res.body.payslips)).toBe(true);
      expect(Array.isArray(res.body.recentLeaves)).toBe(true);
    }
  });

  it('M3-18 Employee sees only their own 360; another ID returns 403/404', async () => {
    const own = await E.get(`/employees/${ctx.emp.ali.id}/360`);
    expect(own.status).toBe(200);
    expect(own.body.profile.fullName).toBe('Ali Khan');
    const other = await E.get(`/employees/${ctx.emp.sara.id}/360`);
    expect([403, 404]).toContain(other.status);
    expect(JSON.stringify(other.body)).not.toMatch(/Sara/);
  });

  it('M3-19 salary visible to Admin and HR only; Employee never sees salary structures', async () => {
    expect((await A.get(`/employees/${ctx.emp.sara.id}`)).body.salary.gross).toBe(120000);
    expect((await H.get(`/employees/${ctx.emp.sara.id}`)).body.salary.gross).toBe(120000);
    expect((await A.get(`/employees/${ctx.emp.sara.id}/salary`)).status).toBe(200);
    const own = await E.get(`/employees/${ctx.emp.ali.id}`);
    expect(own.body.salary).toBeUndefined();
    expect((await E.get(`/employees/${ctx.emp.ali.id}/salary`)).status).toBe(403);
    expect((await E.get(`/employees/${ctx.emp.ali.id}/360`)).body.salaryHistory).toEqual([]);
    const dir = await E.get('/employees');
    expect(JSON.stringify(dir.body)).not.toMatch(/basic|gross|salary/i);
  });
});

describe('M3 CSV import and export (08)', () => {
  it('M3-20 dry run of a clean file: all rows valid, nothing saved', async () => {
    const before = await ctx.count('employees');
    const csv = [HEADER, 'C-001,Clean One,clean1@test.co,,female,Engineering,Developer,full_time,2026-05-01,45000,', 'C-002,Clean Two,clean2@test.co,,male,SAL,,contract,2026-05-02,46000,'].join('\n');
    const res = await upload(ctx.tok.hr, csv, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, totalRows: 2, validRows: 2, errors: [] });
    expect(await ctx.count('employees')).toBe(before);
    expect(await ctx.count('users', "email like 'clean%'")).toBe(0);
  });

  it('M3-21 dry run reports every bad row with row number + field + reason; nothing saved', async () => {
    const before = await ctx.count('employees');
    const csv = [
      HEADER,
      'D-001,,missing@test.co,,male,ENG,,full_time,2026-05-01,45000,', // row 2: missing full_name
      'D-002,Dup In File A,dupa@test.co,,male,ENG,,full_time,2026-05-01,45000,', // row 3: ok
      'D-002,Dup In File B,dupb@test.co,,male,ENG,,full_time,2026-05-01,45000,', // row 4: duplicate code in file
      'EMP-001,Already In DB,indb@test.co,,male,ENG,,full_time,2026-05-01,45000,', // row 5: code in DB
      'D-005,Bad Email,not-an-email,,male,ENG,,full_time,2026-05-01,45000,', // row 6
      'D-006,Unknown Dept,ud@test.co,,male,Marketing,,full_time,2026-05-01,45000,', // row 7
      'D-007,Non ISO,ni@test.co,,male,ENG,,full_time,01/05/2026,45000,', // row 8
      'D-008,Zero Salary,zs@test.co,,male,ENG,,full_time,2026-05-01,0,', // row 9
      'D-009,Negative Salary,ns@test.co,,male,ENG,,full_time,2026-05-01,-100,', // row 10
      'D-010,Text Salary,ts@test.co,,male,ENG,,full_time,2026-05-01,lots,', // row 11
    ].join('\n');
    const res = await upload(ctx.tok.hr, csv, true);
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(10);
    expect(res.body.validRows).toBe(1);
    const has = (row, field) => res.body.errors.some((e) => e.row === row && e.field === field && e.reason);
    expect(has(2, 'full_name')).toBe(true);
    expect(has(4, 'employee_code')).toBe(true);
    expect(has(5, 'employee_code')).toBe(true);
    expect(has(6, 'email')).toBe(true);
    expect(has(7, 'department')).toBe(true);
    expect(has(8, 'join_date')).toBe(true);
    expect(has(9, 'basic_salary')).toBe(true);
    expect(has(10, 'basic_salary')).toBe(true);
    expect(has(11, 'basic_salary')).toBe(true);
    expect(res.body.errors.some((e) => e.row === 3)).toBe(false);
    expect(await ctx.count('employees')).toBe(before);
  });

  it('M3-22 commit after a clean dry run creates employees with logins; counts match; audited', async () => {
    const before = await ctx.count('employees');
    const csv = [HEADER, 'C-001,Clean One,clean1@test.co,,female,Engineering,Developer,full_time,2026-05-01,45000,', 'C-002,Clean Two,clean2@test.co,,male,SAL,,contract,2026-05-02,46000,'].join('\n');
    expect((await upload(ctx.tok.hr, csv, true)).body.errors).toEqual([]);
    const res = await upload(ctx.tok.hr, csv, false);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(await ctx.count('employees')).toBe(before + 2);
    const creds = parse(res.body.credentialsCsv, { columns: true });
    expect(creds.map((c) => c.email)).toEqual(['clean1@test.co', 'clean2@test.co']);
    const login = await loginRes('clean1@test.co', creds[0].temp_password);
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await ctx.db.one("select gross from salary_structures s join employees e on e.id = s.employee_id where e.employee_code = 'C-001'")).gross).toBe(67500);
    const audit = (await A.get('/audit', { action: 'EMPLOYEE_IMPORTED' })).body.items;
    expect(audit.some((a) => a.after?.count === 2)).toBe(true);
  });

  it('M3-23 [decide] mixed file: import is all-or-nothing (commit refused with the report, nothing saved)', async () => {
    const before = await ctx.count('employees');
    const csv = [HEADER, 'M-001,Mixed Good,mixedgood@test.co,,male,ENG,,full_time,2026-05-01,45000,', 'M-002,Mixed Bad,bad,,male,ENG,,full_time,2026-05-01,45000,'].join('\n');
    const res = await upload(ctx.tok.hr, csv, false);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_HAS_ERRORS');
    expect(res.body.error.details).toEqual([{ row: 3, field: 'email', reason: 'Invalid email' }]);
    expect(await ctx.count('employees')).toBe(before);
  });

  it('M3-24 bad files (empty, wrong headers, non-CSV, >1 MB, commas/quotes in cells): clear error or correct parsing, no crash', async () => {
    const before = await ctx.count('employees');
    const empty = await upload(ctx.tok.hr, '', true);
    expect(empty.status).toBeLessThan(500);
    const emptyCommit = await upload(ctx.tok.hr, '', false);
    expect([400, 422]).toContain(emptyCommit.status);
    const wrong = await upload(ctx.tok.hr, 'foo,bar,baz\n1,2,3\n', true);
    expect(wrong.status).toBe(200);
    expect(wrong.body.validRows).toBe(0);
    expect(wrong.body.errors.some((e) => e.field === 'employee_code' && e.reason === 'Required')).toBe(true);
    const binary = await upload(ctx.tok.hr, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x22, 0x0a, 0x22, 0x22, 0x2c]), true, 'image.png');
    expect(binary.status).toBeGreaterThanOrEqual(400);
    expect(binary.status).toBeLessThan(500);
    const quoted = [HEADER, 'Q-001,"Khan, Ali ""Jr""",quoted@test.co,,male,ENG,,full_time,2026-05-01,45000,"Flat 2, Block ""B"", Karachi"'].join('\n');
    const q = await upload(ctx.tok.hr, quoted, false);
    expect(q.status).toBe(201);
    const row = await ctx.db.one("select full_name, address from employees where employee_code = 'Q-001'");
    expect(row).toEqual({ fullName: 'Khan, Ali "Jr"', address: 'Flat 2, Block "B", Karachi' });
    expect(await ctx.count('employees')).toBe(before + 1);
    const big = await upload(ctx.tok.hr, Buffer.alloc(1024 * 1024 + 100, 'a'), true);
    expect(big.status, `>1 MB upload returned ${big.status}`).toBeGreaterThanOrEqual(400);
    expect(big.status).toBeLessThan(500);
    expect(big.body.error?.message).toBeTruthy();
  });

  it('M3-25 export: correct columns, row count matches the directory, special characters escaped', async () => {
    if (!(await ctx.count('employees', "employee_code = 'Q-001'"))) {
      expect((await H.post('/employees', newEmp({ employeeCode: 'Q-001', email: 'quoted@test.co', fullName: 'Khan, Ali "Jr"' }))).status).toBe(201);
    }
    const res = await exportCsv(ctx.tok.hr);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const rows = parse(res.body, { columns: true });
    expect(Object.keys(rows[0])).toEqual(['employee_code', 'full_name', 'email', 'phone', 'gender', 'department', 'designation', 'employment_type', 'join_date', 'status']);
    expect(rows.length).toBe((await H.get('/employees')).body.total);
    expect(rows.find((r) => r.employee_code === 'Q-001').full_name).toBe('Khan, Ali "Jr"');
    const filtered = parse((await exportCsv(ctx.tok.hr, { departmentId: ctx.ids.eng })).body, { columns: true });
    expect(filtered.length).toBe((await H.get('/employees', { departmentId: ctx.ids.eng })).body.total);
  });

  it('M3-26 export neutralises CSV injection (cells starting with = + - @)', async () => {
    expect((await H.post('/employees', newEmp({ employeeCode: 'EMP-600', email: 'inj1@test.co', fullName: '=HYPERLINK("http://evil","x")' }))).status).toBe(201);
    expect((await H.post('/employees', newEmp({ employeeCode: 'EMP-601', email: 'inj2@test.co', fullName: '+SUM(1+1)' }))).status).toBe(201);
    const rows = parse((await exportCsv(ctx.tok.hr)).body, { columns: true });
    for (const code of ['EMP-600', 'EMP-601']) {
      const name = rows.find((r) => r.employee_code === code).full_name;
      expect(/^[=+\-@]/.test(name), `exported cell "${name}" is still a formula`).toBe(false);
    }
  });

  it('M3-27 Admin and Employee cannot use CSV import or export (403)', async () => {
    const before = await ctx.count('employees');
    const csv = [HEADER, 'Z-001,Zed,zed@test.co,,male,ENG,,full_time,2026-05-01,45000,'].join('\n');
    for (const t of [ctx.tok.admin, ctx.tok.ali]) {
      expect((await upload(t, csv, true)).status).toBe(403);
      expect((await upload(t, csv, false)).status).toBe(403);
      expect((await exportCsv(t)).status).toBe(403);
      expect((await ctx.as(t).get('/employees/import/template')).status).toBe(403);
    }
    expect(await ctx.count('employees')).toBe(before);
  });
});
