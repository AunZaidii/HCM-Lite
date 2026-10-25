import { monthlyTax } from './tax.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// gross = 1.5 x basic (HRA 40%, medical 10%); per day = gross / working days;
// deductions = absent + unpaid + 0.5 x half days (+ late penalty); joiners/leavers prorated.
export function computePayslip({
  basic, workingDays, employedWorkingDays,
  absentDays = 0, unpaidLeaveDays = 0, halfDays = 0, latePenaltyDays = 0,
}) {
  const hra = basic * 0.4;
  const medical = basic * 0.1;
  const gross = basic + hra + medical;
  const proration = workingDays > 0 ? employedWorkingDays / workingDays : 0;
  const proratedGross = gross * proration;
  const perDay = workingDays > 0 ? gross / workingDays : 0;
  const deductionDays = absentDays + unpaidLeaveDays + 0.5 * halfDays + latePenaltyDays;
  const deduction = perDay * deductionDays;
  const tax = monthlyTax(gross) * proration;
  const net = Math.max(0, proratedGross - deduction - tax);
  return {
    basic: r2(basic), hra: r2(hra), medical: r2(medical), gross: r2(gross),
    prorationFactor: Math.round(proration * 10000) / 10000,
    proratedGross: r2(proratedGross),
    perDayRate: r2(perDay),
    deductionDays,
    deductionAmount: r2(deduction),
    tax: r2(tax),
    netPay: r2(net),
  };
}
