import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

const PG_CONFLICTS = {
  attendance_employee_id_work_date_key: ['ALREADY_CHECKED_IN', 'You have already checked in today'],
  leave_no_overlap: ['LEAVE_OVERLAP', 'This leave overlaps an existing request'],
  corrections_one_pending: ['PENDING_EXISTS', 'A correction for this date is already pending'],
  payroll_runs_period_month_key: ['RUN_EXISTS', 'A payroll run already exists for this month'],
};

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the highlighted fields',
        details: err.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
      },
    });
  }
  if (err.code === '23505' || err.code === '23P01') {
    const [code, message] = PG_CONFLICTS[err.constraint] || ['DUPLICATE', `Duplicate value${err.detail ? `: ${err.detail}` : ''}`];
    return res.status(err.code === '23P01' ? 422 : 409).json({ error: { code, message } });
  }
  if (typeof err.code === 'string' && err.code.startsWith('22')) {
    return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'One of the values is not valid' } });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: { code: 'IN_USE', message: 'This record is in use and cannot be removed' } });
  }
  if (err.code === 'P0001' && /locked/.test(err.message)) {
    return res.status(423).json({ error: { code: 'PAYROLL_LOCKED', message: 'Payroll is finalized and locked' } });
  }
  if (err.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'The file is larger than 1 MB' } })
      : res.status(400).json({ error: { code: 'BAD_UPLOAD', message: `Upload error: ${err.message}` } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  // Details stay in the server log; the client never sees SQL, stack traces or connection info.
  console.error(env.NODE_ENV === 'production' ? `${err.code || ''} ${err.message}` : err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
}
