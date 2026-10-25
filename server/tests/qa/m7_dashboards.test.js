// M7 — Dashboards & Analytics (HCM_Lite_Test_Plan.md §9). Every number is checked against a hand calculation
// from records created through the API with the frozen clock. Schema: qa_m7.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attend, qa, workingDays } from './helpers.js';

let ctx;
let A; let H; let E;
const hr = (q) => H.get('/analytics/hr', q).then((r) => r.body);
const LONG = 1_200_000;

beforeAll(async () => {
  ctx = await qa('qa_m7');
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr); E = ctx.as(ctx.tok.ali);
}, LONG);
afterAll(async () => ctx?.close());

describe('M7 dashboards', () => {
  it('M7-01 empty system: zeros / nulls, no NaN, no errors on all three dashboards', async () => {
    const [h, a, me] = await Promise.all([H.get('/analytics/hr'), A.get('/analytics/admin'), E.get('/analytics/me')]);
    for (const r of [h, a, me]) {
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/NaN|Infinity/);
    }
    expect(h.body.attendanceSummary.workingDayRecords).toBe(0);
    expect(h.body.kpis.attendanceRate).toBeNull();
    expect(h.body.kpis.latePct).toBeNull();
    expect(h.body.topLateComers).toEqual([]);
    expect(h.body.attendanceTrend).toEqual([]);
    expect(a.body.kpis.payrollMonth).toBeNull();
    expect(a.body.kpis.payrollGross).toBe(0);
    expect(a.body.kpis.attritionYtdPct).toBe(0);
    expect(me.body.hoursThisWeek).toBe(0);
    expect(me.body.lastPayslip).toBeNull();
  });

  it('SETUP known records through the API (frozen clock)', async () => {
    const { tok } = ctx;
    // Usman (Sales, only Sales employee): exactly 10 working days Nov 2–16 → 5 present, 2 late, 1 missing_checkout, 2 half_day.
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) await attend(ctx, tok.usman, d, '09:00', '17:30');
    for (const d of ['2026-11-10', '2026-11-11']) await attend(ctx, tok.usman, d, '09:30', '17:30');
    await attend(ctx, tok.usman, '2026-11-12', '09:00', null);
    for (const d of ['2026-11-13', '2026-11-16']) await attend(ctx, tok.usman, d, '09:00', '13:00');
    // Engineering: Ali late Nov 2,3,4; Sara late Nov 2, present Nov 3; HR never checks in.
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) await attend(ctx, tok.ali, d, '09:40', '18:00');
    await attend(ctx, tok.sara, '2026-11-02', '09:40', '18:00');
    await attend(ctx, tok.sara, '2026-11-03', '09:00', '17:30');
    // Ali this week (Mon 16 – Fri 20): 8 h on Tue–Thu.
    for (const d of ['2026-11-17', '2026-11-18', '2026-11-19']) await attend(ctx, tok.ali, d, '09:00', '17:00');

    ctx.at('2026-11-17T09:00');
    const usmanCasual = await ctx.as(tok.usman).post('/leave/requests', { leaveTypeId: ctx.ids.types.CASUAL, startDate: '2026-11-20', endDate: '2026-11-20', reason: 'Family' });
    expect(usmanCasual.status).toBe(201);
    ctx.ids.usmanCasual = usmanCasual.body.id;

    ctx.at('2026-11-20T08:00');
    const sick = await ctx.as(tok.usman).post('/leave/requests', { leaveTypeId: ctx.ids.types.SICK, startDate: '2026-12-01', endDate: '2026-12-07', reason: 'Surgery' });
    expect(sick.body.days).toBe(5);
    expect((await H.post(`/leave/requests/${sick.body.id}/approve`, {})).status).toBe(200);
    expect((await E.post('/leave/requests', { leaveTypeId: ctx.ids.types.ANNUAL, startDate: '2026-12-14', endDate: '2026-12-14', reason: 'Trip' })).status).toBe(201);
    expect((await E.post('/attendance/corrections', { date: '2026-11-05', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'Forgot to check in' })).status).toBe(201);

    const run = await H.post('/payroll/runs', { month: '2026-10' });
    expect(run.status).toBe(201);
    expect((await A.post(`/payroll/runs/${run.body.id}/finalize`)).status).toBe(200);
  }, LONG);

  it('M7-11 live update: today KPIs change as people check in and leave is approved', async () => {
    ctx.at('2026-11-20T09:00');
    let k = (await hr()).kpis;
    expect([k.presentToday, k.onLeaveToday, k.lateToday]).toEqual([0, 0, 0]);
    expect((await H.post(`/leave/requests/${ctx.ids.usmanCasual}/approve`, { comment: 'ok' })).status).toBe(200);
    expect((await hr()).kpis.onLeaveToday).toBe(1);
    ctx.at('2026-11-20T09:05');
    await E.post('/attendance/check-in');
    expect((await hr()).kpis.presentToday).toBe(1);
    ctx.at('2026-11-20T09:40');
    await ctx.as(ctx.tok.sara).post('/attendance/check-in');
    k = (await hr()).kpis;
    expect(k.presentToday).toBe(2);
    expect(k.lateToday).toBe(1);
  });

  it('M7-02 HR KPIs match the records (headcount, present, on leave, late today, pending approvals)', async () => {
    ctx.at('2026-11-20T10:00');
    const k = (await hr()).kpis;
    expect(k).toMatchObject({ headcount: 4, presentToday: 2, onLeaveToday: 1, lateToday: 1, pendingApprovals: 2, pendingLeave: 1, pendingCorrections: 1 });
  });

  it('M7-12 attendance rate sample: (5 + 2 + 1 + 0.5 × 2) ÷ 10 = 90%', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-16', departmentId: ctx.ids.sales });
    expect(d.attendanceSummary).toMatchObject({ present: 5, late: 2, missingCheckout: 1, halfDay: 2, onLeave: 0, absent: 0, workingDayRecords: 10 });
    expect(d.attendanceSummary.attendanceRate).toBe(90);
    expect(d.kpis.attendanceRate).toBe(90);
  });

  it('M7-13 late % = 2 ÷ (5 + 2) = 28.6%', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-16', departmentId: ctx.ids.sales });
    expect(d.attendanceSummary.latePct).toBe(28.6);
  });

  it('M7-03 charts and lists: trend, absenteeism by department, leave by type, top 5 late-comers', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-16' });
    const day = (iso) => d.attendanceTrend.find((t) => t.date === iso);
    expect(day('2026-11-02').rate).toBe(75); // Ali late, Sara late, Usman present, HR absent → 3/4
    expect(day('2026-11-13').rate).toBe(12.5); // Usman half day → 0.5/4
    expect(d.attendanceTrend.map((t) => t.date)).toEqual(workingDays('2026-11-02', '2026-11-16'));
    expect(d.topLateComers.map((r) => [r.fullName, r.lateCount])).toEqual([['Ali Khan', 3], ['Usman Tariq', 2], ['Sara Ahmed', 1]]);
    const leave = await hr({ from: '2026-11-02', to: '2026-11-20' });
    expect(leave.leaveByType).toEqual([{ leaveType: 'Casual', days: 1 }]);
  });

  it('M7-14 absenteeism and late % per department match manual calculation', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-16' });
    const eng = d.absenteeismByDepartment.find((r) => r.department === 'Engineering');
    const sales = d.absenteeismByDepartment.find((r) => r.department === 'Sales');
    expect(eng).toMatchObject({ absent: 25, late: 4, expected: 30, absenteeismPct: 83.3, latePct: 80 });
    expect(sales).toMatchObject({ absent: 0, late: 2, expected: 10, absenteeismPct: 0, latePct: 28.6 });
  });

  it('M7-07 date range filter recomputes every number', async () => {
    const wide = await hr({ from: '2026-11-02', to: '2026-11-16' });
    const narrow = await hr({ from: '2026-11-02', to: '2026-11-06' });
    expect(wide.attendanceSummary).toMatchObject({ present: 6, late: 6, missingCheckout: 1, halfDay: 2, absent: 25, workingDayRecords: 40, attendanceRate: 35, latePct: 50 });
    expect(narrow.attendanceSummary).toMatchObject({ present: 6, late: 4, absent: 10, workingDayRecords: 20, attendanceRate: 50 });
    expect(narrow.topLateComers.map((r) => r.lateCount)).toEqual([3, 1]);
  });

  it('M7-08 department filter covers only that department', async () => {
    const eng = await hr({ from: '2026-11-02', to: '2026-11-16', departmentId: ctx.ids.eng });
    expect(eng.kpis.headcount).toBe(3);
    expect(eng.attendanceSummary).toMatchObject({ present: 1, late: 4, absent: 25, workingDayRecords: 30, attendanceRate: 16.7 });
    expect(eng.topLateComers.every((r) => r.department === 'Engineering')).toBe(true);
    const sales = await hr({ from: '2026-11-02', to: '2026-11-16', departmentId: ctx.ids.sales });
    expect(sales.kpis.headcount).toBe(1);
  });

  it('M7-09 combined date range + department = correct intersection', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-06', departmentId: ctx.ids.eng });
    // Ali: late 2,3,4 absent 5,6 · Sara: late 2, present 3, absent 4,5,6 · HR: absent ×5
    expect(d.attendanceSummary).toMatchObject({ present: 1, late: 4, absent: 10, workingDayRecords: 15 });
  });

  it('M7-10 bad range (end before start) → validation or empty state, never an error', async () => {
    const r = await H.get('/analytics/hr', { from: '2026-11-16', to: '2026-11-02' });
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) {
      expect(r.body.attendanceSummary.workingDayRecords).toBe(0);
      expect(r.body.attendanceTrend).toEqual([]);
    }
    const noData = await hr({ from: '2026-11-07', to: '2026-11-08' }); // weekend only
    expect(noData.attendanceSummary.workingDayRecords).toBe(0);
    expect(noData.kpis.attendanceRate).toBeNull();
  });

  it('M7-15 leave utilization: 5 approved sick days ÷ quota 8 = 62.5% (Sales, one employee)', async () => {
    const d = await hr({});
    const row = (type, dept) => d.leaveUtilization.find((r) => r.leaveType === type && r.department === dept);
    expect(row('Sick', 'Sales')).toMatchObject({ approvedDays: 5, quota: 8, headcount: 1, utilizationPct: 62.5 });
    expect(row('Casual', 'Sales')).toMatchObject({ approvedDays: 1, utilizationPct: 10 });
    expect(row('Annual', 'Engineering').approvedDays).toBe(0); // pending leave not counted
  });

  it('M7-04 Admin KPIs: headcount, attrition YTD, payroll cost, average salary', async () => {
    const d = (await A.get('/analytics/admin')).body;
    // October run: everyone absent all 22 working days → deduction = gross → net floored at 0.
    expect(d.kpis).toMatchObject({ headcount: 4, attritionYtdPct: 0, exitsYtd: 0, payrollMonth: '2026-10', payrollGross: 435000, payrollNet: 0 });
    expect(d.kpis.avgSalary).toBe(108750); // (75,000 + 150,000 + 120,000 + 90,000) ÷ 4
  });

  it('M7-05 Admin charts: headcount by department, payroll by department, gender, tenure, audit feed', async () => {
    const d = (await A.get('/analytics/admin')).body;
    expect(d.headcountByDepartment.map((r) => [r.department, r.headcount])).toEqual([['Engineering', 3], ['Sales', 1]]);
    expect(d.payrollCostByDepartment.map((r) => [r.department, r.gross])).toEqual([['Engineering', 345000], ['Sales', 90000]]);
    expect(d.gender).toEqual([{ gender: 'female', count: 2 }, { gender: 'male', count: 2 }]);
    expect(d.tenure).toEqual([{ band: '<1y', count: 4 }]);
    const audit = (await A.get('/audit')).body.items.slice(0, 10).map((r) => r.id);
    expect(d.auditFeed.map((r) => r.id)).toEqual(audit);
  });

  it('M7-18 payroll cost by month & department and mean gross by department & designation', async () => {
    const d = (await A.get('/analytics/admin')).body;
    expect(d.payrollCostByDepartment.every((r) => r.month === '2026-10' && r.status === 'finalized' && r.net === 0)).toBe(true);
    expect(d.averageSalary.byDepartment).toEqual([{ department: 'Engineering', avgGross: 115000 }, { department: 'Sales', avgGross: 90000 }]);
    expect(d.averageSalary.byDesignation).toEqual([
      { designation: 'Developer', avgGross: 135000 }, { designation: 'HR Officer', avgGross: 75000 }, { designation: 'Sales Executive', avgGross: 90000 },
    ]);
  });

  it('M7-06 employee dashboard: hours this week vs 40 h, late count, leave balance, last payslip — own data only', async () => {
    const me = (await E.get('/analytics/me')).body;
    expect(me).toMatchObject({ hoursThisWeek: 24, hoursTarget: 40, lateCountThisMonth: 3 });
    expect(me.lastPayslip).toMatchObject({ month: '2026-10', netPay: 0, gross: 150000 });
    const bal = (await E.get('/leave/balance')).body.find((b) => b.code === 'ANNUAL');
    expect(bal).toMatchObject({ quota: 14, approved: 0, pending: 1, remaining: 14, available: 13 });
    const today = (await E.get('/attendance/today')).body;
    expect(today.record.status).toBe('present');
    expect((await E.get('/announcements')).status).toBe(200);
  });

  it('M7-19 scope: HR → Admin dashboard 403; Employee → HR and Admin dashboards 403', async () => {
    expect((await H.get('/analytics/admin')).status).toBe(403);
    expect((await E.get('/analytics/hr')).status).toBe(403);
    expect((await E.get('/analytics/admin')).status).toBe(403);
    expect((await E.get('/analytics/leave-utilization')).status).toBe(403);
  });

  it('M7-20 server-side aggregation: responses carry aggregates, not raw rows', async () => {
    const d = await hr({ from: '2026-11-02', to: '2026-11-16' });
    expect(Object.keys(d).sort()).toEqual(['absenteeismByDepartment', 'anomalyFlags', 'attendanceSummary', 'attendanceTrend', 'filters', 'kpis', 'leaveByType', 'leaveUtilization', 'topLateComers']);
    expect(JSON.stringify(d)).not.toMatch(/checkInAt|check_in_at|passwordHash/);
  });

  it('M7-22 volume: 100+ attendance records — dashboards stay correct and fast', async () => {
    const oct = workingDays('2026-10-01', '2026-10-31', []);
    expect(oct).toHaveLength(22);
    for (const who of ['hr', 'ali', 'sara', 'usman']) {
      for (const d of oct) await attend(ctx, ctx.tok[who], d, '09:00', null);
    }
    ctx.at('2026-11-20T10:00');
    expect(await ctx.count('attendance')).toBeGreaterThanOrEqual(100);
    const t0 = Date.now();
    const d = await hr({ from: '2026-10-01', to: '2026-10-31' });
    const ms = Date.now() - t0;
    expect(d.attendanceSummary).toMatchObject({ workingDayRecords: 88, missingCheckout: 88, attendanceRate: 100 });
    expect(ms).toBeLessThan(5000);
  }, LONG);

  it('M7-16 attrition: an exit lowers headcount and attrition YTD = exits ÷ average headcount × 100', async () => {
    const res = await H.put(`/employees/${ctx.emp.sara.id}`, { status: 'resigned', exitDate: '2026-11-18', exitReason: 'Moved abroad' });
    expect(res.status).toBe(200);
    const d = (await A.get('/analytics/admin')).body;
    expect(d.kpis.headcount).toBe(3);
    expect(d.kpis.exitsYtd).toBe(1);
    expect(d.kpis.attritionYtdPct).toBe(28.6); // 1 ÷ ((4 + 3) ÷ 2) × 100
    expect((await hr()).kpis.headcount).toBe(3);
  });

  it('M7-17 headcount counts active + probation only; exited AND deactivated employees are excluded', async () => {
    const res = await A.post(`/users/${ctx.emp.ali.userId}/deactivate`);
    expect(res.status).toBe(200);
    const admin = (await A.get('/analytics/admin')).body;
    const hrd = await hr();
    // Plan: deactivated employees are not counted → HR + Usman = 2.
    expect(admin.kpis.headcount).toBe(2);
    expect(hrd.kpis.headcount).toBe(2);
  });
});
