import { Router } from 'express';
import { z } from 'zod';
import { getDistance } from 'geolib';
import { db, tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { activeUserIds, notify } from '../lib/notify.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { isWeekend } from '../lib/rules/calendar.js';
import { isLate, statusOnCheckIn, statusOnCheckOut } from '../lib/rules/attendance.js';
import { attendanceRules, getSettings } from '../lib/settings.js';
import { now as clockNow } from '../lib/clock.js';
import { addDays, localMinutes, localTimeString, localToDate, monthEnd, timeToMinutes, todayLocal } from '../lib/time.js';
import { protect, requireEmployee, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';

const router = Router();
const idParam = z.object({ id: z.string().uuid() });

async function todayRecord(employeeId) {
  return db.one('select * from attendance where employee_id = $1 and work_date = $2', [employeeId, todayLocal()]);
}

router.get('/attendance/today', ...protect, requireEmployee, h(async (req, res) => {
  const today = todayLocal();
  const leave = await db.one(
    `select t.name from leave_requests l join leave_types t on t.id = l.leave_type_id
     where l.employee_id = $1 and l.status = 'approved' and $2 between l.start_date and l.end_date`, [req.user.employeeId, today]);
  res.json({ date: today, serverTime: clockNow().toISOString(), localTime: localTimeString(), record: await todayRecord(req.user.employeeId), onLeave: leave?.name ?? null });
}));

// Server stamps the time; one record per employee per day (DB unique -> 409).
async function checkIn(req, { source = 'web', geo = {} } = {}) {
  const employeeId = req.user.employeeId;
  const today = todayLocal();
  const now = clockNow();
  const rules = await attendanceRules();
  if (await todayRecord(employeeId)) throw conflict('ALREADY_CHECKED_IN', 'You have already checked in today');
  const onLeave = await db.one(
    "select id from leave_requests where employee_id = $1 and status = 'approved' and $2 between start_date and end_date", [employeeId, today]);
  if (onLeave) throw unprocessable('ON_LEAVE_TODAY', 'You are on approved leave today');
  const holiday = await db.one('select id from holidays where date = $1', [today]);
  const minutes = localMinutes(now);
  const late = isLate(minutes, rules);
  const row = await db.one(
    `insert into attendance (employee_id, work_date, check_in_at, status, is_late, is_off_day, source,
       rule_office_start, rule_grace_minutes, rule_half_day_hours, check_in_lat, check_in_lng, geo_accuracy_m, distance_m)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [employeeId, today, now, statusOnCheckIn(minutes, rules), late, !!holiday || isWeekend(today, rules.weekendDays), source,
      rules.officeStart, rules.graceMinutes, rules.halfDayHours, geo.lat ?? null, geo.lng ?? null, geo.accuracy ?? null, geo.distance ?? null]);
  await audit({ actor: req.user, action: source === 'camera' ? 'CAMERA_CHECK_IN' : 'CHECK_IN', entityType: 'attendance', entityId: row.id, after: row, req });
  return row;
}

router.post('/attendance/check-in', ...protect, requireRole('hr', 'employee'), requireEmployee, h(async (req, res) => {
  res.status(201).json(await checkIn(req));
}));

router.post('/attendance/check-out', ...protect, requireRole('hr', 'employee'), requireEmployee, h(async (req, res) => {
  const before = await todayRecord(req.user.employeeId);
  if (!before) throw conflict('NOT_CHECKED_IN', 'You have not checked in today');
  if (before.checkOutAt) throw conflict('ALREADY_CHECKED_OUT', 'You have already checked out today');
  const now = clockNow();
  const worked = Math.floor((now - new Date(before.checkInAt)) / 60000);
  const status = statusOnCheckOut(before.isLate, worked, { halfDayHours: Number(before.ruleHalfDayHours) });
  const after = await db.one(
    'update attendance set check_out_at = $1, worked_minutes = $2, status = $3, updated_at = now() where id = $4 returning *',
    [now, worked, status, before.id]);
  await audit({ actor: req.user, action: 'CHECK_OUT', entityType: 'attendance', entityId: after.id, before, after, req });
  res.json(after);
}));

const descriptorSchema = z.array(z.number().finite()).length(128);
const FACE_MATCH_THRESHOLD = 0.5; // Euclidean distance between face-api descriptors

// Face enrollment (bonus): stores only the 128-number descriptor, never a photo.
router.get('/attendance/face', ...protect, requireEmployee, h(async (req, res) => {
  const row = await db.one('select enrolled_at from face_profiles where employee_id = $1', [req.user.employeeId]);
  res.json({ enrolled: !!row, enrolledAt: row?.enrolledAt ?? null });
}));

router.post('/attendance/face/enroll', ...protect, requireRole('hr', 'employee'), requireEmployee,
  validate({ body: z.object({ descriptor: descriptorSchema }) }), h(async (req, res) => {
    await db.query(
      `insert into face_profiles (employee_id, descriptor) values ($1, $2)
       on conflict (employee_id) do update set descriptor = excluded.descriptor, enrolled_at = now()`,
      [req.user.employeeId, req.body.descriptor]);
    await audit({ actor: req.user, action: 'FACE_ENROLLED', entityType: 'employee', entityId: req.user.employeeId, req });
    res.status(204).end();
  }));

// Camera check-in: the phone/browser only sends data; the server decides (Haversine distance, accuracy, one face,
// and — when Admin requires it — face match against the enrolled descriptor plus a blink liveness result).
router.post('/attendance/camera-check-in', ...protect, requireRole('hr', 'employee'), requireEmployee,
  validate({ body: z.object({
    lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0), faceCount: z.number().int().min(0),
    descriptor: descriptorSchema.optional(), livenessPassed: z.boolean().optional(),
  }) }),
  h(async (req, res) => {
    const s = await getSettings();
    const { lat, lng, accuracy, faceCount } = req.body;
    let distance = null;
    const reject = async (reason, message) => {
      await db.query('insert into checkin_attempts (employee_id, reason, lat, lng, accuracy_m, distance_m) values ($1,$2,$3,$4,$5,$6)',
        [req.user.employeeId, reason, lat, lng, accuracy, distance]);
      throw unprocessable(reason, `${message} If this keeps failing, request an attendance correction from HR.`);
    };
    if (!s.cameraCheckinEnabled || s.officeLat === null || s.officeLng === null) await reject('LOCATION_NOT_SET', 'Camera check-in is not configured by Admin.');
    if (faceCount === 0) await reject('NO_FACE', 'No face detected.');
    if (faceCount > 1) await reject('MULTIPLE_FACES', 'More than one face detected.');
    if (accuracy > 100) await reject('LOW_ACCURACY', `GPS accuracy is ${Math.round(accuracy)} m (must be 100 m or better).`);
    distance = getDistance({ latitude: lat, longitude: lng }, { latitude: s.officeLat, longitude: s.officeLng });
    if (distance > s.officeRadiusM) await reject('OUTSIDE_RADIUS', `You are ${distance} m from the office (allowed ${s.officeRadiusM} m).`);
    let faceVerified = null;
    if (s.faceMatchRequired) {
      const profile = await db.one('select descriptor from face_profiles where employee_id = $1', [req.user.employeeId]);
      if (!profile) await reject('FACE_NOT_ENROLLED', 'Enroll your face on the camera page first.');
      if (!req.body.descriptor) await reject('FACE_MISMATCH', 'Face could not be read.');
      const dist = Math.sqrt(profile.descriptor.reduce((sum, v, i) => sum + (v - req.body.descriptor[i]) ** 2, 0));
      if (dist >= FACE_MATCH_THRESHOLD) await reject('FACE_MISMATCH', 'Face does not match the enrolled employee.');
      if (!req.body.livenessPassed) await reject('LIVENESS_FAILED', 'Blink check not passed — please blink once while facing the camera.');
      faceVerified = true;
    }
    const row = await checkIn(req, { source: 'camera', geo: { lat, lng, accuracy, distance } });
    const updated = await db.one('update attendance set face_verified = $1, liveness_passed = $2 where id = $3 returning *',
      [faceVerified, req.body.livenessPassed ?? null, row.id]);
    res.status(201).json(updated);
  }));

// Daily board: every employee's status for a date, from the shared fn_daily_status.
router.get('/attendance/board', ...protect, requireRole('admin', 'hr'),
  validate({ query: z.object({ date: z.string().date().optional(), departmentId: z.string().uuid().optional(), status: z.string().max(30).optional() }) }),
  h(async (req, res) => {
    const date = req.query.date || todayLocal();
    const rows = await db.query(
      `select s.employee_id, e.full_name, e.employee_code, d.name as department_name, s.status, s.is_late, s.worked_minutes,
              a.check_in_at, a.check_out_at, a.source, t.name as leave_type
       from fn_daily_status($1::date, $1::date, $2::uuid, null) s
       join employees e on e.id = s.employee_id join departments d on d.id = e.department_id
       left join attendance a on a.employee_id = s.employee_id and a.work_date = s.work_date
       left join leave_types t on t.id = s.leave_type_id
       where e.status in ('active','probation') or e.exit_date >= $1::date
       order by d.name, e.full_name`, [date, req.query.departmentId ?? null]);
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    res.json({ date, counts, rows: req.query.status ? rows.filter((r) => r.status === req.query.status) : rows });
  }));

router.get('/attendance/calendar', ...protect,
  validate({ query: z.object({ employeeId: z.string().uuid().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() }) }),
  h(async (req, res) => {
    let employeeId = req.query.employeeId || req.user.employeeId;
    if (req.user.role === 'employee' && employeeId !== req.user.employeeId) throw forbidden('You can only view your own attendance');
    if (!employeeId) throw unprocessable('EMPLOYEE_REQUIRED', 'Choose an employee');
    const month = req.query.month || todayLocal().slice(0, 7);
    const days = await db.query(
      `select s.work_date as date, s.status, s.is_late, s.worked_minutes, a.check_in_at, a.check_out_at, a.source, t.name as leave_type
       from fn_daily_status($1::date, $2::date, null, $3) s
       left join attendance a on a.employee_id = s.employee_id and a.work_date = s.work_date
       left join leave_types t on t.id = s.leave_type_id order by s.work_date`, [`${month}-01`, monthEnd(month), employeeId]);
    const totals = {};
    for (const d of days) totals[d.status] = (totals[d.status] || 0) + 1;
    res.json({ month, employeeId, days, totals });
  }));

// ---- Corrections: employee requests, HR approves ----
router.post('/attendance/corrections', ...protect, requireRole('hr', 'employee'), requireEmployee,
  validate({ body: z.object({
    date: z.string().date(),
    requestedCheckIn: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
    requestedCheckOut: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
    reason: z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500),
  }) }),
  h(async (req, res) => {
    const b = req.body;
    const today = todayLocal();
    if (b.date > today || b.date < addDays(today, -30)) throw unprocessable('INVALID_DATE', 'Date must be within the last 30 days');
    if (!b.requestedCheckIn && !b.requestedCheckOut) throw unprocessable('TIME_REQUIRED', 'Give a check-in and/or check-out time');
    if (b.requestedCheckIn && b.requestedCheckOut && b.requestedCheckOut <= b.requestedCheckIn) throw unprocessable('INVALID_TIMES', 'Check-out must be after check-in');
    const row = await db.one(
      `insert into attendance_corrections (employee_id, work_date, requested_check_in, requested_check_out, reason)
       values ($1,$2,$3,$4,$5) returning *`,
      [req.user.employeeId, b.date, b.requestedCheckIn ? localToDate(b.date, b.requestedCheckIn) : null,
        b.requestedCheckOut ? localToDate(b.date, b.requestedCheckOut) : null, b.reason]);
    await audit({ actor: req.user, action: 'CORRECTION_REQUESTED', entityType: 'attendance_correction', entityId: row.id, after: row, req });
    const hrIds = (await activeUserIds(['hr'])).filter((id) => id !== req.user.id);
    await notify(hrIds, { type: 'CORRECTION_SUBMITTED', title: `${req.user.fullName} requested an attendance correction for ${b.date}`, link: '/attendance/corrections' });
    res.status(201).json(row);
  }));

router.get('/attendance/corrections', ...protect,
  validate({ query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional(), mine: z.enum(['true', 'false']).optional() }) }),
  h(async (req, res) => {
    const params = [];
    const where = [];
    if (req.user.role === 'employee' || req.query.mine === 'true') { params.push(req.user.employeeId); where.push(`c.employee_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    res.json(await db.query(
      `select c.*, e.full_name, e.employee_code, r.full_name as reviewer_name from attendance_corrections c
       join employees e on e.id = c.employee_id left join users r on r.id = c.reviewer_id
       ${where.length ? `where ${where.join(' and ')}` : ''} order by c.created_at desc limit 200`, params));
  }));

async function decideCorrection(req, res, approve) {
  const result = await tx(async (q) => {
    const c = await q.one('select * from attendance_corrections where id = $1 for update', [req.params.id]);
    if (!c) throw notFound('Correction not found');
    if (c.status !== 'pending') throw conflict('ALREADY_DECIDED', `This correction is already ${c.status}`);
    if (c.employeeId === req.user.employeeId) throw unprocessable('SELF_APPROVAL', 'You cannot approve your own correction');
    if (approve) {
      const existing = await q.one('select * from attendance where employee_id = $1 and work_date = $2', [c.employeeId, c.workDate]);
      // Existing records keep their rule snapshot; new ones take the current settings.
      const rules = existing
        ? { officeStart: existing.ruleOfficeStart, graceMinutes: existing.ruleGraceMinutes, halfDayHours: Number(existing.ruleHalfDayHours) }
        : await attendanceRules(q);
      const checkIn = c.requestedCheckIn || existing?.checkInAt;
      if (!checkIn) throw unprocessable('CHECK_IN_REQUIRED', 'No check-in exists for that day; the request must include a check-in time');
      const checkOut = c.requestedCheckOut || existing?.checkOutAt || null;
      const late = localMinutes(new Date(checkIn)) > timeToMinutes(rules.officeStart) + rules.graceMinutes;
      const worked = checkOut ? Math.floor((new Date(checkOut) - new Date(checkIn)) / 60000) : null;
      const status = worked !== null ? statusOnCheckOut(late, worked, rules) : (late ? 'late' : 'present');
      const after = existing
        ? await q.one(`update attendance set check_in_at = $1, check_out_at = $2, worked_minutes = $3, status = $4, is_late = $5,
                         source = 'correction', updated_at = now() where id = $6 returning *`,
          [checkIn, checkOut, worked, status, late, existing.id])
        : await q.one(`insert into attendance (employee_id, work_date, check_in_at, check_out_at, worked_minutes, status, is_late, source,
                         rule_office_start, rule_grace_minutes, rule_half_day_hours)
                       values ($1,$2,$3,$4,$5,$6,$7,'correction',$8,$9,$10) returning *`,
          [c.employeeId, c.workDate, checkIn, checkOut, worked, status, late, rules.officeStart, rules.graceMinutes, rules.halfDayHours]);
      await audit({ q, actor: req.user, action: 'ATTENDANCE_CORRECTED', entityType: 'attendance', entityId: after.id, before: existing, after, req });
    }
    const updated = await q.one(
      'update attendance_corrections set status = $1, reviewer_id = $2, review_comment = $3, reviewed_at = now() where id = $4 returning *',
      [approve ? 'approved' : 'rejected', req.user.id, req.body.comment || null, c.id]);
    await audit({ q, actor: req.user, action: approve ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED', entityType: 'attendance_correction', entityId: c.id, before: c, after: updated, req });
    const emp = await q.one('select user_id from employees where id = $1', [c.employeeId]);
    await notify([emp.userId], { type: 'CORRECTION_DECIDED', title: `Your attendance correction for ${c.workDate} was ${approve ? 'approved' : 'rejected'}`,
      body: req.body.comment || null, link: '/attendance/corrections' }, q);
    return updated;
  });
  res.json(result);
}

router.post('/attendance/corrections/:id/approve', ...protect, requireRole('hr'),
  validate({ params: idParam, body: z.object({ comment: z.string().max(500).optional() }) }), h((req, res) => decideCorrection(req, res, true)));
router.post('/attendance/corrections/:id/reject', ...protect, requireRole('hr'),
  validate({ params: idParam, body: z.object({ comment: z.string().trim().min(2, 'A comment is required to reject').max(500) }) }),
  h((req, res) => decideCorrection(req, res, false)));

export default router;
