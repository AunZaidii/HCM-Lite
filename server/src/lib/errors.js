export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
export const unauthorized = (code, msg) => new AppError(401, code, msg);
export const forbidden = (msg = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (code, msg) => new AppError(409, code, msg);
export const unprocessable = (code, msg, details) => new AppError(422, code, msg, details);
export const locked = (msg = 'Payroll is finalized and locked') => new AppError(423, 'PAYROLL_LOCKED', msg);
