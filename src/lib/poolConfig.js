'use strict';

/**
 * Reads the Prisma-style pool parameters out of DATABASE_URL.
 *
 *   postgresql://user:pass@host:5432/db?connection_limit=5&pool_timeout=10
 *
 *   connection_limit  max connections this process keeps open (pool size)
 *   pool_timeout      seconds a query waits for a free connection before failing
 *
 * Prisma's own CLI understands these parameters; node-postgres does not, so we strip them from the
 * connection string and apply them to the pg Pool ourselves.
 */

const DEFAULTS = {
  development: { connectionLimit: 5, poolTimeout: 10 },
  production: { connectionLimit: 20, poolTimeout: 10 },
};

const positiveInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function resolveEnvironment(env = process.env) {
  return env.NODE_ENV || 'development';
}

function parsePoolConfig(url, env = process.env) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const environment = resolveEnvironment(env);
  const fallback = DEFAULTS[environment] || DEFAULTS.development;

  const parsed = new URL(url);
  const connectionLimit = positiveInt(parsed.searchParams.get('connection_limit')) ?? fallback.connectionLimit;
  const poolTimeout = positiveInt(parsed.searchParams.get('pool_timeout')) ?? fallback.poolTimeout;
  const schema = parsed.searchParams.get('schema') || undefined;
  parsed.searchParams.delete('connection_limit');
  parsed.searchParams.delete('pool_timeout');
  parsed.searchParams.delete('schema'); // Prisma-only; applied through the adapter's `schema` option

  return { connectionString: parsed.toString(), connectionLimit, poolTimeout, environment, schema };
}

module.exports = { parsePoolConfig, resolveEnvironment, DEFAULTS };
