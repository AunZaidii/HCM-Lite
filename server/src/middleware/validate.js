// Validates and replaces req.body / req.query / req.params with the parsed zod output.
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['body', 'query', 'params']) {
      if (schemas[key]) {
        const parsed = schemas[key].parse(req[key] ?? {});
        Object.defineProperty(req, key, { value: parsed, writable: true, configurable: true });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Wraps async handlers so thrown errors reach the error handler.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
