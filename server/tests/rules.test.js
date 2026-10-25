import { describe, expect, it } from 'vitest';
import { annualTax, monthlyTax } from '../src/lib/rules/tax.js';
import { computePayslip } from '../src/lib/rules/payroll.js';
import { isLate, latePenaltyDays, statusOnCheckIn, statusOnCheckOut } from '../src/lib/rules/attendance.js';
import { workingDaysBetween } from '../src/lib/rules/calendar.js';

const rules = { officeStart: '09:00:00', graceMinutes: 15, halfDayHours: 5 };
const WEEKEND = [6, 7];

describe('tax slab', () => {
  it.each([
    [540000, 0], [600000, 0], [720000, 6000], [1200000, 30000], [1800000, 120000],
    [2400000, 210000], [3600000, 510000], [4500000, 825000],
  ])('annual %i -> %i', (income, tax) => expect(annualTax(income)).toBeCloseTo(tax, 2));

  it('monthly tax on 60,000 gross is 500', () => expect(monthlyTax(60000)).toBeCloseTo(500, 2));
});

describe('payroll', () => {
  it('full month: 1 absent, 1 unpaid, 2 half days (Oct 2026, 22 working days)', () => {
    const p = computePayslip({ basic: 40000, workingDays: 22, employedWorkingDays: 22, absentDays: 1, unpaidLeaveDays: 1, halfDays: 2 });
    expect(p.gross).toBe(60000);
    expect(p.hra).toBe(16000);
    expect(p.medical).toBe(4000);
    expect(p.deductionDays).toBe(3);
    expect(p.deductionAmount).toBeCloseTo(8181.82, 2);
    expect(p.tax).toBe(500);
    expect(p.netPay).toBeCloseTo(51318.18, 2);
  });

  it('joiner on 15 Oct is prorated 12/22', () => {
    const p = computePayslip({ basic: 40000, workingDays: 22, employedWorkingDays: 12 });
    expect(p.proratedGross).toBeCloseTo(32727.27, 2);
    expect(p.tax).toBeCloseTo(272.73, 2);
    expect(p.netPay).toBeCloseTo(32454.55, 1);
  });

  it('late penalty: every 3 lates = 0.5 day', () => {
    expect(latePenaltyDays(2)).toBe(0);
    expect(latePenaltyDays(3)).toBe(0.5);
    expect(latePenaltyDays(7)).toBe(1);
  });
});

describe('attendance status', () => {
  it('09:15:00 is on time, 09:15:01 is late', () => {
    expect(isLate(9 * 60 + 15, rules)).toBe(false);
    expect(isLate(9 * 60 + 15 + 1 / 60, rules)).toBe(true);
    expect(statusOnCheckIn(9 * 60 + 20, rules)).toBe('late');
  });

  it('under 5 hours is a half day', () => {
    expect(statusOnCheckOut(false, 4 * 60 + 59, rules)).toBe('half_day');
    expect(statusOnCheckOut(true, 8 * 60, rules)).toBe('late');
    expect(statusOnCheckOut(false, 5 * 60, rules)).toBe('present');
  });
});

describe('leave working days', () => {
  it('Mon 26 - Tue 27 Oct 2026 = 2', () => expect(workingDaysBetween('2026-10-26', '2026-10-27', WEEKEND, new Set())).toBe(2));
  it('Fri 30 Oct - Mon 2 Nov skips the weekend = 2', () => expect(workingDaysBetween('2026-10-30', '2026-11-02', WEEKEND, new Set())).toBe(2));
  it('skips public holidays', () => expect(workingDaysBetween('2026-11-04', '2026-11-06', WEEKEND, new Set(['2026-11-05']))).toBe(2));
  it('October 2026 has 22 working days', () => expect(workingDaysBetween('2026-10-01', '2026-10-31', WEEKEND, new Set())).toBe(22));
});
