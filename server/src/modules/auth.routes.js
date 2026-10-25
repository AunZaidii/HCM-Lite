import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, tx } from '../lib/db.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { comparePassword, hashPassword } from '../lib/password.js';
import { conflict, unauthorized, unprocessable } from '../lib/errors.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { h, validate } from '../middleware/validate.js';

const router = Router();

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a digit');

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a valid time HH:MM (00:00–23:59)');

const publicUser = (u, employee) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  fullName: u.fullName,
  mustChangePassword: u.mustChangePassword,
  employeeId: employee?.id ?? u.employeeId ?? null,
});

const isSetupComplete = async () => !!(await db.one('select 1 as ok from company_settings where id = 1'));

// Creates the env Admin on boot when ADMIN_EMAIL/ADMIN_PASSWORD are set and no admin exists yet.
export async function bootstrapEnvAdmin() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return;
  const admin = await db.one("select id from users where role = 'admin' limit 1");
  if (admin) return;
  await db.query(
    "insert into users (email, password_hash, role, full_name) values ($1, $2, 'admin', 'Administrator')",
    [env.ADMIN_EMAIL, await hashPassword(env.ADMIN_PASSWORD)],
  );
  console.log(`Admin created from env: ${env.ADMIN_EMAIL}`);
}

router.get('/setup/status', h(async (_req, res) => {
  const admin = await db.one("select 1 as ok from users where role = 'admin' limit 1");
  res.json({ setupComplete: await isSetupComplete(), adminExists: !!admin, adminFromEnv: !!env.ADMIN_EMAIL });
}));

const setupSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  officeStart: time.default('09:00'),
  officeEnd: time.default('18:00'),
  graceMinutes: z.coerce.number().int().min(0).max(120).default(15),
  halfDayHours: z.coerce.number().positive().max(12).default(5),
  weekendDays: z.array(z.number().int().min(1).max(7)).default([6, 7]),
  admin: z
    .object({
      fullName: z.string().trim().min(2),
      email: z.string().trim().email(),
      password: passwordSchema,
    })
    .optional(),
});

router.post('/setup', validate({ body: setupSchema }), h(async (req, res) => {
  const b = req.body;
  const result = await tx(async (q) => {
    await q.query('lock table company_settings in exclusive mode');
    if (await q.one('select 1 as ok from company_settings where id = 1')) {
      throw conflict('SETUP_ALREADY_DONE', 'Setup has already been completed');
    }
    let admin = await q.one("select * from users where role = 'admin' limit 1");
    if (!admin) {
      if (!b.admin) throw unprocessable('ADMIN_REQUIRED', 'Admin account details are required');
      admin = await q.one(
        "insert into users (email, password_hash, role, full_name) values ($1,$2,'admin',$3) returning *",
        [b.admin.email, await hashPassword(b.admin.password), b.admin.fullName],
      );
    }
    const settings = await q.one(
      `insert into company_settings (id, company_name, office_start, office_end, grace_minutes, half_day_hours, weekend_days, updated_by)
       values (1,$1,$2,$3,$4,$5,$6,$7) returning *`,
      [b.companyName, b.officeStart, b.officeEnd, b.graceMinutes, b.halfDayHours, b.weekendDays, admin.id],
    );
    await audit({ q, actor: admin, action: 'SETUP_COMPLETED', entityType: 'company', entityId: 1, after: settings, req });
    return admin;
  });
  // Env admin must still sign in with their password; wizard admin is signed in directly.
  if (b.admin) return res.status(201).json({ token: signToken(result), user: publicUser(result) });
  res.status(201).json({ ok: true });
}));

const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts, try again in a minute' } } });

router.post('/auth/login', loginLimiter,
  validate({ body: z.object({ email: z.string().trim().email(), password: z.string().min(1) }) }),
  h(async (req, res) => {
    const user = await db.one(
      `select u.*, e.id as employee_id from users u left join employees e on e.user_id = u.id where u.email = $1`,
      [req.body.email],
    );
    if (!user || !(await comparePassword(req.body.password, user.passwordHash))) {
      await audit({ action: 'LOGIN_FAILED', entityType: 'user', entityId: user?.id, after: { email: req.body.email }, req });
      throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (!user.isActive) throw unauthorized('ACCOUNT_DISABLED', 'This account has been deactivated');
    await db.query('update users set last_login_at = now() where id = $1', [user.id]);
    await audit({ actor: user, action: 'LOGIN', entityType: 'user', entityId: user.id, req });
    res.json({ token: signToken(user), user: publicUser(user) });
  }));

router.get('/auth/me', authenticate, h(async (req, res) => {
  const company = await db.one('select company_name, office_start, office_end, weekend_days, camera_checkin_enabled from company_settings where id = 1');
  const employee = req.user.employeeId
    ? await db.one(
      `select e.id, e.employee_code, e.full_name, d.name as department_name, g.title as designation_title
       from employees e join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
       where e.id = $1`, [req.user.employeeId])
    : null;
  res.json({ user: publicUser(req.user), employee, company });
}));

router.post('/auth/logout', authenticate, h(async (req, res) => {
  await audit({ actor: req.user, action: 'LOGOUT', entityType: 'user', entityId: req.user.id, req });
  res.status(204).end();
}));

router.post('/auth/change-password', authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }) }),
  h(async (req, res) => {
    const user = await db.one('select * from users where id = $1', [req.user.id]);
    if (!(await comparePassword(req.body.currentPassword, user.passwordHash))) {
      throw unprocessable('WRONG_PASSWORD', 'Current password is incorrect', [{ field: 'currentPassword', reason: 'Incorrect password' }]);
    }
    if (req.body.currentPassword === req.body.newPassword) {
      throw unprocessable('SAME_PASSWORD', 'New password must be different', [{ field: 'newPassword', reason: 'Must differ from current password' }]);
    }
    await db.query('update users set password_hash = $1, must_change_password = false, updated_at = now() where id = $2',
      [await hashPassword(req.body.newPassword), user.id]);
    await audit({ actor: req.user, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: user.id, req });
    res.json({ token: signToken(user), user: publicUser({ ...req.user, mustChangePassword: false }) });
  }));

export default router;
