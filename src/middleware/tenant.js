'use strict';

const { HttpError } = require('../errors');

const MAX_INT4 = 2147483647; // tenantId is a PostgreSQL INTEGER

function readTenantId(req) {
  const raw = req.get('X-Tenant-Id');
  if (raw === undefined || raw.trim() === '') return { missing: true };
  const value = raw.trim();
  // Strict: "1abc", "1.5", "-1" and "0" are rejected (parseInt would have accepted "1abc" as tenant 1)
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > MAX_INT4) return { invalid: true, raw: value.slice(0, 40) };
  return { tenantId: Number(value) };
}

/**
 * Required tenant: every /api/v1 route runs behind this. The tenant comes ONLY from the X-Tenant-Id header
 * and is attached to req.tenantId; route handlers put it in every query's `where`.
 *
 * NOTE: a header is an identification mechanism, not authentication. In a real system the tenant must come
 * from something the caller cannot choose freely (the verified identity in a JWT/API key), otherwise any
 * client can read any tenant's data by changing the header. See README, "Tenant isolation".
 */
function tenantMiddleware(req, res, next) {
  const result = readTenantId(req);
  if (result.missing) return next(new HttpError(400, 'TENANT_REQUIRED', 'X-Tenant-Id header is required'));
  if (result.invalid) return next(new HttpError(400, 'INVALID_TENANT', 'X-Tenant-Id must be a positive integer', { received: result.raw }));
  req.tenantId = result.tenantId;
  return next();
}

// For the Task 2 demo endpoints (/api/users-*): scoped when the header is present, all tenants otherwise.
function optionalTenant(req, res, next) {
  const result = readTenantId(req);
  if (result.invalid) return next(new HttpError(400, 'INVALID_TENANT', 'X-Tenant-Id must be a positive integer', { received: result.raw }));
  req.tenantId = result.missing ? undefined : result.tenantId;
  return next();
}

module.exports = { tenantMiddleware, optionalTenant };
