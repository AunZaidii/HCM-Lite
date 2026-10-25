// QA plan §6 — M4 Attendance (functionalities 09, 10, 11). Fresh schema qa_m4, frozen Karachi clock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

let ctx;
let A; let H; let ali; let sara; let usman;
const rec = (empId, date) => ctx.db.one('select * from attendance where employee_id = $1 and work_date = $2', [empId, date]);
const calDay = async (token, date, employeeId) => {
  const res = await ctx.as(token).get('/attendance/calendar', { month: date.slice(0, 7), ...(employeeId ? { employeeId } : {}) });
  return res.body.days.find((d) => d.date === date);
};

beforeAll(async () => {
  ctx = await qa('qa_m4', { clock: '2026-11-02T08:30' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr);
  ali = ctx.as(ctx.tok.ali); sara = ctx.as(ctx.tok.sara); usman = ctx.as(ctx.tok.usman);
});
afterAll(async () => ctx?.close());

describe('M4 check-in and check-out (09)', () => {
  it('M4-01 normal check-in at 08:55 is present and server-stamped', async () => {
    ctx.at('2026-11-02T08:55');
    const res = await ali.post('/attendance/check-in');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('present');
    expect(res.body.workDate).toBe('2026-11-02');
    expect(new Date(res.body.checkInAt).toISOString()).toBe(new Date('2026-11-02T08:55:00+05:00').toISOString());
  });

  it('M4-02 client clock / fake timestamp in body is ignored', async () => {
    ctx.at('2026-11-02T09:05');
    const res = await sara.post('/attendance/check-in', { checkInAt: '2020-01-01T03:00:00Z', workDate: '2020-01-01', status: 'present' });
    expect(res.status).toBe(201);
    expect(res.body.workDate).toBe('2026-11-02');
    expect(new Date(res.body.checkInAt).toISOString()).toBe(new Date('2026-11-02T09:05:00+05:00').toISOString());
  });

  it('M4-03 grace boundary: exactly 09:15 is present', async () => {
    ctx.at('2026-11-02T09:15');
    const res = await usman.post('/attendance/check-in');
    expect(res.body).toMatchObject({ status: 'present', isLate: false });
  });

  it('M4-04 09:16 is late', async () => {
    ctx.at('2026-11-02T09:16');
    const res = await H.post('/attendance/check-in');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'late', isLate: true });
  });

  it('M4-05 very late (11:30) is late', async () => {
    ctx.at('2026-11-03T11:30');
    const res = await ali.post('/attendance/check-in');
    expect(res.body).toMatchObject({ status: 'late', isLate: true, workDate: '2026-11-03' });
  });

  it('M4-06 check-out after 5 h or more stays present; hours correct', async () => {
    ctx.at('2026-11-03T09:00');
    await sara.post('/attendance/check-in');
    ctx.at('2026-11-03T14:00');
    const out = await sara.post('/attendance/check-out');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'present', workedMinutes: 300 });
  });

  it('M4-07 half-day boundary: 4 h 59 m → half_day, 5 h 00 m → not half_day', async () => {
    ctx.at('2026-11-03T09:00');
    await usman.post('/attendance/check-in');
    ctx.at('2026-11-03T13:59');
    const out = await usman.post('/attendance/check-out');
    expect(out.body).toMatchObject({ status: 'half_day', workedMinutes: 299 });
    expect((await rec(ctx.emp.sara.id, '2026-11-03')).status).toBe('present'); // exactly 300 min (M4-06)
  });

  it('M4-08 second check-in same day = 409, original unchanged', async () => {
    ctx.at('2026-11-03T15:00');
    const before = await rec(ctx.emp.ali.id, '2026-11-03');
    const res = await ali.post('/attendance/check-in');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CHECKED_IN');
    const after = await rec(ctx.emp.ali.id, '2026-11-03');
    expect(after).toEqual(before);
    expect(await ctx.count('attendance', 'employee_id = $1 and work_date = $2', [ctx.emp.ali.id, '2026-11-03'])).toBe(1);
  });

  it('M4-09 check-out without check-in is rejected and creates nothing', async () => {
    ctx.at('2026-11-04T17:00');
    const res = await ali.post('/attendance/check-out');
    expect(res.status).toBe(409);
    expect(await rec(ctx.emp.ali.id, '2026-11-04')).toBeNull();
  });

  it('M4-10 [decide] second check-out is rejected with 409; first one stands', async () => {
    ctx.at('2026-11-03T18:00');
    const res = await sara.post('/attendance/check-out');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CHECKED_OUT');
    expect((await rec(ctx.emp.sara.id, '2026-11-03')).workedMinutes).toBe(300);
  });

  it('M4-11 missing check-out shows missing_checkout the next day', async () => {
    ctx.at('2026-11-04T10:00');
    expect((await calDay(ctx.tok.ali, '2026-11-03')).status).toBe('missing_checkout');
  });

  it('M4-12 working day with no record and no leave is absent', async () => {
    ctx.at('2026-11-05T10:00');
    expect((await calDay(ctx.tok.usman, '2026-11-04')).status).toBe('absent');
  });

  it('M4-13 approved leave day is on_leave, not absent', async () => {
    ctx.at('2026-11-04T10:00');
    const lr = await sara.post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-05', endDate: '2026-11-05', reason: 'family' });
    expect(lr.status).toBe(201);
    expect((await H.post(`/leave/requests/${lr.body.id}/approve`, { comment: 'ok' })).status).toBe(200);
    ctx.at('2026-11-06T10:00');
    const day = await calDay(ctx.tok.sara, '2026-11-05');
    expect(day.status).toBe('on_leave');
    expect(day.leaveType).toBe('Casual');
  });

  it('M4-14 weekends and the 9 Nov holiday are not working days and not absent', async () => {
    ctx.at('2026-11-10T10:00');
    expect((await calDay(ctx.tok.usman, '2026-11-07')).status).toBe('weekend');
    expect((await calDay(ctx.tok.usman, '2026-11-08')).status).toBe('weekend');
    expect((await calDay(ctx.tok.usman, '2026-11-09')).status).toBe('holiday');
    const flags = await ctx.db.query(
      "select work_date, is_working_day from fn_daily_status('2026-11-07','2026-11-09', null, $1) order by work_date", [ctx.emp.usman.id]);
    expect(flags.map((f) => f.isWorkingDay)).toEqual([false, false, false]);
  });

  it('M4-15 [decide] check-in on a weekend is allowed and flagged as an off day', async () => {
    ctx.at('2026-11-07T10:00');
    const res = await usman.post('/attendance/check-in');
    expect(res.status).toBe(201);
    expect(res.body.isOffDay).toBe(true);
    ctx.at('2026-11-09T10:00');
    const hol = await ali.post('/attendance/check-in');
    expect(hol.status).toBe(201);
    expect(hol.body.isOffDay).toBe(true);
  });

  it('M4-16 [decide] check-in while on approved leave is blocked (422)', async () => {
    ctx.at('2026-11-05T09:00');
    const res = await sara.post('/attendance/check-in');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ON_LEAVE_TODAY');
    expect(await rec(ctx.emp.sara.id, '2026-11-05')).toBeNull();
  });

  it('M4-17 Admin check-in is refused (403)', async () => {
    ctx.at('2026-11-05T09:00');
    expect((await A.post('/attendance/check-in')).status).toBe(403);
    expect((await A.post('/attendance/check-out')).status).toBe(403);
  });

  it('M4-18 HR checks in for self like an employee, own record only', async () => {
    const r = await rec(ctx.emp.hr.id, '2026-11-02');
    expect(r).toMatchObject({ employeeId: ctx.emp.hr.id, status: 'late' });
    ctx.at('2026-11-05T09:00');
    const res = await H.post('/attendance/check-in', { employeeId: ctx.emp.ali.id });
    expect(res.body.employeeId).toBe(ctx.emp.hr.id);
    expect(await rec(ctx.emp.ali.id, '2026-11-05')).toBeNull();
  });

  it('M4-19 midnight: check-ins just before and after midnight land on the correct local dates', async () => {
    ctx.at('2026-11-10T23:59');
    const before = await usman.post('/attendance/check-in');
    expect(before.body.workDate).toBe('2026-11-10');
    ctx.at('2026-11-11T00:01');
    const after = await usman.post('/attendance/check-in');
    expect(after.status).toBe(201);
    expect(after.body.workDate).toBe('2026-11-11');
  });

  it('M4-20 double-click: two simultaneous check-ins create one record', async () => {
    ctx.at('2026-11-12T09:00');
    const [a, b] = await Promise.all([ali.post('/attendance/check-in'), ali.post('/attendance/check-in')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await ctx.count('attendance', 'employee_id = $1 and work_date = $2', [ctx.emp.ali.id, '2026-11-12'])).toBe(1);
  });
});

describe('M4 calendar and daily board (10)', () => {
  it('M4-21 employee calendar: statuses, weekends/holidays marked, months navigable, future empty', async () => {
    ctx.at('2026-11-12T10:00');
    const res = await ali.get('/attendance/calendar', { month: '2026-11' });
    expect(res.status).toBe(200);
    const day = Object.fromEntries(res.body.days.map((d) => [d.date, d.status]));
    expect(day['2026-11-02']).toBe('missing_checkout'); // checked in 08:55, never out
    expect(day['2026-11-04']).toBe('absent');
    expect(day['2026-11-08']).toBe('weekend');
    expect(day['2026-11-12']).toBe('present');
    expect(day['2026-11-13']).toBe('upcoming');
    expect(day['2026-11-30']).toBe('upcoming');
    const oct = await ali.get('/attendance/calendar', { month: '2026-10' });
    expect(oct.body.days).toHaveLength(31);
  });

  it('M4-22 HR daily board lists everyone and its counts match the HR dashboard', async () => {
    ctx.at('2026-11-12T10:00');
    const board = await H.get('/attendance/board');
    expect(board.status).toBe(200);
    expect(board.body.rows).toHaveLength(4);
    const dash = (await H.get('/analytics/hr')).body.kpis;
    const c = board.body.counts;
    expect((c.present || 0) + (c.late || 0) + (c.half_day || 0)).toBe(dash.presentToday);
    expect(board.body.rows.filter((r) => r.isLate).length).toBe(dash.lateToday);
    expect(c.on_leave || 0).toBe(dash.onLeaveToday);
  });

  it('M4-23 board filters: date, department and status', async () => {
    const byDate = await H.get('/attendance/board', { date: '2026-11-03' });
    expect(byDate.body.date).toBe('2026-11-03');
    expect(byDate.body.rows.find((r) => r.employeeId === ctx.emp.usman.id).status).toBe('half_day');
    const sales = await H.get('/attendance/board', { date: '2026-11-03', departmentId: ctx.ids.sales });
    expect(sales.body.rows.map((r) => r.employeeId)).toEqual([ctx.emp.usman.id]);
    const lateOnly = await H.get('/attendance/board', { date: '2026-11-03', status: 'missing_checkout' });
    expect(lateOnly.body.rows.length).toBeGreaterThan(0);
    expect(lateOnly.body.rows.every((r) => r.status === 'missing_checkout')).toBe(true);
  });

  it('M4-24 Admin sees the board with all employees', async () => {
    const res = await A.get('/attendance/board', { date: '2026-11-03' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(4);
  });

  it('M4-25 employee cannot call the board (403)', async () => {
    expect((await ali.get('/attendance/board')).status).toBe(403);
  });

  it('M4-26 board for a day with no records returns cleanly (UI empty state is MANUAL)', async () => {
    const res = await H.get('/attendance/board', { date: '2026-10-31' });
    expect(res.status).toBe(200);
    expect(res.body.rows.every((r) => !r.checkInAt)).toBe(true);
  });
});

describe('M4 corrections (11)', () => {
  let aliReq;
  it('M4-27 employee requests a correction; pending and visible to HR; reason required', async () => {
    ctx.at('2026-11-12T11:00');
    const noReason = await ali.post('/attendance/corrections', { date: '2026-11-03', requestedCheckOut: '18:00', reason: '' });
    expect(noReason.status).toBe(400);
    const res = await ali.post('/attendance/corrections', { date: '2026-11-03', requestedCheckOut: '18:00', reason: 'Forgot to check out' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    aliReq = res.body;
    const list = await H.get('/attendance/corrections', { status: 'pending' });
    expect(list.body.map((c) => c.id)).toContain(aliReq.id);
  });

  it('M4-28 invalid requests: future date, empty reason, another employee record', async () => {
    const n = await ctx.count('attendance_corrections');
    expect((await ali.post('/attendance/corrections', { date: '2026-11-20', requestedCheckIn: '09:00', reason: 'Future date' })).status).toBe(422);
    expect((await ali.post('/attendance/corrections', { date: '2026-11-04', requestedCheckIn: '09:00' })).status).toBe(400);
    expect(await ctx.count('attendance_corrections')).toBe(n);
    const other = await ali.post('/attendance/corrections', { date: '2026-11-04', requestedCheckIn: '09:00', reason: 'For Sara please', employeeId: ctx.emp.sara.id });
    expect(other.body.employeeId).toBe(ctx.emp.ali.id); // employeeId in the body is ignored
  });

  it('M4-29 duplicate pending request for the same date is blocked', async () => {
    const res = await ali.post('/attendance/corrections', { date: '2026-11-03', requestedCheckOut: '19:00', reason: 'Again please' });
    expect(res.status).toBe(409);
  });

  it('M4-30 HR approves a missing_checkout fix: record updated, status recalculated, notified, audited', async () => {
    const res = await H.post(`/attendance/corrections/${aliReq.id}/approve`, { comment: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    const r = await rec(ctx.emp.ali.id, '2026-11-03');
    expect(r.source).toBe('correction');
    expect(new Date(r.checkOutAt).toISOString()).toBe(new Date('2026-11-03T18:00:00+05:00').toISOString());
    expect(r.workedMinutes).toBe(390);
    expect(r.status).toBe('late');
    expect((await calDay(ctx.tok.ali, '2026-11-03')).status).toBe('late');
    const notes = (await ali.get('/notifications')).body.items;
    expect(notes.some((x) => x.type === 'CORRECTION_DECIDED')).toBe(true);
    const audit = (await A.get('/audit', { action: 'CORRECTION_APPROVED' })).body.items;
    expect(audit.length).toBeGreaterThan(0);
    expect((await A.get('/audit', { action: 'ATTENDANCE_CORRECTED' })).body.items[0].after.source).toBe('correction');
  });

  let usmanReq;
  it('M4-31 HR rejects with a comment: record unchanged, employee notified', async () => {
    usmanReq = (await usman.post('/attendance/corrections', { date: '2026-11-04', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'I was at a client site' })).body;
    const res = await H.post(`/attendance/corrections/${usmanReq.id}/reject`, { comment: 'No proof' });
    expect(res.body).toMatchObject({ status: 'rejected', reviewComment: 'No proof' });
    expect(await rec(ctx.emp.usman.id, '2026-11-04')).toBeNull();
    expect((await usman.get('/notifications')).body.items.some((x) => x.type === 'CORRECTION_DECIDED' && x.body === 'No proof')).toBe(true);
  });

  it('M4-32 deciding twice returns 409', async () => {
    expect((await H.post(`/attendance/corrections/${aliReq.id}/approve`, {})).status).toBe(409);
    expect((await H.post(`/attendance/corrections/${usmanReq.id}/approve`, {})).status).toBe(409);
  });

  it('M4-33 employee and Admin cannot approve (403)', async () => {
    const req = (await sara.post('/attendance/corrections', { date: '2026-11-02', requestedCheckOut: '18:00', reason: 'Forgot check-out' })).body;
    expect((await ali.post(`/attendance/corrections/${req.id}/approve`, {})).status).toBe(403);
    expect((await A.post(`/attendance/corrections/${req.id}/approve`, {})).status).toBe(403);
    expect((await A.post(`/attendance/corrections/${req.id}/reject`, { comment: 'no' })).status).toBe(403);
    expect((await ctx.db.one('select status from attendance_corrections where id = $1', [req.id])).status).toBe('pending');
  });

  it('M4-34 employee cannot edit attendance directly', async () => {
    const r = await rec(ctx.emp.ali.id, '2026-11-12');
    const calls = [() => ali.put(`/attendance/${r.id}`, { status: 'present' }), () => ali.patch(`/attendance/${r.id}`, { status: 'present' }), () => ali.post('/attendance', { status: 'present' })];
    for (const call of calls) {
      const res = await call();
      expect([403, 404, 405]).toContain(res.status);
    }
    expect(await rec(ctx.emp.ali.id, '2026-11-12')).toEqual(r);
  });

  it('M4-35 Admin views the correction list read-only', async () => {
    const res = await A.get('/attendance/corrections');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });
});
