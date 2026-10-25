// M9 — Comms & Audit (HCM_Lite_Test_Plan.md §11): announcements, notifications, audit log. Schema: qa_m9.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

const LONG = 1_200_000;
let ctx; let A; let H; let E; let S;
const notes = async (client) => (await client.get('/notifications')).body;

beforeAll(async () => {
  ctx = await qa('qa_m9', { clock: '2026-11-03T10:00' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr); E = ctx.as(ctx.tok.ali); S = ctx.as(ctx.tok.sara);
}, LONG);
afterAll(async () => ctx?.close());

describe('11.1 Announcements', () => {
  it('M9-01 Admin posts → visible to Admin, HR and Employee, newest first', async () => {
    const r = await A.post('/announcements', { title: 'Welcome to HCM Lite', body: 'Please check in every day.', audience: 'all' });
    expect(r.status).toBe(201);
    for (const c of [A, H, E]) expect((await c.get('/announcements')).body[0].id).toBe(r.body.id);
    ctx.ids.adminPost = r.body.id;
  });

  it('M9-02 HR posts → same, and becomes the newest', async () => {
    ctx.at('2026-11-03T10:05');
    const r = await H.post('/announcements', { title: 'Eid holidays', body: 'Office closed on Monday.', audience: 'all' });
    expect(r.status).toBe(201);
    for (const c of [A, H, E]) {
      const list = (await c.get('/announcements')).body;
      expect(list[0].id).toBe(r.body.id);
      expect(list.map((x) => x.id)).toContain(ctx.ids.adminPost);
    }
  });

  it('M9-03 Employee cannot post (403), nothing saved', async () => {
    const before = await ctx.count('announcements');
    expect((await E.post('/announcements', { title: 'Party', body: 'Friday!', audience: 'all' })).status).toBe(403);
    expect(await ctx.count('announcements')).toBe(before);
  });

  it('M9-04 empty title or body rejected, nothing saved', async () => {
    const before = await ctx.count('announcements');
    expect((await H.post('/announcements', { title: '', body: 'x y z' })).status).toBe(400);
    expect((await H.post('/announcements', { title: 'Title', body: '' })).status).toBe(400);
    expect(await ctx.count('announcements')).toBe(before);
  });

  it('M9-05 long text, Urdu and emoji are stored exactly (layout = MANUAL)', async () => {
    const body = `${'طویل متن '.repeat(150)}🎉👍`.slice(0, 2000);
    const r = await H.post('/announcements', { title: 'اعلان — Eid Mubarak 🎉', body, audience: 'all' });
    expect(r.status).toBe(201);
    const got = (await E.get('/announcements')).body.find((a) => a.id === r.body.id);
    expect(got.title).toBe('اعلان — Eid Mubarak 🎉');
    expect(got.body).toBe(body);
  });

  it('M9-06 script/HTML body is stored and returned as plain text (rendering = MANUAL)', async () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const r = await H.post('/announcements', { title: 'XSS test', body: evil, audience: 'all' });
    expect((await E.get('/announcements')).body.find((a) => a.id === r.body.id).body).toBe(evil);
  });

  it('M9-07 posting an announcement writes an audit entry', async () => {
    const rows = (await A.get('/audit', { action: 'ANNOUNCEMENT_POSTED' })).body.items;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((r) => r.actorRole === 'admin')).toBe(true);
    expect(rows.some((r) => r.actorRole === 'hr')).toBe(true);
  });
});

describe('11.2 Notifications', () => {
  it('M9-08 leave decisions notify the employee with the decision and comment', async () => {
    const before = (await notes(E)).items.filter((n) => n.type === 'LEAVE_DECIDED').length;
    const l1 = await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-10', endDate: '2026-11-10', reason: 'Errand' });
    const l2 = await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-11', endDate: '2026-11-11', reason: 'Errand' });
    await H.post(`/leave/requests/${l1.body.id}/approve`, { comment: 'Enjoy' });
    await H.post(`/leave/requests/${l2.body.id}/reject`, { comment: 'Busy week' });
    const decided = (await notes(E)).items.filter((n) => n.type === 'LEAVE_DECIDED');
    expect(decided.length - before).toBe(2);
    expect(decided.some((n) => /approved/.test(n.title) && n.body === 'Enjoy')).toBe(true);
    expect(decided.some((n) => /rejected/.test(n.title) && n.body === 'Busy week')).toBe(true);
  });

  it('M9-09 correction decisions notify the employee', async () => {
    const c1 = await E.post('/attendance/corrections', { date: '2026-11-02', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'Forgot to check in' });
    const c2 = await S.post('/attendance/corrections', { date: '2026-11-02', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'Forgot to check in' });
    await H.post(`/attendance/corrections/${c1.body.id}/approve`, { comment: 'Fixed' });
    await H.post(`/attendance/corrections/${c2.body.id}/reject`, { comment: 'No evidence' });
    expect((await notes(E)).items.some((n) => n.type === 'CORRECTION_DECIDED' && /approved/.test(n.title))).toBe(true);
    expect((await notes(S)).items.some((n) => n.type === 'CORRECTION_DECIDED' && /rejected/.test(n.title) && n.body === 'No evidence')).toBe(true);
  });

  it('M9-10 finalizing payroll notifies every employee in the run', async () => {
    const run = await H.post('/payroll/runs', { month: '2026-10' });
    expect(run.status).toBe(201);
    expect((await A.post(`/payroll/runs/${run.body.id}/finalize`)).status).toBe(200);
    const users = [ctx.emp.hr, ctx.emp.ali, ctx.emp.sara, ctx.emp.usman].map((e) => e.userId);
    const n = await ctx.db.query("select user_id from notifications where type = 'PAYSLIP_READY'");
    expect(n.map((r) => r.userId).sort()).toEqual(users.sort());
  });

  it("M9-11 users see only their own notifications; touching another user's returns 403/404", async () => {
    const mine = (await notes(E)).items;
    expect(mine.length).toBeGreaterThan(0);
    const owners = await ctx.db.query('select distinct user_id from notifications where id = any($1)', [mine.map((n) => n.id)]);
    expect(owners.map((o) => o.userId)).toEqual([ctx.emp.ali.userId]);
    const target = mine.find((n) => !n.isRead);
    const r = await S.post(`/notifications/${target.id}/read`);
    expect((await ctx.db.one('select is_read from notifications where id = $1', [target.id])).isRead).toBe(false); // nothing changed
    expect([403, 404]).toContain(r.status);
  });

  it('M9-12 read state: mark one read, then all; unread count drops and persists', async () => {
    const start = await notes(E);
    const one = start.items.find((n) => !n.isRead);
    expect((await E.post(`/notifications/${one.id}/read`)).status).toBe(204);
    expect((await notes(E)).unreadCount).toBe(start.unreadCount - 1);
    expect((await E.post('/notifications/read-all')).status).toBe(204);
    const after = await notes(E);
    expect(after.unreadCount).toBe(0);
    expect(after.items.every((n) => n.isRead)).toBe(true);
  });

  it('M9-13 a new user has no notifications (empty state = MANUAL)', async () => {
    const res = await H.post('/employees', { employeeCode: 'EMP-010', fullName: 'Nadia Noor', email: 'nadia@test.co', departmentId: ctx.ids.sales, joinDate: '2026-11-01', basicSalary: 40000 });
    const t = await ctx.firstLogin('nadia@test.co', res.body.tempPassword, 'Nadiapass123');
    expect(await notes(ctx.as(t))).toEqual({ items: [], unreadCount: 0 });
  });
});

describe('11.3 Audit log', () => {
  it('M9-14 each important action has actor, action, entity, timestamp and before/after JSON', async () => {
    await A.put('/settings', { graceMinutes: 20 });
    await H.put(`/employees/${ctx.emp.usman.id}`, { phone: '0300-7654321', designationId: ctx.ids.dev });
    const all = [];
    for (let page = 1; ; page++) {
      const r = (await A.get('/audit', { page })).body;
      all.push(...r.items);
      if (page * r.pageSize >= r.total) break;
    }
    const need = ['EMPLOYEE_CREATED', 'EMPLOYEE_UPDATED', 'SETTINGS_UPDATED', 'USER_CREATED', 'LEAVE_APPROVED', 'CORRECTION_APPROVED', 'PAYROLL_DRAFT_CREATED', 'PAYROLL_FINALIZED'];
    for (const action of need) {
      const row = all.find((r) => r.action === action);
      expect(row, action).toBeTruthy();
      expect(row.actorUserId && row.actorRole && row.actorName && row.entityType && row.entityId && row.createdAt, action).toBeTruthy();
      expect(row.after, action).toBeTruthy();
    }
    ctx.audit = all;
  });

  it('M9-15 create entries have empty "before"; update entries have both before and after', async () => {
    const created = ctx.audit.find((r) => r.action === 'EMPLOYEE_CREATED');
    expect(created.before).toBeNull();
    const updated = ctx.audit.find((r) => r.action === 'EMPLOYEE_UPDATED');
    expect(updated.before.phone).not.toBe('0300-7654321');
    expect(updated.after.phone).toBe('0300-7654321');
    const settings = ctx.audit.find((r) => r.action === 'SETTINGS_UPDATED' && r.after.graceMinutes === 20);
    expect(settings.before.graceMinutes).toBe(15);
  });

  it('M9-16 no passwords or hashes in any before/after JSON', async () => {
    const rows = await ctx.db.query('select before, after from audit_logs');
    expect(JSON.stringify(rows)).not.toMatch(/password|\$2[aby]\$/i);
  });

  it('M9-17 Admin views with paging and filters; read-only', async () => {
    const p1 = (await A.get('/audit', { page: 1 })).body;
    const p2 = (await A.get('/audit', { page: 2 })).body;
    expect(p1.items).toHaveLength(Math.min(50, p1.total));
    expect(p1.items.map((r) => r.id).filter((id) => p2.items.some((x) => x.id === id))).toEqual([]);
    const filtered = (await A.get('/audit', { action: 'LEAVE', entityType: 'leave_request' })).body.items;
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.action.includes('LEAVE') && r.entityType === 'leave_request')).toBe(true);
    const dated = (await A.get('/audit', { from: '2030-01-01' })).body;
    expect(dated.total).toBe(0);
  });

  it('M9-18 HR and Employee cannot read the audit log (403)', async () => {
    expect((await H.get('/audit')).status).toBe(403);
    expect((await E.get('/audit')).status).toBe(403);
  });

  it('M9-19 audit entries are immutable: no PUT/PATCH/DELETE route, and the DB blocks changes', async () => {
    const id = ctx.audit[0].id;
    for (const method of ['put', 'patch', 'delete']) {
      const r = await ctx.api[method](`/api/audit/${id}`).set('Authorization', `Bearer ${ctx.tok.admin}`).send({ action: 'X' });
      expect([403, 404, 405]).toContain(r.status);
    }
    await expect(ctx.db.query('update audit_logs set action = $1 where id = $2', ['HACKED', id])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('delete from audit_logs where id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('M9-20 forbidden or invalid actions are not recorded as successful actions', async () => {
    const count = (action) => ctx.count('audit_logs', 'action = $1', [action]);
    const s0 = await count('SETTINGS_UPDATED'); const l0 = await count('LEAVE_APPLIED'); const e0 = await count('EMPLOYEE_CREATED');
    expect((await H.put('/settings', { graceMinutes: 5 })).status).toBe(403);
    expect((await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-10', endDate: '2026-11-10' })).status).toBe(422);
    expect((await H.post('/employees', { employeeCode: 'EMP-001', fullName: 'Dup', email: 'dup@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 1 })).status).toBe(409);
    expect([await count('SETTINGS_UPDATED'), await count('LEAVE_APPLIED'), await count('EMPLOYEE_CREATED')]).toEqual([s0, l0, e0]);
  });

  it('M9-21 the Admin dashboard audit feed shows the latest log entries', async () => {
    const feed = (await A.get('/analytics/admin')).body.auditFeed.map((r) => r.id);
    const latest = (await A.get('/audit')).body.items.slice(0, 10).map((r) => r.id);
    expect(feed).toEqual(latest);
  });
});
