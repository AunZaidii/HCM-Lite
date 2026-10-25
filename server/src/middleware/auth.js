import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });

// Verifies the JWT and reloads the user so deactivation takes effect immediately.
export async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized('UNAUTHENTICATED', 'Please sign in');
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      throw unauthorized('INVALID_TOKEN', 'Your session has expired, please sign in again');
    }
    const user = await db.one(
      `select u.id, u.email, u.role, u.full_name, u.is_active, u.must_change_password,
              e.id as employee_id, e.department_id
       from users u left join employees e on e.user_id = u.id where u.id = $1`,
      [payload.sub],
    );
    if (!user) throw unauthorized('INVALID_TOKEN', 'Please sign in');
    if (!user.isActive) throw unauthorized('ACCOUNT_DISABLED', 'This account has been deactivated');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Users with a temporary password can only change it.
const ALLOWED_BEFORE_CHANGE = ['/api/auth/change-password', '/api/auth/me', '/api/auth/logout'];
export function passwordGate(req, _res, next) {
  if (req.user?.mustChangePassword && !ALLOWED_BEFORE_CHANGE.includes(req.originalUrl.split('?')[0])) {
    return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password first'));
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden());

// Employee-facing endpoints need an employee profile (Admin has none).
export function requireEmployee(req, _res, next) {
  if (!req.user?.employeeId) return next(new AppError(404, 'NO_EMPLOYEE_PROFILE', 'Your login has no employee profile'));
  next();
}

export const protect = [authenticate, passwordGate];
