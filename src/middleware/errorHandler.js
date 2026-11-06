'use strict';

const { HttpError } = require('../errors');

function notFound(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} was not found`));
}

function errorHandler({ isProduction, logger = console }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details;

    if (err instanceof HttpError) {
      ({ status, code, message, details } = err);
    } else if (err?.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; message = 'Request body contains invalid JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large';
    } else {
      logger.error(`[${req.method} ${req.originalUrl}]`, err);
      if (!isProduction && err?.message) message = err.message; // never leak internals in production
    }

    res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
  };
}

module.exports = { notFound, errorHandler };
