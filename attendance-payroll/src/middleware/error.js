'use strict';
const { HttpError } = require('../utils/http');

const PG_MESSAGES = {
  '23505': [409, 'That value is already in use'],
  '23503': [409, 'This record is referenced by other data and cannot be changed this way'],
  '23514': [400, 'A value is outside the allowed range'],
  '22P02': [400, 'Invalid value format'],
  '22007': [400, 'Invalid date or time'],
  '22008': [400, 'Invalid date or time'],
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details, code: err.code });
  }
  if (err.code && PG_MESSAGES[err.code]) {
    const [status, message] = PG_MESSAGES[err.code];
    const hint = err.code === '23505' && err.constraint ? ` (${err.constraint.replace(/_/g, ' ')})` : '';
    return res.status(status).json({ error: message + hint });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: 'Something went wrong on the server' });
}

const notFoundHandler = (req, res) => res.status(404).json({ error: 'Endpoint not found' });

module.exports = { errorHandler, notFoundHandler };
