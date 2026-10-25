import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { db } from './lib/db.js';
import { AppError } from './lib/errors.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth.routes.js';
import orgRoutes from './modules/org.routes.js';
import employeeRoutes from './modules/employees.routes.js';
import attendanceRoutes from './modules/attendance.routes.js';
import leaveRoutes from './modules/leave.routes.js';
import payrollRoutes from './modules/payroll.routes.js';
import commsRoutes from './modules/comms.routes.js';
import aiRoutes from './modules/ai/ai.routes.js';

export const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const origins = env.CLIENT_ORIGIN.split(',').map((o) => o.trim());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin) || origins.includes('*')), exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', async (_req, res) => {
  try {
    await db.one('select 1 as ok');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

// Until first-run setup is complete only /setup endpoints work.
let setupDone = false;
app.use('/api', async (req, _res, next) => {
  if (setupDone || req.path.startsWith('/setup')) return next();
  try {
    setupDone = !!(await db.one('select 1 as ok from company_settings where id = 1'));
    next(setupDone ? undefined : new AppError(409, 'SETUP_REQUIRED', 'Complete the first-run setup first'));
  } catch (err) {
    next(err);
  }
});

app.use('/api', authRoutes, orgRoutes, employeeRoutes, attendanceRoutes, leaveRoutes, payrollRoutes, commsRoutes, aiRoutes);
app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found')));
app.use(errorHandler);

// Serverless hosts (Vercel) load this module directly and need the app as the default export.
export default app;
