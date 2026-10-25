import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { notFound } from '../lib/errors.js';
import { protect, requireRole } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';

const router = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a valid time HH:MM (00:00–23:59)');

// ---- Company settings (Admin manage, HR view) ----
router.get('/settings', ...protect, requireRole('admin', 'hr'), h(async (_req, res) => res.json(await getSettings())));

router.get('/settings/public', ...protect, h(async (_req, res) => {
  const s = await getSettings();
  res.json({
    companyName: s.companyName, officeStart: s.officeStart, officeEnd: s.officeEnd, graceMinutes: s.graceMinutes,
    halfDayHours: s.halfDayHours, weekendDays: s.weekendDays, cameraCheckinEnabled: s.cameraCheckinEnabled,
    officeRadiusM: s.officeRadiusM, latePenaltyEnabled: s.latePenaltyEnabled, faceMatchRequired: s.faceMatchRequired,
  });
}));

const settingsSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  officeStart: time,
  officeEnd: time,
  graceMinutes: z.coerce.number().int().min(0).max(120),
  halfDayHours: z.coerce.number().positive().max(12),
  weekendDays: z.array(z.number().int().min(1).max(7)).max(6),
  officeLat: z.coerce.number().min(-90).max(90).nullable(),
  officeLng: z.coerce.number().min(-180).max(180).nullable(),
  officeRadiusM: z.coerce.number().int().min(10).max(5000),
  latePenaltyEnabled: z.boolean(),
  cameraCheckinEnabled: z.boolean(),
  faceMatchRequired: z.boolean(),
}).partial();

const SETTINGS_COLUMNS = {
  companyName: 'company_name', officeStart: 'office_start', officeEnd: 'office_end', graceMinutes: 'grace_minutes',
  halfDayHours: 'half_day_hours', weekendDays: 'weekend_days', officeLat: 'office_lat', officeLng: 'office_lng',
  officeRadiusM: 'office_radius_m', latePenaltyEnabled: 'late_penalty_enabled', cameraCheckinEnabled: 'camera_checkin_enabled', faceMatchRequired: 'face_match_required',
};

router.put('/settings', ...protect, requireRole('admin'), validate({ body: settingsSchema }), h(async (req, res) => {
  const before = await getSettings();
  const keys = Object.keys(req.body);
  if (!keys.length) return res.json(before);
  const sets = keys.map((k, i) => `${SETTINGS_COLUMNS[k]} = $${i + 1}`);
  const after = await db.one(
    `update company_settings set ${sets.join(', ')}, updated_by = $${keys.length + 1}, updated_at = now() where id = 1 returning *`,
    [...keys.map((k) => req.body[k]), req.user.id],
  );
  await audit({ actor: req.user, action: 'SETTINGS_UPDATED', entityType: 'company', entityId: 1, before, after, req });
  res.json(after);
}));

// ---- Generic Admin-managed lookup tables ----
function crud({ path, table, entity, schema, columns, order, readRoles = ['admin', 'hr'] }) {
  router.get(`/${path}`, ...protect, requireRole(...readRoles), h(async (req, res) => {
    const where = req.query.active === 'true' ? 'where is_active' : '';
    res.json(await db.query(`select * from ${table} ${table === 'holidays' ? '' : where} order by ${order}`));
  }));

  router.post(`/${path}`, ...protect, requireRole('admin'), validate({ body: schema }), h(async (req, res) => {
    const keys = Object.keys(req.body);
    const row = await db.one(
      `insert into ${table} (${keys.map((k) => columns[k]).join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      keys.map((k) => req.body[k]),
    );
    await audit({ actor: req.user, action: `${entity}_CREATED`, entityType: entity.toLowerCase(), entityId: row.id, after: row, req });
    res.status(201).json(row);
  }));

  router.put(`/${path}/:id`, ...protect, requireRole('admin'), validate({ ...idParam, body: schema.partial() }), h(async (req, res) => {
    const before = await db.one(`select * from ${table} where id = $1`, [req.params.id]);
    if (!before) throw notFound();
    const keys = Object.keys(req.body);
    if (!keys.length) return res.json(before);
    const row = await db.one(
      `update ${table} set ${keys.map((k, i) => `${columns[k]} = $${i + 1}`).join(', ')} where id = $${keys.length + 1} returning *`,
      [...keys.map((k) => req.body[k]), req.params.id],
    );
    await audit({ actor: req.user, action: `${entity}_UPDATED`, entityType: entity.toLowerCase(), entityId: row.id, before, after: row, req });
    res.json(row);
  }));

  router.delete(`/${path}/:id`, ...protect, requireRole('admin'), validate(idParam), h(async (req, res) => {
    const before = await db.one(`delete from ${table} where id = $1 returning *`, [req.params.id]);
    if (!before) throw notFound();
    await audit({ actor: req.user, action: `${entity}_DELETED`, entityType: entity.toLowerCase(), entityId: before.id, before, req });
    res.status(204).end();
  }));
}

crud({
  path: 'departments', table: 'departments', entity: 'DEPARTMENT', order: 'name',
  schema: z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().min(1).max(20), isActive: z.boolean().optional() }),
  columns: { name: 'name', code: 'code', isActive: 'is_active' },
});

crud({
  path: 'designations', table: 'designations', entity: 'DESIGNATION', order: 'title',
  schema: z.object({ title: z.string().trim().min(2).max(80), departmentId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() }),
  columns: { title: 'title', departmentId: 'department_id', isActive: 'is_active' },
});

crud({
  path: 'leave-types', table: 'leave_types', entity: 'LEAVE_TYPE', order: 'name',
  readRoles: ['admin', 'hr', 'employee'], // employees need the types for the leave form
  schema: z.object({
    name: z.string().trim().min(2).max(40),
    code: z.string().trim().min(2).max(20).transform((s) => s.toUpperCase()),
    yearlyQuota: z.coerce.number().int().min(0).max(365).nullable(),
    isPaid: z.boolean().default(true),
    isActive: z.boolean().optional(),
  }),
  columns: { name: 'name', code: 'code', yearlyQuota: 'yearly_quota', isPaid: 'is_paid', isActive: 'is_active' },
});

crud({
  path: 'holidays', table: 'holidays', entity: 'HOLIDAY', order: 'date',
  schema: z.object({ date: z.string().date(), name: z.string().trim().min(2).max(80) }),
  columns: { date: 'date', name: 'name' },
});

// One click "standard leave types" (configuration, not dummy data): Annual 14, Sick 8, Casual 10, Unpaid unlimited.
router.post('/leave-types/standard', ...protect, requireRole('admin'), h(async (req, res) => {
  const created = await tx(async (q) => {
    const rows = await q.query(
      `insert into leave_types (name, code, yearly_quota, is_paid) values
         ('Annual','ANNUAL',14,true), ('Sick','SICK',8,true), ('Casual','CASUAL',10,true), ('Unpaid','UNPAID',null,false)
       on conflict do nothing returning *`,
    );
    for (const row of rows) {
      await audit({ q, actor: req.user, action: 'LEAVE_TYPE_CREATED', entityType: 'leave_type', entityId: row.id, after: row, req });
    }
    return rows;
  });
  res.status(201).json(created);
}));

export default router;
