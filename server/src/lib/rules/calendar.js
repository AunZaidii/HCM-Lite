import { addDays, isoWeekday } from '../time.js';

export const isWeekend = (date, weekendDays) => weekendDays.includes(isoWeekday(date));

// Inclusive count of days that are neither weekend nor public holiday.
export function workingDaysBetween(start, end, weekendDays, holidaySet) {
  let count = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d, weekendDays) && !holidaySet.has(d)) count++;
  }
  return count;
}
