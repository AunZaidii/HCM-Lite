// Shared QA harness for tests/qa (HCM_Lite_Test_Plan.md).
// Every test file gets its own fresh, empty Postgres schema (never the real data), a frozen controllable clock,
// role clients that call the API with each role's JWT, and the §2 baseline data created through the API only.
//
// Usage in a test file (no static imports from src/ — env must be set first):
//   const ctx = await qa('qa_m1');           // in beforeAll
//   ctx.at('2026-11-02T09:00');              // Karachi local time
//   await ctx.as(ctx.tok.hr).get('/employees');
import request from 'supertest';

export const KHI = (local) => new Date(`${local.length === 16 ? `${local}:00` : local}+05:00`);

export async function qa(schema, { baseline = true, clock = '2026-11-02T08:30', aiKey = '' } = {}) {
  process.env.DB_SCHEMA = schema;
  process.env.NODE_ENV = 'test';
  process.env.AI_API_KEY = aiKey;
  const { applySchema, pool } = await import('../../scripts/schema.js');
  const { app } = await import('../../src/app.js');
  const { db } = await import('../../src/lib/db.js');
  const { setTestNow } = await import('../../src/lib/clock.js');
  const { env } = await import('../../src/config/env.js');

  await applySchema({ reset: true });
  const api = request(app);
  const at = (local) => setTestNow(KHI(local));
  at(clock);

  const as = (token) => {
    const auth = (r) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
    return {
      get: (url, query) => auth(api.get(`/api${url}`)).query(query || {}),
      post: (url, body) => auth(api.post(`/api${url}`)).send(body),
      put: (url, body) => auth(api.put(`/api${url}`)).send(body),
      patch: (url, body) => auth(api.patch(`/api${url}`)).send(body),
      del: (url) => auth(api.delete(`/api${url}`)),
      raw: api,
    };
  };

  const ctx = { api, as, db, pool, env, at, setTestNow, tok: {}, ids: {}, emp: {}, temp: {} };

  ctx.login = async (email, password) => {
    const res = await api.post('/api/auth/login').send({ email, password });
    if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token;
  };
  ctx.firstLogin = async (email, temp, password) => {
    const t = await ctx.login(email, temp);
    const res = await as(t).post('/auth/change-password', { currentPassword: temp, newPassword: password });
    if (res.status !== 200) throw new Error(`change password ${email} failed: ${res.status}`);
    return res.body.token;
  };
  // Re-reads a table count — used to prove "nothing was saved".
  ctx.count = async (table, where = 'true', params = []) => (await db.one(`select count(*)::int as n from ${table} where ${where}`, params)).n;
  ctx.close = async () => { setTestNow(null); await pool.end(); };

  if (baseline) await buildBaseline(ctx);
  return ctx;
}

// §2 Baseline test data, created through the app's API.
export async function buildBaseline(ctx) {
  const { as, ids, tok, emp } = ctx;
  const setup = await ctx.api.post('/api/setup').send({
    companyName: 'QA Co', officeStart: '09:00', officeEnd: '18:00', graceMinutes: 15, halfDayHours: 5, weekendDays: [6, 7],
    admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'Admin1234' },
  });
  if (setup.status !== 201) throw new Error(`setup failed ${setup.status} ${JSON.stringify(setup.body)}`);
  tok.admin = setup.body.token;
  const A = as(tok.admin);
  await A.put('/settings', { officeLat: 24.8607, officeLng: 67.0011, officeRadiusM: 150, cameraCheckinEnabled: true });
  ids.eng = (await A.post('/departments', { name: 'Engineering', code: 'ENG' })).body.id;
  ids.sales = (await A.post('/departments', { name: 'Sales', code: 'SAL' })).body.id;
  ids.dev = (await A.post('/designations', { title: 'Developer', departmentId: ids.eng })).body.id;
  ids.salesExec = (await A.post('/designations', { title: 'Sales Executive', departmentId: ids.sales })).body.id;
  ids.hrOfficer = (await A.post('/designations', { title: 'HR Officer' })).body.id;
  const types = (await A.post('/leave-types/standard')).body;
  ids.types = Object.fromEntries(types.map((t) => [t.code, t.id]));
  ids.holiday = (await A.post('/holidays', { date: '2026-11-09', name: 'Iqbal Day' })).body.id;

  const hr = await A.post('/users', {
    role: 'hr', employeeCode: 'HR-001', fullName: 'Hina HR', email: 'hr@test.co', departmentId: ids.eng, designationId: ids.hrOfficer,
    joinDate: '2026-01-01', basicSalary: 50000, status: 'active', gender: 'female',
  });
  if (hr.status !== 201) throw new Error(`HR create failed ${hr.status} ${JSON.stringify(hr.body)}`);
  emp.hr = hr.body.employee;
  ctx.temp.hr = hr.body.tempPassword;
  tok.hr = await ctx.firstLogin('hr@test.co', hr.body.tempPassword, 'Hrpass123');

  const H = as(tok.hr);
  const people = [
    ['ali', 'EMP-001', 'Ali Khan', 'ali@test.co', ids.eng, ids.dev, 100000, 'male'],
    ['sara', 'EMP-002', 'Sara Ahmed', 'sara@test.co', ids.eng, ids.dev, 80000, 'female'],
    ['usman', 'EMP-003', 'Usman Tariq', 'usman@test.co', ids.sales, ids.salesExec, 60000, 'male'],
  ];
  for (const [key, code, name, email, dept, desig, basic, gender] of people) {
    const res = await H.post('/employees', { employeeCode: code, fullName: name, email, departmentId: dept, designationId: desig, joinDate: '2026-01-01', basicSalary: basic, gender, status: 'active' });
    if (res.status !== 201) throw new Error(`register ${name} failed ${res.status} ${JSON.stringify(res.body)}`);
    emp[key] = res.body.employee;
    ctx.temp[key] = res.body.tempPassword;
    tok[key] = await ctx.firstLogin(email, res.body.tempPassword, `${key[0].toUpperCase()}${key.slice(1)}pass123`);
  }
  return ctx;
}

// Working days (Mon–Fri) in a range, skipping listed holidays — for building attendance with the clock.
export function workingDays(from, to, holidays = ['2026-11-09']) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.includes(iso)) out.push(iso);
  }
  return out;
}

// Check in at `inTime` and (optionally) out at `outTime` on a given day using the frozen clock.
export async function attend(ctx, token, date, inTime = '09:00', outTime = '17:30') {
  ctx.at(`${date}T${inTime}`);
  const i = await ctx.as(token).post('/attendance/check-in');
  if (i.status !== 201) throw new Error(`check-in ${date} failed ${i.status} ${JSON.stringify(i.body)}`);
  if (outTime) {
    ctx.at(`${date}T${outTime}`);
    const o = await ctx.as(token).post('/attendance/check-out');
    if (o.status !== 200) throw new Error(`check-out ${date} failed ${o.status}`);
  }
  return i.body;
}
