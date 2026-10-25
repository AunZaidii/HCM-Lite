import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { activeUserIds, notify } from '../lib/notify.js';
import { forbidden, notFound } from '../lib/errors.js';
import { containsPattern } from '../lib/text.js';
import { protect, requireEmployee, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';
import * as analytics from './analytics.service.js';

const router = Router();
const idParam = z.object({ id: z.string().uuid() });
const filters = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), departmentId: z.string().uuid().optional() })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: 'Start date must be on or before end date', path: ['to'] });

// ---- Dashboards (all numbers from SQL aggregation, filterable by date range + department) ----
router.get('/analytics/hr', ...protect, requireRole('admin', 'hr'), validate({ query: filters }), h(async (req, res) => res.json(await analytics.hrDashboard(req.query))));
router.get('/analytics/admin', ...protect, requireRole('admin'), validate({ query: filters }), h(async (req, res) => res.json(await analytics.adminDashboard(req.query))));
router.get('/analytics/me', ...protect, requireEmployee, h(async (req, res) => res.json(await analytics.myDashboard(req.user))));
router.get('/analytics/leave-utilization', ...protect, requireRole('admin', 'hr'),
  validate({ query: z.object({ year: z.coerce.number().int().optional(), departmentId: z.string().uuid().optional() }) }),
  h(async (req, res) => res.json(await analytics.leaveUtilization(req.query))));

// ---- Announcements ----
const visibleTo = (role) => (role === 'employee' ? ['all', 'employee'] : role === 'hr' ? ['all', 'hr', 'employee'] : ['all', 'hr', 'employee']);

router.get('/announcements', ...protect, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }) }), h(async (req, res) => {
  res.json(await db.query(
    `select a.*, u.full_name as author_name, u.role as author_role from announcements a left join users u on u.id = a.created_by
     where a.audience = any($1) order by a.pinned desc, a.created_at desc limit $2`, [visibleTo(req.user.role), req.query.limit || 50]));
}));

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(120), body: z.string().trim().min(3).max(2000),
  audience: z.enum(['all', 'hr', 'employee']).default('all'), pinned: z.boolean().default(false),
});

router.post('/announcements', ...protect, requireRole('admin', 'hr'), validate({ body: announcementSchema }), h(async (req, res) => {
  const b = req.body;
  const row = await db.one('insert into announcements (title, body, audience, pinned, created_by) values ($1,$2,$3,$4,$5) returning *',
    [b.title, b.body, b.audience, b.pinned, req.user.id]);
  await audit({ actor: req.user, action: 'ANNOUNCEMENT_POSTED', entityType: 'announcement', entityId: row.id, after: row, req });
  const roles = b.audience === 'all' ? ['admin', 'hr', 'employee'] : b.audience === 'hr' ? ['hr'] : ['employee', 'hr'];
  await notify((await activeUserIds(roles)).filter((id) => id !== req.user.id), { type: 'ANNOUNCEMENT', title: b.title, link: '/announcements' });
  res.status(201).json(row);
}));

router.delete('/announcements/:id', ...protect, requireRole('admin', 'hr'), validate({ params: idParam }), h(async (req, res) => {
  const row = await db.one('select * from announcements where id = $1', [req.params.id]);
  if (!row) throw notFound();
  if (req.user.role !== 'admin' && row.createdBy !== req.user.id) throw forbidden('Only the author or Admin can delete this');
  await db.query('delete from announcements where id = $1', [row.id]);
  await audit({ actor: req.user, action: 'ANNOUNCEMENT_DELETED', entityType: 'announcement', entityId: row.id, before: row, req });
  res.status(204).end();
}));

// ---- Notifications (own only) ----
router.get('/notifications', ...protect, h(async (req, res) => {
  const items = await db.query('select * from notifications where user_id = $1 order by created_at desc limit 50', [req.user.id]);
  const { n } = await db.one('select count(*)::int as n from notifications where user_id = $1 and not is_read', [req.user.id]);
  res.json({ items, unreadCount: n });
}));
router.post('/notifications/read-all', ...protect, h(async (req, res) => {
  await db.query('update notifications set is_read = true where user_id = $1 and not is_read', [req.user.id]);
  res.status(204).end();
}));
router.post('/notifications/:id/read', ...protect, validate({ params: idParam }), h(async (req, res) => {
  const row = await db.one('update notifications set is_read = true where id = $1 and user_id = $2 returning id', [req.params.id, req.user.id]);
  if (!row) throw notFound('Notification not found');
  res.status(204).end();
}));

// ---- Audit log (Admin view only; append-only in the DB) ----
router.get('/audit', ...protect, requireRole('admin'), validate({ query: z.object({
  action: z.string().optional(), entityType: z.string().optional(), actorId: z.string().uuid().optional(),
  from: z.string().date().optional(), to: z.string().date().optional(), page: z.coerce.number().int().min(1).optional(),
}) }), h(async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.action) add('action ilike ?', containsPattern(req.query.action));
  if (req.query.entityType) add('entity_type = ?', req.query.entityType);
  if (req.query.actorId) add('actor_user_id = ?', req.query.actorId);
  if (req.query.from) add("created_at >= (?::date::timestamp at time zone 'Asia/Karachi')", req.query.from);
  if (req.query.to) add("created_at < ((?::date + 1)::timestamp at time zone 'Asia/Karachi')", req.query.to);
  const page = req.query.page || 1;
  const w = where.length ? `where ${where.join(' and ')}` : '';
  const { total } = await db.one(`select count(*)::int as total from audit_logs ${w}`, params);
  const items = await db.query(`select * from audit_logs ${w} order by created_at desc limit 50 offset ${(page - 1) * 50}`, params);
  res.json({ items, total, page, pageSize: 50 });
}));

router.get('/ai/logs', ...protect, requireRole('admin'), h(async (_req, res) => {
  res.json(await db.query(`select l.*, u.full_name from ai_logs l left join users u on u.id = l.user_id order by l.created_at desc limit 100`));
}));

export default router;
