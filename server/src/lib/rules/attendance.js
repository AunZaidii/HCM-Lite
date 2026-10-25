import { timeToMinutes } from '../time.js';

// Late strictly after office start + grace (09:15:00 is on time, 09:15:01 is late).
export function isLate(checkInMinutes, rules) {
  return checkInMinutes > timeToMinutes(rules.officeStart) + rules.graceMinutes;
}

export function statusOnCheckIn(checkInMinutes, rules) {
  return isLate(checkInMinutes, rules) ? 'late' : 'present';
}

export function statusOnCheckOut(isLateFlag, workedMinutes, rules) {
  if (workedMinutes < rules.halfDayHours * 60) return 'half_day';
  return isLateFlag ? 'late' : 'present';
}

// Bonus rule: every 3 lates in a month = 0.5 day deduction.
export const latePenaltyDays = (lateCount) => Math.floor(lateCount / 3) * 0.5;
