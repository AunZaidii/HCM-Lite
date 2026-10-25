// QA — M2 Organization setup (HCM_Lite_Test_Plan.md §4.2–4.4, M2-07..M2-25). Schema qa_m2, baseline via API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

let ctx;
let A; let H; let E;
let ip = 0;
const loginRes = (email, password) => ctx.api.post('/api/auth/login').set('X-Forwarded-For', `10.3.0.${++ip}`).send({ email, password });

beforeAll(async () => {
  ctx = await qa('qa_m2');
  A = ctx.as(ctx.tok.admin);
  H = ctx.as(ctx.tok.hr);
  E = ctx.as(ctx.tok.ali);
});
afterAll(async () => ctx?.close());

const settings = async () => ctx.db.one('select * from company_settings where id = 1');

describe('M2 company settings (03)', () => {
  it('M2-07 Admin edits settings: saved, visible after refresh, audited with before/after', async () => {
    const res = await A.put('/settings', {
      officeStart: '09:30', graceMinutes: 10, halfDayHours: 4.5, weekendDays: [5, 6], officeLat: 31.5204, officeLng: 74.3587, officeRadiusM: 200,
    });
    expect(res.status).toBe(200);
    const again = await A.get('/settings');
    expect(again.body).toMatchObject({ officeStart: '09:30:00', graceMinutes: 10, halfDayHours: 4.5, weekendDays: [5, 6], officeLat: 31.5204, officeLng: 74.3587, officeRadiusM: 200 });
    const audit = (await A.get('/audit', { action: 'SETTINGS_UPDATED' })).body.items[0];
    expect(audit.before.graceMinutes).toBe(15);
    expect(audit.after.graceMinutes).toBe(10);
    expect(audit.before.officeStart).toBe('09:00:00');
    expect(audit.after.officeStart).toBe('09:30:00');
    // restore baseline
    expect((await A.put('/settings', { officeStart: '09:00', graceMinutes: 15, halfDayHours: 5, weekendDays: [6, 7], officeLat: 24.8607, officeLng: 67.0011, officeRadiusM: 150 })).status).toBe(200);
  });

  it('M2-08 HR views settings read-only; update returns 403 and nothing changes', async () => {
    expect((await H.get('/settings')).status).toBe(200);
    const res = await H.put('/settings', { graceMinutes: 45 });
    expect(res.status).toBe(403);
    expect((await settings()).graceMinutes).toBe(15);
  });

  it('M2-09 Employee: settings read and update both 403', async () => {
    expect((await E.get('/settings')).status).toBe(403);
    expect((await E.put('/settings', { graceMinutes: 45 })).status).toBe(403);
    expect((await settings()).graceMinutes).toBe(15);
  });

  it('M2-10 invalid setting values are rejected with clear messages; nothing changes', async () => {
    const bad = [
      [{ graceMinutes: -5 }, 'graceMinutes'],
      [{ officeRadiusM: 0 }, 'officeRadiusM'],
      [{ officeRadiusM: -100 }, 'officeRadiusM'],
      [{ officeLat: 91 }, 'officeLat'],
      [{ officeLat: -90.5 }, 'officeLat'],
      [{ officeLng: 181 }, 'officeLng'],
      [{ officeLng: -200 }, 'officeLng'],
      [{ officeStart: '25:99' }, 'officeStart'],
      [{ officeStart: 'nine' }, 'officeStart'],
    ];
    const before = await settings();
    for (const [body, field] of bad) {
      const res = await A.put('/settings', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.map((d) => d.field)).toContain(field);
    }
    const after = await settings();
    expect(after).toMatchObject({ graceMinutes: before.graceMinutes, officeRadiusM: before.officeRadiusM, officeLat: before.officeLat, officeLng: before.officeLng, officeStart: before.officeStart });
  });

  it('M2-11 settings apply to new records only (grace 15 → 30 between two 09:20 check-ins)', async () => {
    ctx.at('2026-11-03T09:20');
    const ali = await E.post('/attendance/check-in');
    expect(ali.status).toBe(201);
    expect(ali.body.status).toBe('late');
    expect((await A.put('/settings', { graceMinutes: 30 })).status).toBe(200);
    const aliAfter = (await E.get('/attendance/today')).body.record;
    expect(aliAfter.status).toBe('late');
    expect(aliAfter.ruleGraceMinutes).toBe(15);
    const sara = await ctx.as(ctx.tok.sara).post('/attendance/check-in');
    expect(sara.status).toBe(201);
    expect(sara.body.status).toBe('present');
    expect(sara.body.ruleGraceMinutes).toBe(30);
    expect((await A.put('/settings', { graceMinutes: 15 })).status).toBe(200);
  });

  it('M2-12 weekend change to Fri–Sat: new working-day calculations use it; old records unchanged', async () => {
    const oldRecord = await ctx.db.one('select * from attendance where employee_id = $1', [ctx.emp.ali.id]);
    expect((await A.put('/settings', { weekendDays: [5, 6] })).status).toBe(200);
    // Fri 13 Nov is now a weekend, Sun 15 Nov is now a working day
    const fri = await E.post('/leave/preview', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-13', endDate: '2026-11-13' });
    expect(fri.body.workingDays).toBe(0);
    const sun = await E.post('/leave/preview', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-15', endDate: '2026-11-15' });
    expect(sun.body.workingDays).toBe(1);
    const newRecord = await ctx.db.one('select * from attendance where employee_id = $1', [ctx.emp.ali.id]);
    expect(newRecord).toEqual(oldRecord);
    expect((await A.put('/settings', { weekendDays: [6, 7] })).status).toBe(200);
  });
});

describe('M2 departments, designations, leave types, holidays (04)', () => {
  it('M2-13 Admin creates, edits and deletes each item; items appear in the dropdown lists', async () => {
    const dep = await A.post('/departments', { name: 'Finance', code: 'FIN' });
    expect(dep.status).toBe(201);
    expect((await A.put(`/departments/${dep.body.id}`, { name: 'Finance & Accounts' })).body.name).toBe('Finance & Accounts');
    expect((await H.get('/departments')).body.map((d) => d.name)).toContain('Finance & Accounts');
    const des = await A.post('/designations', { title: 'Accountant', departmentId: dep.body.id });
    expect(des.status).toBe(201);
    expect((await A.put(`/designations/${des.body.id}`, { title: 'Senior Accountant' })).body.title).toBe('Senior Accountant');
    expect((await H.get('/designations')).body.map((d) => d.title)).toContain('Senior Accountant');
    const lt = await A.post('/leave-types', { name: 'Study', code: 'study', yearlyQuota: 3, isPaid: true });
    expect(lt.status).toBe(201);
    expect(lt.body.code).toBe('STUDY');
    expect((await A.put(`/leave-types/${lt.body.id}`, { yearlyQuota: 4 })).body.yearlyQuota).toBe(4);
    const hol = await A.post('/holidays', { date: '2026-12-25', name: 'Quaid Day' });
    expect(hol.status).toBe(201);
    expect((await A.put(`/holidays/${hol.body.id}`, { name: 'Quaid-e-Azam Day' })).body.name).toBe('Quaid-e-Azam Day');
    expect((await H.get('/holidays')).body.map((h) => h.date)).toContain('2026-12-25');
    for (const [path, id] of [['designations', des.body.id], ['departments', dep.body.id], ['leave-types', lt.body.id], ['holidays', hol.body.id]]) {
      expect((await A.del(`/${path}/${id}`)).status, path).toBe(204);
    }
    expect(await ctx.count('departments', "code = 'FIN'")).toBe(0);
    expect(await ctx.count('leave_types', "code = 'STUDY'")).toBe(0);
    expect(await ctx.count('holidays', "date = '2026-12-25'")).toBe(0);
  });

  it('M2-14 duplicate department name is rejected', async () => {
    const before = await ctx.count('departments');
    const res = await A.post('/departments', { name: 'Engineering', code: 'ENG2' });
    expect([400, 409, 422]).toContain(res.status);
    const caseVariant = await A.post('/departments', { name: 'ENGINEERING', code: 'ENG3' });
    expect([400, 409, 422]).toContain(caseVariant.status);
    expect(await ctx.count('departments')).toBe(before);
  });

  it('M2-15 deleting a department in use is blocked with a clear message; employees unaffected', async () => {
    const res = await A.del(`/departments/${ctx.ids.eng}`);
    expect([409, 422]).toContain(res.status);
    expect(res.body.error.message).toMatch(/in use/i);
    expect(await ctx.count('departments', 'id = $1', [ctx.ids.eng])).toBe(1);
    expect((await ctx.db.one('select department_id from employees where id = $1', [ctx.emp.ali.id])).departmentId).toBe(ctx.ids.eng);
    // offered alternative: deactivate
    expect((await A.put(`/departments/${ctx.ids.eng}`, { isActive: false })).body.isActive).toBe(false);
    expect((await A.put(`/departments/${ctx.ids.eng}`, { isActive: true })).body.isActive).toBe(true);
  });

  it('M2-16 leave type quota: valid edit saved; negative or non-numeric rejected', async () => {
    const ok = await A.put(`/leave-types/${ctx.ids.types.ANNUAL}`, { yearlyQuota: 15 });
    expect(ok.status).toBe(200);
    expect(ok.body.yearlyQuota).toBe(15);
    expect((await A.put(`/leave-types/${ctx.ids.types.ANNUAL}`, { yearlyQuota: -1 })).status).toBe(400);
    expect((await A.put(`/leave-types/${ctx.ids.types.ANNUAL}`, { yearlyQuota: 'abc' })).status).toBe(400);
    expect((await ctx.db.one('select yearly_quota from leave_types where id = $1', [ctx.ids.types.ANNUAL])).yearlyQuota).toBe(15);
    await A.put(`/leave-types/${ctx.ids.types.ANNUAL}`, { yearlyQuota: 14 });
  });

  it('M2-17 holiday validation: duplicate and invalid dates rejected; weekend holiday not double counted', async () => {
    const before = await ctx.count('holidays');
    expect([400, 409, 422]).toContain((await A.post('/holidays', { date: '2026-11-09', name: 'Dup' })).status);
    expect((await A.post('/holidays', { date: '2026-13-45', name: 'Bad' })).status).toBe(400);
    expect((await A.post('/holidays', { date: 'tomorrow', name: 'Bad' })).status).toBe(400);
    expect(await ctx.count('holidays')).toBe(before);
    const sat = await A.post('/holidays', { date: '2026-11-14', name: 'Saturday holiday' });
    expect(sat.status).toBe(201);
    // Fri 13 → Mon 16: Fri + Mon = 2 (Sat is weekend AND holiday — counted once, as non-working)
    const p = await E.post('/leave/preview', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(p.body.workingDays).toBe(2);
    await A.del(`/holidays/${sat.body.id}`);
  });

  it('M2-18 a new leave type appears in the employee leave form and balance', async () => {
    const lt = await A.post('/leave-types', { name: 'Hajj', code: 'HAJJ', yearlyQuota: 5, isPaid: true });
    expect(lt.status).toBe(201);
    expect((await E.get('/leave-types', { active: 'true' })).body.map((t) => t.code)).toContain('HAJJ');
    const bal = (await E.get('/leave/balance')).body.find((b) => b.code === 'HAJJ');
    expect(bal).toMatchObject({ quota: 5, approved: 0, remaining: 5 });
  });

  it('M2-19 HR can view each setup list but every write returns 403', async () => {
    const before = { d: await ctx.count('departments'), g: await ctx.count('designations'), l: await ctx.count('leave_types'), h: await ctx.count('holidays') };
    for (const path of ['departments', 'designations', 'leave-types', 'holidays']) {
      expect((await H.get(`/${path}`)).status, path).toBe(200);
    }
    const writes = [
      await H.post('/departments', { name: 'Ops', code: 'OPS' }), await H.put(`/departments/${ctx.ids.eng}`, { name: 'X' }), await H.del(`/departments/${ctx.ids.sales}`),
      await H.post('/designations', { title: 'Boss' }), await H.put(`/designations/${ctx.ids.dev}`, { title: 'X' }), await H.del(`/designations/${ctx.ids.dev}`),
      await H.post('/leave-types', { name: 'Free', code: 'FREE', yearlyQuota: 99 }), await H.put(`/leave-types/${ctx.ids.types.SICK}`, { yearlyQuota: 99 }), await H.del(`/leave-types/${ctx.ids.types.SICK}`),
      await H.post('/leave-types/standard'),
      await H.post('/holidays', { date: '2026-12-31', name: 'X' }), await H.put(`/holidays/${ctx.ids.holiday}`, { name: 'X' }), await H.del(`/holidays/${ctx.ids.holiday}`),
    ];
    for (const r of writes) expect(r.status).toBe(403);
    expect({ d: await ctx.count('departments'), g: await ctx.count('designations'), l: await ctx.count('leave_types'), h: await ctx.count('holidays') }).toEqual(before);
    expect((await ctx.db.one('select yearly_quota from leave_types where id = $1', [ctx.ids.types.SICK])).yearlyQuota).toBe(8);
  });

  it('M2-20 Employee has no access to the setup APIs (403)', async () => {
    const before = await ctx.count('departments');
    const writes = [
      await E.post('/departments', { name: 'Ops', code: 'OPS' }), await E.put(`/departments/${ctx.ids.eng}`, { name: 'X' }), await E.del(`/departments/${ctx.ids.sales}`),
      await E.post('/designations', { title: 'Boss' }), await E.post('/leave-types', { name: 'Free', code: 'FREE', yearlyQuota: 99 }),
      await E.post('/leave-types/standard'), await E.post('/holidays', { date: '2026-12-31', name: 'X' }), await E.get('/settings'), await E.put('/settings', {}),
    ];
    for (const r of writes) expect(r.status).toBe(403);
    expect(await ctx.count('departments')).toBe(before);
    // Plan: "E calls setup APIs → 403". Lookup reads are refused too (the checklist gives E no access to item 04).
    for (const path of ['departments', 'designations', 'holidays']) {
      expect((await E.get(`/${path}`)).status, `GET /${path} as Employee`).toBe(403);
    }
  });
});

describe('M2 user logins (05)', () => {
  it('M2-21 Admin creates an HR login; HR must change the temporary password', async () => {
    const res = await A.post('/users', { role: 'hr', employeeCode: 'HR-002', fullName: 'Hamza HR', email: 'hr2@test.co', departmentId: ctx.ids.eng, joinDate: '2026-02-01', basicSalary: 70000 });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('hr');
    const login = await loginRes('hr2@test.co', res.body.tempPassword);
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await ctx.as(login.body.token).get('/employees')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await ctx.as(login.body.token).post('/auth/change-password', { currentPassword: res.body.tempPassword, newPassword: 'Hamza1234' });
    expect(changed.status).toBe(200);
    expect((await ctx.as(changed.body.token).get('/employees')).status).toBe(200);
  });

  it('M2-22 duplicate email is rejected (409/422)', async () => {
    const before = await ctx.count('users');
    const res = await A.post('/users', { role: 'hr', employeeCode: 'HR-003', fullName: 'Dup HR', email: 'hr@test.co', departmentId: ctx.ids.eng, joinDate: '2026-02-01', basicSalary: 70000 });
    expect([409, 422]).toContain(res.status);
    const upper = await A.post('/users', { role: 'hr', employeeCode: 'HR-004', fullName: 'Dup HR', email: 'HR@TEST.CO', departmentId: ctx.ids.eng, joinDate: '2026-02-01', basicSalary: 70000 });
    expect([409, 422]).toContain(upper.status);
    expect(await ctx.count('users')).toBe(before);
  });

  it('M2-23 HR cannot create HR or Admin logins (403)', async () => {
    const before = await ctx.count('users');
    for (const role of ['hr', 'admin']) {
      const res = await H.post('/users', { role, employeeCode: `X-${role}`, fullName: 'Nope', email: `${role}x@test.co`, departmentId: ctx.ids.eng, joinDate: '2026-02-01', basicSalary: 70000 });
      expect(res.status).toBe(403);
    }
    expect(await ctx.count('users')).toBe(before);
    // Admin cannot create a second Admin either
    const admin2 = await A.post('/users', { role: 'admin', employeeCode: 'A-2', fullName: 'Admin Two', email: 'admin2@test.co', departmentId: ctx.ids.eng, joinDate: '2026-02-01', basicSalary: 70000 });
    expect([403, 422]).toContain(admin2.status);
    expect(await ctx.count('users', "role = 'admin'")).toBe(1);
  });

  it('M2-24 Admin deactivates then reactivates an employee login', async () => {
    const usman = await ctx.db.one("select id from users where email = 'usman@test.co'");
    expect((await A.post(`/users/${usman.id}/deactivate`)).status).toBe(200);
    expect((await loginRes('usman@test.co', 'Usmanpass123')).status).toBe(401);
    expect((await ctx.as(ctx.tok.usman).get('/auth/me')).status).toBe(401);
    expect((await A.post(`/users/${usman.id}/reactivate`)).status).toBe(200);
    expect((await loginRes('usman@test.co', 'Usmanpass123')).status).toBe(200);
    expect((await ctx.as(ctx.tok.usman).get('/auth/me')).status).toBe(200);
  });

  it('M2-25 [decide] Admin deactivating own account is blocked', async () => {
    const me = (await A.get('/auth/me')).body.user;
    const res = await A.post(`/users/${me.id}/deactivate`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
    expect((await ctx.db.one('select is_active from users where id = $1', [me.id])).isActive).toBe(true);
  });
});
