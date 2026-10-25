// Company timezone is Asia/Karachi (UTC+5, no DST). The server is the clock.
import { now } from './clock.js';

const OFFSET_MS = 5 * 60 * 60 * 1000;

const local = (d = now()) => new Date(d.getTime() + OFFSET_MS);

export const todayLocal = (d = now()) => local(d).toISOString().slice(0, 10);
export const localMinutes = (d = now()) => {
  const l = local(d);
  return l.getUTCHours() * 60 + l.getUTCMinutes() + l.getUTCSeconds() / 60;
};
export const localTimeString = (d = now()) => local(d).toISOString().slice(11, 19);

// 'YYYY-MM-DD' + 'HH:MM' (Karachi) -> Date
export const localToDate = (dateStr, timeStr) =>
  new Date(`${dateStr}T${timeStr.length === 5 ? `${timeStr}:00` : timeStr}+05:00`);

export const timeToMinutes = (t) => {
  const [h, m, s = 0] = String(t).split(':').map(Number);
  return h * 60 + m + s / 60;
};

export const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const isoWeekday = (dateStr) => {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

export const monthStart = (yyyyMm) => `${yyyyMm}-01`;
export const monthEnd = (yyyyMm) => {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const minDate = (a, b) => (a < b ? a : b);
export const maxDate = (a, b) => (a > b ? a : b);
