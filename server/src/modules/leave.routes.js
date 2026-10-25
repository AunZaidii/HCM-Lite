import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { activeUserIds, notify } from '../lib/notify.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { todayLocal } from '../lib/time.js';
import { protect, requireEmployee, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';
import { assertPreviewOk, leaveBalances, onLeave, previewLeave } from './leave.service.js';

const router = Router();
const idParam = z.object({ id: z.string().uuid() });
const date = z.string().date();

router.get('/leave/balance', ...protect,
  validate({ query: z.object({ year: z.coerce.number().int().optional(), employeeId: z.string().uuid().optional() }) }),
  h(async (req, res) => {
    let employeeId = req.user.employeeId;
    if (req.query.employeeId && req.user.role !== 'employee') employeeId = req.query.employeeId;
    if (!employeeId) throw unprocessable('EMPLOYEE_REQUIRED', 'Pass employeeId');
    res.json(await leaveBalances(employeeId, req.query.year || Number(todayLocal().slice(0, 4))));
  }));

const previewSchema = z.object({ leaveTypeId: z.string().uuid(), startDate: date, endDate: date });

router.post('/leave/preview', ...protect, requireRole('hr', 'employee'), requireEmployee, validate({ body: previewSchema }),
  h(async (req, res) => res.json(await previewLeave(req.user.employeeId, req.body))));

router.post('/leave/requests', ...protect, requireRole('hr', 'employee'), requireEmployee,
  validate({ body: previewSchema.extend({ reason: z.string().trim().max(500).optional().default(''), source: z.enum(['form', 'smart']).default('form') }) }),
  h(async (req, res) => {
    const b = req.body;
    if (b.startDate < addDaysStr(todayLocal(), -7)) throw unprocessable('INVALID_DATES', 'Leave cannot start more than 7 days in the past');
    const row = await tx(async (q) => {
      const preview = await previewLeave(req.user.employeeId, b, q);
      assertPreviewOk(preview);
      const created = await q.one(
        `insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, source)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.user.employeeId, b.leaveTypeId, b.startDate, b.endDate, preview.workingDays, b.reason, b.source]);
      await audit({ q, actor: req.user, action: 'LEAVE_APPLIED', entityType: 'leave_request', entityId: created.id, after: created, req });
      const hrIds = (await activeUserIds(['hr'], q)).filter((id) => id !== req.user.id);
      await notify(hrIds, { type: 'LEAVE_SUBMITTED', title: `${req.user.fullName} applied for ${preview.leaveType.name} leave`,
        body: `${b.startDate} → ${b.endDate} (${preview.workingDays} day(s))`, link: '/leave/approvals' }, q);
      return created;
    });
    res.status(201).json(row);
  }));

function addDaysStr(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

router.get('/leave/requests', ...protect, validate({ query: z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(), mine: z.enum(['true', 'false']).optional(),
}) }), h(async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.user.role === 'employee' || req.query.mine === 'true') add('l.employee_id = ?', req.user.employeeId);
  else if (req.query.employeeId) add('l.employee_id = ?', req.query.employeeId);
  if (req.query.status) add('l.status = ?', req.query.status);
  if (req.query.departmentId) add('e.department_id = ?', req.query.departmentId);
  res.json(await db.query(
    `select l.*, e.full_name, e.employee_code, d.name as department_name, t.name as leave_type_name, r.full_name as reviewer_name
     from leave_requests l join employees e on e.id = l.employee_id join departments d on d.id = e.department_id
     join leave_types t on t.id = l.leave_type_id left join users r on r.id = l.reviewer_id
     ${where.length ? `where ${where.join(' and ')}` : ''} order by l.created_at desc limit 200`, params));
}));

router.get('/leave/on-leave', ...protect, requireRole('admin', 'hr'), validate({ query: z.object({ date: date.optional() }) }),
  h(async (req, res) => {
    const d = req.query.date || todayLocal();
    res.json(await onLeave({ from: d, to: d }));
  }));

router.post('/leave/requests/:id/cancel', ...protect, validate({ params: idParam }), h(async (req, res) => {
  const before = await db.one('select * from leave_requests where id = $1', [req.params.id]);
  if (!before) throw notFound('Leave request not found');
  if (before.employeeId !== req.user.employeeId) throw forbidden('You can only cancel your own leave');
  const cancellable = before.status === 'pending' || (before.status === 'approved' && before.startDate > todayLocal());
  if (!cancellable) throw unprocessable('CANNOT_CANCEL', 'Only pending or future approved leave can be cancelled');
  const after = await db.one("update leave_requests set status = 'cancelled', cancelled_at = now() where id = $1 returning *", [before.id]);
  await audit({ actor: req.user, action: 'LEAVE_CANCELLED', entityType: 'leave_request', entityId: before.id, before, after, req });
  res.json(after);
}));

async function decide(req, res, approve) {
  const result = await tx(async (q) => {
    const before = await q.one('select * from leave_requests where id = $1 for update', [req.params.id]);
    if (!before) throw notFound('Leave request not found');
    if (before.status !== 'pending') throw conflict('ALREADY_DECIDED', `This request is already ${before.status}`);
    if (before.employeeId === req.user.employeeId) throw unprocessable('SELF_APPROVAL', 'You cannot decide your own leave; another HR user must');
    if (approve) {
      // Balance and overlap may have changed since the request was made.
      assertPreviewOk(await previewLeave(before.employeeId, { ...before, excludeRequestId: before.id }, q));
    }
    const after = await q.one(
      'update leave_requests set status = $1, reviewer_id = $2, review_comment = $3, reviewed_at = now() where id = $4 returning *',
      [approve ? 'approved' : 'rejected', req.user.id, req.body.comment || null, before.id]);
    await audit({ q, actor: req.user, action: approve ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED', entityType: 'leave_request', entityId: before.id, before, after, req });
    const emp = await q.one('select user_id from employees where id = $1', [before.employeeId]);
    await notify([emp.userId], {
      type: 'LEAVE_DECIDED', title: `Your leave ${before.startDate} → ${before.endDate} was ${approve ? 'approved' : 'rejected'}`,
      body: req.body.comment || null, link: '/leave' }, q);
    return after;
  });
  res.json(result);
}

router.post('/leave/requests/:id/approve', ...protect, requireRole('hr'),
  validate({ params: idParam, body: z.object({ comment: z.string().trim().max(500).optional() }) }), h((req, res) => decide(req, res, true)));
router.post('/leave/requests/:id/reject', ...protect, requireRole('hr'),
  validate({ params: idParam, body: z.object({ comment: z.string().trim().min(2, 'A comment is required to reject').max(500) }) }),
  h((req, res) => decide(req, res, false)));

export default router;
