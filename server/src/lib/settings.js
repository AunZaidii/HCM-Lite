import { db } from './db.js';

export async function getSettings(q = db) {
  return q.one('select * from company_settings where id = 1');
}

// Rules used for new attendance records (settings apply to new records only).
export async function attendanceRules(q = db) {
  const s = await getSettings(q);
  return {
    officeStart: s.officeStart,
    graceMinutes: s.graceMinutes,
    halfDayHours: Number(s.halfDayHours),
    weekendDays: s.weekendDays,
  };
}

export async function holidaySet(from, to, q = db) {
  const rows = await q.query('select date from holidays where date between $1 and $2', [from, to]);
  return new Set(rows.map((r) => r.date));
}
