'use strict';

/**
 * Prisma client singleton, with connection pooling, environment-aware logging and slow-query warnings.
 *
 *  - Singleton: the client is cached on globalThis, so nodemon / hot-reload re-evaluating this module
 *    reuses one client (and one connection pool) instead of opening a new pool every time.
 *  - Pool size comes from DATABASE_URL (?connection_limit=5&pool_timeout=10), see poolConfig.js.
 *  - Development logs every query; production logs only warnings, errors and slow queries.
 *  - Any query slower than SLOW_QUERY_MS (default 100ms) is logged with console.warn in every environment.
 */

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { parsePoolConfig } = require('./poolConfig');
const { recordQuery } = require('./queryCounter');

function createPrismaClient({ url = process.env.DATABASE_URL, schema, env = process.env, logger = console } = {}) {
  const poolConfig = parsePoolConfig(url, env);
  const slowQueryMs = Number.parseInt(env.SLOW_QUERY_MS, 10) || 100;
  const isDevelopment = poolConfig.environment === 'development';

  // ORM queries use this schema; RAW queries ($queryRaw...) do NOT, they use the connection's search_path (public)
  const schemaName = schema ?? poolConfig.schema;

  const pool = new Pool({
    connectionString: poolConfig.connectionString,
    max: poolConfig.connectionLimit,
    connectionTimeoutMillis: poolConfig.poolTimeout * 1000,
  });
  // An idle connection dropped by the server must not crash the process
  pool.on('error', (err) => logger.error(`Database pool error: ${err.message}`));

  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, schemaName ? { schema: schemaName } : undefined),
    // 'query' is always an event (so slow queries can be detected everywhere); what we PRINT depends on the environment
    log: [{ level: 'query', emit: 'event' }, { level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }],
  });

  prisma.$on('query', (e) => {
    recordQuery();
    if (e.duration > slowQueryMs) {
      logger.warn(`SLOW QUERY (${e.duration}ms): ${e.query}`);
    } else if (isDevelopment && env.LOG_QUERIES !== 'false') {
      logger.log(`prisma:query (${e.duration}ms) ${e.query}`);
    }
  });

  return { prisma, pool, poolConfig, schema: schemaName ?? 'public' };
}

// One instance per process, even if this file is loaded twice (hot reload)
const globalForPrisma = globalThis;
function getDefaultClient() {
  if (!globalForPrisma.__prismaClient) globalForPrisma.__prismaClient = createPrismaClient();
  return globalForPrisma.__prismaClient;
}

module.exports = {
  createPrismaClient,
  // Lazy getters: requiring this module never opens a connection or throws when DATABASE_URL is missing (tests build their own clients)
  get prisma() { return getDefaultClient().prisma; },
  get pool() { return getDefaultClient().pool; },
  get poolConfig() { return getDefaultClient().poolConfig; },
};
