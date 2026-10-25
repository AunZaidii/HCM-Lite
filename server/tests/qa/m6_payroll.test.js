// QA plan §8 — M6 Payroll Lite (functionalities 14, 15, 16, 17). Fresh schema qa_m6, frozen Karachi clock.
// Workflow scenarios use October 2026 (no attendance → everyone absent); calculation scenarios use November 2026
// (holiday 9 Nov → 20 working days) with attendance built through the API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attend, qa, workingDays } from './helpers.js';

let ctx;
let A; let H; let ali; let sara; let usman; let tax;
const slipsOf = async (runId) => (await H.get(`/payroll/runs/${runId}`)).body.payslips;
const slipFor = (slips, empId) => slips.find((p) => p.employeeId === empId);

beforeAll(async () => {
  ctx = await qa('qa_m6', { clock: '2026-11-02T08:30' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr);
  ali = ctx.as(ctx.tok.ali); sara = ctx.as(ctx.tok.sara); usman = ctx.as(ctx.tok.usman);
  tax = await import('../../src/lib/rules/tax.js');
});
afterAll(async () => ctx?.close());

const S = {};

describe('M6 salary structure (14)', () => {
  it('M6-01 HR sets basic 100,000 → HRA 40,000, medical 10,000, gross 150,000', async () => {
    const res = await H.post(`/employees/${ctx.emp.ali.id}/salary`, { basic: 100000, effectiveFrom: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ basic: 100000, hra: 40000, medical: 10000, gross: 150000 });
    const cur = (await H.get(`/employees/${ctx.emp.ali.id}/salary`)).body.current;
    expect(cur).toMatchObject({ basic: 100000, hra: 40000, medical: 10000, gross: 150000 });
  });

  it('M6-02 invalid salary (0, negative, text) is rejected, nothing saved', async () => {
    const n = await ctx.count('salary_structures', 'employee_id = $1', [ctx.emp.ali.id]);
    for (const basic of [0, -5000, 'abc']) {
      expect((await H.post(`/employees/${ctx.emp.ali.id}/salary`, { basic, effectiveFrom: '2026-10-01' })).status).toBe(400);
    }
    expect(await ctx.count('salary_structures', 'employee_id = $1', [ctx.emp.ali.id])).toBe(n);
  });

  it('M6-04 Admin views but cannot edit; employees cannot see or edit salary structures', async () => {
    expect((await A.get(`/employees/${ctx.emp.ali.id}/salary`)).status).toBe(200);
    expect((await A.post(`/employees/${ctx.emp.ali.id}/salary`, { basic: 1, effectiveFrom: '2026-10-01' })).status).toBe(403);
    expect((await ali.get(`/employees/${ctx.emp.ali.id}/salary`)).status).toBe(403);
    expect((await ali.get(`/employees/${ctx.emp.sara.id}/salary`)).status).toBe(403);
    expect((await ali.post(`/employees/${ctx.emp.sara.id}/salary`, { basic: 1, effectiveFrom: '2026-10-01' })).status).toBe(403);
    expect((await ali.get(`/employees/${ctx.emp.ali.id}`)).body.salary).toBeUndefined();
  });
});

describe('M6 draft workflow, finalize and payslips (15, 16, 17) — October 2026', () => {
  it('M6-24 HR creates the draft: one line per active employee with a full breakdown; totals match', async () => {
    const res = await H.post('/payroll/runs', { month: '2026-10' });
    expect(res.status).toBe(201);
    S.oct = res.body;
    expect(res.body).toMatchObject({ status: 'draft', employeeCount: 4, workingDays: 22 });
    const slips = await slipsOf(S.oct.id);
    expect(slips).toHaveLength(4);
    for (const p of slips) {
      for (const f of ['basic', 'hra', 'medical', 'gross', 'proratedGross', 'absentDays', 'unpaidLeaveDays', 'halfDays', 'perDayRate', 'deductionAmount', 'tax', 'netPay']) {
        expect(p[f]).toBeTypeOf('number');
      }
    }
    const sum = (k) => Math.round(slips.reduce((s, p) => s + p[k], 0) * 100) / 100;
    expect(res.body.totalNet).toBeCloseTo(sum('netPay'), 2);
    expect(res.body.totalTax).toBeCloseTo(sum('tax'), 2);
    expect(res.body.totalDeductions).toBeCloseTo(sum('deductionAmount'), 2);
    expect(res.body.totalGross).toBeCloseTo(sum('proratedGross'), 2);
  });

  it('M6-25 a second draft for the same month is blocked (no duplicates)', async () => {
    const res = await H.post('/payroll/runs', { month: '2026-10' });
    expect(res.status).toBe(409);
    expect(await ctx.count('payroll_runs', "period_month = '2026-10-01'")).toBe(1);
  });

  it('M6-26 review and recalculate after an attendance fix: numbers update, draft stays editable', async () => {
    expect(slipFor(await slipsOf(S.oct.id), ctx.emp.ali.id).absentDays).toBe(22);
    const c = await ali.post('/attendance/corrections', { date: '2026-10-15', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'Forgot to check in' });
    expect(c.status).toBe(201);
    expect((await H.post(`/attendance/corrections/${c.body.id}/approve`, {})).status).toBe(200);
    const re = await H.post(`/payroll/runs/${S.oct.id}/recalculate`);
    expect(re.status).toBe(200);
    expect(re.body.status).toBe('draft');
    expect(slipFor(await slipsOf(S.oct.id), ctx.emp.ali.id).absentDays).toBe(21);
  });

  it('M6-27 empty or future month: clear message or zeros, no crash', async () => {
    const empty = await H.post('/payroll/runs', { month: '2025-06' });
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toBeTruthy();
    const future = await H.post('/payroll/runs', { month: '2026-12' });
    if (future.status === 201) await H.del(`/payroll/runs/${future.body.id}`); // clean up before asserting
    // Expected: a future month is refused, or produces zero pay (no attendance has happened yet).
    expect(future.status >= 400 || future.body.totalNet === 0).toBe(true);
  });

  it('M6-28 Admin can view drafts but not change them; employees cannot open payroll', async () => {
    expect((await A.get(`/payroll/runs/${S.oct.id}`)).status).toBe(200);
    expect((await A.get('/payroll/runs')).status).toBe(200);
    expect((await A.post(`/payroll/runs/${S.oct.id}/recalculate`)).status).toBe(403);
    expect((await A.del(`/payroll/runs/${S.oct.id}`)).status).toBe(403);
    expect((await A.post('/payroll/runs', { month: '2026-09' })).status).toBe(403);
    expect((await ali.get('/payroll/runs')).status).toBe(403);
    expect((await ali.get(`/payroll/runs/${S.oct.id}`)).status).toBe(403);
  });

  it('M6-29 HR cannot finalize (403)', async () => {
    expect((await H.post(`/payroll/runs/${S.oct.id}/finalize`)).status).toBe(403);
    expect((await ctx.db.one('select status from payroll_runs where id = $1', [S.oct.id])).status).toBe('draft');
  });

  it('M6-30 Admin finalizes: status finalized, month locked, payslips available, audited', async () => {
    const res = await A.post(`/payroll/runs/${S.oct.id}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'finalized' });
    expect(res.body.finalizedAt).toBeTruthy();
    expect((await ali.get('/payslips')).body).toHaveLength(1);
    const audit = (await A.get('/audit', { action: 'PAYROLL_FINALIZED' })).body.items;
    expect(audit[0]).toMatchObject({ entityId: S.oct.id, actorRole: 'admin' });
  });

  it('M6-31 editing, regenerating or deleting a finalized run is blocked', async () => {
    const before = JSON.stringify(await slipsOf(S.oct.id));
    for (const res of [await H.post(`/payroll/runs/${S.oct.id}/recalculate`), await H.del(`/payroll/runs/${S.oct.id}`)]) {
      expect([403, 409, 423]).toContain(res.status);
    }
    expect((await A.post(`/payroll/runs/${S.oct.id}/recalculate`)).status).toBe(403);
    await expect(ctx.db.query('update payslips set net_pay = 1 where payroll_run_id = $1', [S.oct.id])).rejects.toThrow(/locked/);
    expect(JSON.stringify(await slipsOf(S.oct.id))).toBe(before);
  });

  it('M6-32 finalizing twice is refused; no duplicate payslips', async () => {
    const res = await A.post(`/payroll/runs/${S.oct.id}/finalize`);
    expect([409, 423]).toContain(res.status);
    expect(await ctx.count('payslips', 'payroll_run_id = $1', [S.oct.id])).toBe(4);
  });

  it('M6-03 a salary change applies to new drafts; the finalized run is unchanged', async () => {
    const octUsman = slipFor(await slipsOf(S.oct.id), ctx.emp.usman.id);
    expect(octUsman.basic).toBe(60000);
    expect((await H.post(`/employees/${ctx.emp.usman.id}/salary`, { basic: 70000, effectiveFrom: '2026-09-01' })).status).toBe(201);
    const sep = await H.post('/payroll/runs', { month: '2026-09' });
    expect(sep.status).toBe(201);
    S.sep = sep.body;
    expect(slipFor(await slipsOf(S.sep.id), ctx.emp.usman.id)).toMatchObject({ basic: 70000, gross: 105000 });
    expect(slipFor(await slipsOf(S.oct.id), ctx.emp.usman.id)).toEqual(octUsman);
    // restore the baseline salary so the November scenarios use basic 60,000
    expect((await H.post(`/employees/${ctx.emp.usman.id}/salary`, { basic: 60000, effectiveFrom: '2026-09-01' })).status).toBe(201);
  });

  it('M6-33 late data after finalize (approved correction) leaves the payslip unchanged', async () => {
    const before = slipFor(await slipsOf(S.oct.id), ctx.emp.usman.id);
    const c = await usman.post('/attendance/corrections', { date: '2026-10-20', requestedCheckIn: '09:00', requestedCheckOut: '17:00', reason: 'Was in office' });
    expect((await H.post(`/attendance/corrections/${c.body.id}/approve`, {})).status).toBe(200);
    expect(slipFor(await slipsOf(S.oct.id), ctx.emp.usman.id)).toEqual(before);
  });

  it('M6-34 finalizing notifies each employee in the run', async () => {
    for (const t of [ctx.tok.ali, ctx.tok.sara, ctx.tok.usman, ctx.tok.hr]) {
      const items = (await ctx.as(t).get('/notifications')).body.items;
      expect(items.some((n) => n.type === 'PAYSLIP_READY' && /October 2026/.test(n.title))).toBe(true);
    }
  });

  it('M6-35 employees cannot get a draft payslip', async () => {
    const draftSlip = slipFor(await slipsOf(S.sep.id), ctx.emp.ali.id);
    const mine = (await ali.get('/payslips')).body;
    expect(mine.map((p) => p.month)).toEqual(['2026-10']);
    expect((await ali.get(`/payslips/${draftSlip.id}`)).status).toBe(404);
    expect((await ali.get(`/payslips/${draftSlip.id}/pdf`)).status).toBe(404);
  });

  it('M6-36 employee downloads own payslip PDF with every figure matching the finalized run', async () => {
    const slip = (await ali.get('/payslips')).body[0];
    const res = await ali.get(`/payslips/${slip.id}/pdf`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const { PDFParse } = await import('pdf-parse');
    const text = (await new PDFParse({ data: res.body }).getText()).text.replace(/\s+/g, ' ');
    const money = (n) => `PKR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    for (const s of ['Ali Khan', 'EMP-001', 'October 2026', money(slip.basic), money(slip.hra), money(slip.medical), money(slip.gross),
      money(slip.deductionAmount), money(slip.tax), money(slip.netPay), 'Absent days: 21']) {
      expect(text).toContain(s);
    }
  });

  it("M6-37 employee cannot get another employee's payslip (403)", async () => {
    const saraSlip = (await sara.get('/payslips')).body[0];
    expect((await ali.get(`/payslips/${saraSlip.id}`)).status).toBe(403);
    expect((await ali.get(`/payslips/${saraSlip.id}/pdf`)).status).toBe(403);
    expect((await ali.get('/payslips', { employeeId: ctx.emp.sara.id })).body.every((p) => p.employeeId === ctx.emp.ali.id)).toBe(true);
  });

  it("M6-38 HR and Admin can download any employee's payslip", async () => {
    const saraSlip = (await sara.get('/payslips')).body[0];
    for (const c of [H, A]) {
      const res = await c.get(`/payslips/${saraSlip.id}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
    }
  });

  it('M6-39 the payslip PDF URL needs a token (401)', async () => {
    const saraSlip = (await sara.get('/payslips')).body[0];
    expect((await ctx.as(null).get(`/payslips/${saraSlip.id}/pdf`)).status).toBe(401);
  });
});

describe('M6 draft calculations — November 2026 (20 working days)', () => {
  let nov;
  beforeAll(async () => {
    ctx.at('2026-11-02T08:00');
    const joiner = await H.post('/employees', { employeeCode: 'EMP-010', fullName: 'Jamil Joiner', email: 'joiner@test.co', departmentId: ctx.ids.eng, joinDate: '2026-11-16', basicSalary: 100000, status: 'probation' });
    const leaver = await H.post('/employees', { employeeCode: 'EMP-011', fullName: 'Laila Leaver', email: 'leaver@test.co', departmentId: ctx.ids.eng, joinDate: '2026-01-01', basicSalary: 100000, status: 'active' });
    S.joiner = joiner.body.employee;
    S.leaver = leaver.body.employee;
    const tj = await ctx.firstLogin('joiner@test.co', joiner.body.tempPassword, 'Joinpass123');
    const tl = await ctx.firstLogin('leaver@test.co', leaver.body.tempPassword, 'Leavepass123');
    expect((await H.put(`/employees/${S.leaver.id}`, { status: 'resigned', exitDate: '2026-11-12', exitReason: 'Moved city' })).status).toBe(200);

    const unpaid = await ali.post('/leave/requests', { leaveTypeId: ctx.ids.types.UNPAID, startDate: '2026-11-04', endDate: '2026-11-05', reason: 'Personal' });
    const annual = await sara.post('/leave/requests', { leaveTypeId: ctx.ids.types.ANNUAL, startDate: '2026-11-11', endDate: '2026-11-11', reason: 'Trip' });
    await H.post(`/leave/requests/${unpaid.body.id}/approve`, {});
    await H.post(`/leave/requests/${annual.body.id}/approve`, {});

    // Normal days are checked in only (missing_checkout counts as attended and is never deducted) to keep the run short.
    const go = async (tok, d, out = null) => { try { await attend(ctx, tok, d, '09:00', out); } catch (e) { if (!/ECONNRESET|INTERNAL/.test(e.message)) throw e; await attend(ctx, tok, d, '09:00', out); } };
    const days = workingDays('2026-11-01', '2026-11-30');
    expect(days).toHaveLength(20);
    for (const d of days) {
      await go(ctx.tok.usman, d);
      if (d !== '2026-11-11') await go(ctx.tok.sara, d);
      if (!['2026-11-03', '2026-11-04', '2026-11-05'].includes(d)) {
        await go(ctx.tok.ali, d, ['2026-11-06', '2026-11-10'].includes(d) ? '13:00' : null);
      }
      if (d >= '2026-11-16') await go(tj, d);
      if (d <= '2026-11-12') await go(tl, d);
    }
    ctx.at('2026-12-01T10:00');
    const run = await H.post('/payroll/runs', { month: '2026-11' });
    expect(run.status).toBe(201);
    nov = await slipsOf(run.body.id);
  }, 900_000);

  it('M6-05 Usman, full attendance, gross 90,000: per day 4,500, deduction 0, tax 2,000, net 88,000', () => {
    expect(slipFor(nov, ctx.emp.usman.id)).toMatchObject({ gross: 90000, workingDays: 20, perDayRate: 4500, deductionAmount: 0, tax: 2000, netPay: 88000 });
  });

  it('M6-06 Ali 1 absent day = 7,500', () => {
    const p = slipFor(nov, ctx.emp.ali.id);
    expect(p.absentDays).toBe(1);
    expect(p.perDayRate * p.absentDays).toBe(7500);
  });

  it('M6-07 Ali 2 unpaid leave days = 15,000', () => {
    const p = slipFor(nov, ctx.emp.ali.id);
    expect(p.unpaidLeaveDays).toBe(2);
    expect(p.perDayRate * p.unpaidLeaveDays).toBe(15000);
  });

  it('M6-08 Ali 2 half days = 0.5 × 2 = 1 day = 7,500', () => {
    const p = slipFor(nov, ctx.emp.ali.id);
    expect(p.halfDays).toBe(2);
    expect(p.perDayRate * 0.5 * p.halfDays).toBe(7500);
  });

  it('M6-09 Ali combined: 4 days = 30,000; tax 10,000; net 110,000', () => {
    expect(slipFor(nov, ctx.emp.ali.id)).toMatchObject({ gross: 150000, deductionDays: 4, deductionAmount: 30000, tax: 10000, netPay: 110000 });
  });

  it('M6-10 paid (annual) leave is not deducted', () => {
    expect(slipFor(nov, ctx.emp.sara.id)).toMatchObject({ absentDays: 0, unpaidLeaveDays: 0, deductionAmount: 0 });
  });

  it('M6-11 Sara gross 120,000, no deductions: tax 5,500, net 114,500', () => {
    expect(slipFor(nov, ctx.emp.sara.id)).toMatchObject({ gross: 120000, tax: 5500, netPay: 114500 });
  });

  it('M6-12 joiner on Mon 16 Nov: 11 of 20 working days → 82,500 before other deductions', () => {
    expect(slipFor(nov, S.joiner.id)).toMatchObject({ employedWorkingDays: 11, prorationFactor: 0.55, proratedGross: 82500, absentDays: 0 });
  });

  it('M6-13 leaver with last day Thu 12 Nov: 8 of 20 working days → 60,000 before other deductions', () => {
    expect(slipFor(nov, S.leaver.id)).toMatchObject({ employedWorkingDays: 8, prorationFactor: 0.4, proratedGross: 60000, absentDays: 0 });
  });

  it('M6-14 the 9 Nov holiday is not an absence', async () => {
    expect(slipFor(nov, ctx.emp.usman.id).absentDays).toBe(0);
    const day = await ctx.db.one("select status from fn_daily_status('2026-11-09','2026-11-09', null, $1)", [ctx.emp.usman.id]);
    expect(day.status).toBe('holiday');
  });
});

describe('M6 tax slab boundaries (§8.3)', () => {
  const table = [
    ['M6-15', 40000, 480000, 0, 0], ['M6-16', 50000, 600000, 0, 0], ['M6-17', 90000, 1080000, 24000, 2000],
    ['M6-18', 100000, 1200000, 30000, 2500], ['M6-19', 120000, 1440000, 66000, 5500], ['M6-20', 150000, 1800000, 120000, 10000],
    ['M6-21', 200000, 2400000, 210000, 17500], ['M6-22', 300000, 3600000, 510000, 42500], ['M6-23', 400000, 4800000, 930000, 77500],
  ];
  for (const [id, monthly, annual, annualTax, monthlyTax] of table) {
    it(`${id} monthly gross ${monthly} → annual ${annual}, annual tax ${annualTax}, monthly tax ${monthlyTax}`, () => {
      expect(tax.annualTax(monthly * 12)).toBeCloseTo(annualTax, 2);
      expect(tax.monthlyTax(monthly)).toBeCloseTo(monthlyTax, 2);
    });
  }
});
