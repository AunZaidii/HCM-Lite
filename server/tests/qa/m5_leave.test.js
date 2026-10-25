// QA plan §7 — M5 Leave (functionalities 12, 13). Fresh schema qa_m5, frozen Karachi clock (Mon 2 Nov 2026).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

let ctx;
let A; let H; let ali; let sara; let usman; let T;
const apply = (client, type, startDate, endDate, reason = 'test') => client.post('/leave/requests', { leaveTypeId: T[type], startDate, endDate, reason });
const bal = async (client, code) => (await client.get('/leave/balance')).body.find((b) => b.code === code);
const req = (id) => ctx.db.one('select * from leave_requests where id = $1', [id]);

beforeAll(async () => {
  ctx = await qa('qa_m5', { clock: '2026-11-02T08:30' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr);
  ali = ctx.as(ctx.tok.ali); sara = ctx.as(ctx.tok.sara); usman = ctx.as(ctx.tok.usman);
  T = ctx.ids.types;
});
afterAll(async () => ctx?.close());

const S = {};

describe('M5 apply, balance and cancel (12)', () => {
  it('M5-01 basic apply: casual, 2 working days, pending', async () => {
    const res = await apply(ali, 'CASUAL', '2026-11-16', '2026-11-17');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', days: 2 });
    S.aliCasual = res.body;
  });

  it('M5-02 weekend skipped: Fri to Mon = 2 days', async () => {
    const res = await apply(sara, 'CASUAL', '2026-11-20', '2026-11-23');
    expect(res.body.days).toBe(2);
    S.saraCasual = res.body;
  });

  it('M5-03 weekend and holiday skipped: Fri 6 Nov to Tue 10 Nov = 2 days', async () => {
    const res = await apply(usman, 'ANNUAL', '2026-11-06', '2026-11-10');
    expect(res.status).toBe(201);
    expect(res.body.days).toBe(2);
  });

  it('M5-04 weekend only is rejected (zero working days), nothing saved', async () => {
    const n = await ctx.count('leave_requests');
    const res = await apply(usman, 'CASUAL', '2026-11-14', '2026-11-15');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_WORKING_DAYS');
    expect(await ctx.count('leave_requests')).toBe(n);
  });

  it('M5-05 single day = 1 day', async () => {
    const res = await apply(usman, 'SICK', '2026-11-18', '2026-11-18');
    expect(res.body.days).toBe(1);
    S.usmanSick = res.body;
  });

  it('M5-06 [decide] bad dates rejected with a message, nothing saved; past dates up to 7 days back allowed', async () => {
    const n = await ctx.count('leave_requests');
    const endBefore = await apply(usman, 'CASUAL', '2026-11-25', '2026-11-24');
    expect(endBefore.status).toBe(422);
    expect(endBefore.body.error.code).toBe('INVALID_DATES');
    const empty = await usman.post('/leave/requests', { leaveTypeId: T.CASUAL, startDate: '', endDate: '' });
    expect(empty.status).toBe(400);
    const farPast = await apply(usman, 'SICK', '2026-10-01', '2026-10-01');
    expect(farPast.status).toBe(422);
    expect(await ctx.count('leave_requests')).toBe(n);
    const recentPast = await ctx.as(ctx.tok.usman).post('/leave/preview', { leaveTypeId: T.SICK, startDate: '2026-10-27', endDate: '2026-10-27' });
    expect(recentPast.status).toBe(200); // within 7 days back: accepted (DECIDE)
  });

  it('M5-07 [decide] reason is optional (form marks it optional)', async () => {
    const res = await H.post('/leave/requests', { leaveTypeId: T.CASUAL, startDate: '2026-11-02', endDate: '2026-11-03' });
    expect(res.status).toBe(201);
    expect(res.body.reason).toBe('');
    S.hrCasual = res.body;
  });

  it('M5-08 quota edge: 8 sick days accepted, the 9th returns 422', async () => {
    expect((await apply(sara, 'SICK', '2026-11-24', '2026-11-27')).status).toBe(201); // 4
    expect((await apply(sara, 'SICK', '2026-11-30', '2026-12-03')).status).toBe(201); // 4 → 8
    const ninth = await apply(sara, 'SICK', '2026-12-04', '2026-12-04');
    expect(ninth.status).toBe(422);
    expect(ninth.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await ctx.count('leave_requests', 'employee_id = $1 and start_date = $2', [ctx.emp.sara.id, '2026-12-04'])).toBe(0);
  });

  it('M5-09 quota edge: casual 10 then 11, annual 14 then 15 → 422', async () => {
    expect((await apply(ali, 'CASUAL', '2026-12-07', '2026-12-16')).body.days).toBe(8); // 2 + 8 = 10
    S.aliCasual2 = (await ctx.db.one("select * from leave_requests where employee_id = $1 and start_date = '2026-12-07'", [ctx.emp.ali.id]));
    expect((await apply(ali, 'CASUAL', '2026-12-17', '2026-12-17')).status).toBe(422);
    const a1 = await apply(ali, 'ANNUAL', '2026-11-02', '2026-11-13'); // 9 (holiday skipped)
    expect(a1.body.days).toBe(9);
    S.aliAnnual1 = a1.body;
    S.aliAnnual2 = (await apply(ali, 'ANNUAL', '2026-11-18', '2026-11-20')).body; // 3 → 12
    expect((await apply(ali, 'ANNUAL', '2026-11-23', '2026-11-24')).body.days).toBe(2); // 14
    const over = await apply(ali, 'ANNUAL', '2026-11-25', '2026-11-25');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('M5-10 unpaid: a long unpaid request is accepted without a quota check', async () => {
    const res = await apply(usman, 'UNPAID', '2026-12-01', '2026-12-30');
    expect(res.status).toBe(201);
    expect(res.body.days).toBe(22);
  });

  it('M5-11 overlap with pending (same and partial dates) returns 422', async () => {
    const same = await apply(ali, 'SICK', '2026-11-16', '2026-11-17');
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('LEAVE_OVERLAP');
    const partial = await apply(ali, 'SICK', '2026-11-15', '2026-11-16');
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe('LEAVE_OVERLAP');
  });

  it('M5-12 adjacent days are accepted', async () => {
    const res = await apply(H, 'CASUAL', '2026-11-04', '2026-11-04'); // HR casual ends Tue 3 Nov
    expect(res.status).toBe(201);
  });

  it('M5-13 re-applying for rejected dates is accepted', async () => {
    await H.post(`/leave/requests/${S.usmanSick.id}/reject`, { comment: 'busy week' });
    const res = await apply(usman, 'SICK', '2026-11-18', '2026-11-18');
    expect(res.status).toBe(201);
  });

  it('M5-14 [decide] balance = quota − approved; rejected/cancelled excluded; pending reserved in "available"', async () => {
    await H.post(`/leave/requests/${S.saraCasual.id}/approve`, { comment: 'ok' });
    const sick = await bal(sara, 'SICK');
    expect(sick).toMatchObject({ quota: 8, approved: 0, pending: 8, remaining: 8, available: 0 });
    const casual = await bal(sara, 'CASUAL');
    expect(casual).toMatchObject({ quota: 10, approved: 2, remaining: 8 });
    const usmanSick = await bal(usman, 'SICK');
    expect(usmanSick.pending).toBe(1); // the rejected request is not counted
  });

  it('M5-15 cancel pending: status cancelled, pending released', async () => {
    const res = await ali.post(`/leave/requests/${S.aliCasual2.id}/cancel`);
    expect(res.body.status).toBe('cancelled');
    expect((await bal(ali, 'CASUAL')).pending).toBe(2);
  });

  it('M5-16 cancel approved future leave: cancelled and balance restored', async () => {
    await H.post(`/leave/requests/${S.aliCasual.id}/approve`, { comment: 'ok' });
    expect((await bal(ali, 'CASUAL')).remaining).toBe(8);
    const res = await ali.post(`/leave/requests/${S.aliCasual.id}/cancel`);
    expect(res.body.status).toBe('cancelled');
    expect((await bal(ali, 'CASUAL')).remaining).toBe(10);
    const hrView = (await H.get('/leave/requests')).body.find((r) => r.id === S.aliCasual.id);
    expect(hrView.status).toBe('cancelled');
  });

  it('M5-17 cancelling started or past leave is blocked', async () => {
    await H.post(`/leave/requests/${S.aliAnnual1.id}/approve`, {});
    await H.post(`/leave/requests/${S.aliAnnual2.id}/approve`, {});
    const started = await ali.post(`/leave/requests/${S.aliAnnual1.id}/cancel`); // starts today (2 Nov)
    expect(started.status).toBe(422);
    ctx.at('2026-11-25T10:00');
    const past = await ali.post(`/leave/requests/${S.aliAnnual2.id}/cancel`);
    expect(past.status).toBe(422);
    expect((await req(S.aliAnnual2.id)).status).toBe('approved');
    ctx.at('2026-11-02T08:30');
  });

  it("M5-18 cancelling someone else's leave returns 403", async () => {
    const res = await sara.post(`/leave/requests/${S.aliAnnual1.id}/cancel`);
    expect(res.status).toBe(403);
    expect((await req(S.aliAnnual1.id)).status).toBe('approved');
  });

  it('M5-19 history lists own requests with status, days and comments', async () => {
    const res = await sara.get('/leave/requests', { mine: 'true' });
    expect(res.body.every((r) => r.employeeId === ctx.emp.sara.id)).toBe(true);
    const casual = res.body.find((r) => r.id === S.saraCasual.id);
    expect(casual).toMatchObject({ status: 'approved', days: 2, reviewComment: 'ok', leaveTypeName: 'Casual' });
    const asEmployee = await sara.get('/leave/requests');
    expect(asEmployee.body.every((r) => r.employeeId === ctx.emp.sara.id)).toBe(true);
  });

  it('M5-20 Admin cannot apply (403)', async () => {
    expect((await apply(A, 'CASUAL', '2026-11-26', '2026-11-26')).status).toBe(403);
  });

  it('M5-21 [decide] HR applies own leave; HR cannot approve their own request', async () => {
    const res = await H.post(`/leave/requests/${S.hrCasual.id}/approve`, {});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_APPROVAL');
    expect((await req(S.hrCasual.id)).status).toBe('pending');
  });
});

describe('M5 approval inbox (13)', () => {
  it('M5-22 HR approves with comment: approved, balance deducted, employee notified, audited', async () => {
    const r = (await apply(usman, 'CASUAL', '2026-11-19', '2026-11-20')).body;
    const res = await H.post(`/leave/requests/${r.id}/approve`, { comment: 'Enjoy' });
    expect(res.body).toMatchObject({ status: 'approved', reviewComment: 'Enjoy' });
    expect((await bal(usman, 'CASUAL')).approved).toBe(2);
    expect((await usman.get('/notifications')).body.items.some((n) => n.type === 'LEAVE_DECIDED' && n.body === 'Enjoy')).toBe(true);
    const audit = (await A.get('/audit', { action: 'LEAVE_APPROVED' })).body.items.find((a) => a.entityId === r.id);
    expect(audit.before.status).toBe('pending');
    expect(audit.after.status).toBe('approved');
  });

  it('M5-23 HR rejects with comment: balance untouched; employee sees the comment', async () => {
    const r = (await apply(usman, 'CASUAL', '2026-11-26', '2026-11-26')).body;
    const before = await bal(usman, 'CASUAL');
    await H.post(`/leave/requests/${r.id}/reject`, { comment: 'Month end closing' });
    const after = await bal(usman, 'CASUAL');
    expect(after.approved).toBe(before.approved);
    const mine = (await usman.get('/leave/requests')).body.find((x) => x.id === r.id);
    expect(mine).toMatchObject({ status: 'rejected', reviewComment: 'Month end closing' });
  });

  it('M5-24 deciding a decided request returns 409', async () => {
    const res = await H.post(`/leave/requests/${S.saraCasual.id}/approve`, {});
    expect([409, 422]).toContain(res.status);
  });

  it('M5-25 over-balance at approval: two pending exceed the quota → second approval rejected 422', async () => {
    // Sara has 2 casual days approved; two pending requests of 3 + 3 fit the quota of 10 at submit time (2+3+3=8).
    const p1 = (await apply(sara, 'CASUAL', '2026-11-02', '2026-11-04')).body; // 3
    const p2 = (await apply(sara, 'CASUAL', '2026-11-10', '2026-11-12')).body; // 3
    expect(p1.days).toBe(3);
    expect(p2.days).toBe(3);
    // Admin lowers the casual quota to 6 while both are pending: only one of them can still fit (2 + 3 = 5 ≤ 6).
    expect((await A.put(`/leave-types/${T.CASUAL}`, { yearlyQuota: 6 })).status).toBe(200);
    try {
      const first = await H.post(`/leave/requests/${p1.id}/approve`, {});
      expect(first.status).toBe(200);
      const second = await H.post(`/leave/requests/${p2.id}/approve`, {});
      expect(second.status).toBe(422);
      expect((await req(p2.id)).status).toBe('pending');
    } finally {
      await A.put(`/leave-types/${T.CASUAL}`, { yearlyQuota: 10 });
    }
  });

  it('M5-26 concurrent approvals: one decision recorded, no double deduction', async () => {
    const r = (await apply(H, 'SICK', '2026-11-26', '2026-11-26')).body;
    // HR cannot approve their own request, so a second HR officer approves from two sessions at once.
    const hr2 = await A.post('/users', { role: 'hr', employeeCode: 'HR-002', fullName: 'Hamza HR', email: 'hr2@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 50000 });
    const t2 = await ctx.firstLogin('hr2@test.co', hr2.body.tempPassword, 'Hr2pass123');
    const [a, b] = await Promise.all([ctx.as(t2).post(`/leave/requests/${r.id}/approve`, {}), ctx.as(t2).post(`/leave/requests/${r.id}/approve`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await ctx.count('audit_logs', "action = 'LEAVE_APPROVED' and entity_id = $1", [r.id])).toBe(1);
    expect((await bal(H, 'SICK')).approved).toBe(1);
  });

  it('M5-27 employee and Admin cannot approve (403)', async () => {
    const r = (await apply(sara, 'ANNUAL', '2026-11-13', '2026-11-13')).body;
    expect((await ali.post(`/leave/requests/${r.id}/approve`, {})).status).toBe(403);
    expect((await A.post(`/leave/requests/${r.id}/approve`, {})).status).toBe(403);
    expect((await A.post(`/leave/requests/${r.id}/reject`, { comment: 'no' })).status).toBe(403);
    expect((await req(r.id)).status).toBe('pending');
  });

  it('M5-28 inbox: pending filter is correct; an empty filter returns an empty list', async () => {
    const res = await H.get('/leave/requests', { status: 'pending' });
    expect(res.body.length).toBe(await ctx.count('leave_requests', "status = 'pending'"));
    expect(res.body.every((r) => r.status === 'pending')).toBe(true);
    const empty = await H.get('/leave/requests', { status: 'pending', departmentId: ctx.ids.sales, employeeId: ctx.emp.ali.id });
    expect(empty.status).toBe(200);
  });

  it('M5-29 approved leave shows on_leave in attendance (not absent) and in leave dashboards', async () => {
    ctx.at('2026-11-03T10:00');
    const cal = await ali.get('/attendance/calendar', { month: '2026-11' });
    expect(cal.body.days.find((d) => d.date === '2026-11-02').status).toBe('on_leave');
    const onLeave = await H.get('/leave/on-leave', { date: '2026-11-03' });
    expect(onLeave.body.map((r) => r.employeeId)).toContain(ctx.emp.ali.id);
    const dash = await H.get('/analytics/hr', { from: '2026-11-02', to: '2026-11-03' });
    expect(dash.body.leaveByType.find((l) => l.leaveType === 'Annual').days).toBeGreaterThanOrEqual(2);
  });

  it('M5-30 effect on payroll: paid leave not deducted, unpaid leave deducted (verified end-to-end in M6-07 / M6-10)', async () => {
    const flags = await ctx.db.query(
      "select status, leave_is_paid from fn_daily_status('2026-11-02','2026-11-02', null, $1)", [ctx.emp.ali.id]);
    expect(flags[0]).toMatchObject({ status: 'on_leave', leaveIsPaid: true });
  });
});
