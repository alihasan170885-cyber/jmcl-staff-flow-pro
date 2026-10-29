'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (msg, details) => new HttpError(400, msg, details);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Wrap async route handlers so rejections reach the error middleware (Express 4). */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate with a zod schema; throws a 400 listing the offending fields. */
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  throw new HttpError(400, `Invalid input: ${details.map((d) => `${d.field || 'value'} ${d.message}`).join('; ')}`, details);
}

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

module.exports = { HttpError, bad, forbidden, notFound, conflict, wrap, parse, toInt };
