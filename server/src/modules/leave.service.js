import { db } from '../lib/db.js';
import { unprocessable } from '../lib/errors.js';
import { workingDaysBetween } from '../lib/rules/calendar.js';
import { getSettings, holidaySet } from '../lib/settings.js';

// Balance is computed from requests (never stored), so cancelling restores it automatically.
export async function leaveBalances(employeeId, year, q = db) {
  return q.query(
    `select t.id as leave_type_id, t.name, t.code, t.yearly_quota as quota, t.is_paid,
            coalesce(sum(l.days) filter (where l.status = 'approved'), 0)::float as approved,
            coalesce(sum(l.days) filter (where l.status = 'pending'), 0)::float as pending
     from leave_types t
     left join leave_requests l on l.leave_type_id = t.id and l.employee_id = $1
          and extract(year from l.start_date) = $2 and l.status in ('approved','pending')
     where t.is_active
     group by t.id order by t.name`,
    [employeeId, year],
  ).then((rows) => rows.map((r) => ({
    ...r,
    remaining: r.quota === null ? null : r.quota - r.approved,
    available: r.quota === null ? null : r.quota - r.approved - r.pending,
  })));
}

// Shared by the leave form, smart leave and the final submit/approve checks.
export async function previewLeave(employeeId, { leaveTypeId, startDate, endDate, excludeRequestId = null }, q = db) {
  if (endDate < startDate) throw unprocessable('INVALID_DATES', 'End date must be on or after start date', [{ field: 'endDate', reason: 'Before start date' }]);
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) throw unprocessable('CROSS_YEAR', 'Leave cannot span two years; split it into two requests');
  const type = await q.one('select * from leave_types where id = $1 and is_active', [leaveTypeId]);
  if (!type) throw unprocessable('UNKNOWN_LEAVE_TYPE', 'Leave type not found', [{ field: 'leaveTypeId', reason: 'Unknown leave type' }]);
  const settings = await getSettings(q);
  const workingDays = workingDaysBetween(startDate, endDate, settings.weekendDays, await holidaySet(startDate, endDate, q));
  const overlap = await q.one(
    `select id, start_date, end_date, status from leave_requests
     where employee_id = $1 and status in ('pending','approved') and start_date <= $3 and end_date >= $2
       and ($4::uuid is null or id <> $4) limit 1`,
    [employeeId, startDate, endDate, excludeRequestId],
  );
  const balance = (await leaveBalances(employeeId, Number(startDate.slice(0, 4)), q)).find((b) => b.leaveTypeId === leaveTypeId);
  // When re-checking an existing pending request, its own days are already in "pending".
  const ownPending = excludeRequestId
    ? Number((await q.one('select days from leave_requests where id = $1', [excludeRequestId]))?.days ?? 0) : 0;
  const available = type.yearlyQuota === null ? null : balance.available + ownPending;
  const problems = [];
  if (workingDays === 0) problems.push({ code: 'NO_WORKING_DAYS', message: 'The selected dates contain no working days' });
  if (overlap) problems.push({ code: 'LEAVE_OVERLAP', message: `Overlaps your ${overlap.status} leave ${overlap.startDate} → ${overlap.endDate}` });
  if (available !== null && workingDays > available) {
    problems.push({ code: 'INSUFFICIENT_BALANCE', message: `Only ${available} ${type.name} day(s) available, ${workingDays} requested` });
  }
  return { leaveType: { id: type.id, name: type.name, code: type.code }, workingDays, available, overlap: !!overlap, ok: !problems.length, problems };
}

export function assertPreviewOk(preview) {
  if (!preview.ok) {
    const [first] = preview.problems;
    throw unprocessable(first.code, first.message, preview.problems);
  }
}

// People on leave (approved) in a range. Used by the "who is on leave" list and the AI tool.
export async function onLeave({ from, to, departmentId = null, employeeId = null, status = 'approved' }, q = db) {
  return q.query(
    `select l.id, l.employee_id, e.full_name, e.employee_code, d.name as department_name, t.name as leave_type,
            l.start_date, l.end_date, l.days, l.status
     from leave_requests l join employees e on e.id = l.employee_id join departments d on d.id = e.department_id
     join leave_types t on t.id = l.leave_type_id
     where l.status = $5 and l.start_date <= $2 and l.end_date >= $1
       and ($3::uuid is null or e.department_id = $3) and ($4::uuid is null or e.id = $4)
     order by l.start_date`,
    [from, to, departmentId, employeeId, status],
  );
}
