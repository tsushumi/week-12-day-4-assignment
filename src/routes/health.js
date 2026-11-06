'use strict';

const express = require('express');

// Turns a driver error into a short, safe message (never a connection string or host name)
function describeDbError(err) {
  // Prisma wraps driver errors (e.g. P2010 with meta.driverAdapterError.cause.kind), so look at all of it
  const text = `${err?.code ?? ''} ${err?.message ?? ''} ${err?.cause?.message ?? ''} ${JSON.stringify(err?.meta ?? {})}`;
  if (/HEALTH_TIMEOUT|timeout|timed out|SocketTimeout/i.test(text)) return 'Connection timed out';
  if (/DatabaseNotReachable|Can't reach database/i.test(text)) return 'Database server unreachable';
  if (/ECONNREFUSED|refused/i.test(text)) return 'Connection refused';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'Database host not found';
  if (/password|authentication|28P01/i.test(text)) return 'Authentication failed';
  if (/ECONNRESET|terminated|closed/i.test(text)) return 'Connection lost';
  return 'Database unavailable';
}

function createHealthRouter({ prisma, pool, poolConfig, timeoutMs = 3000, logger = console }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    const timestamp = new Date().toISOString();
    const configInfo = {
      connectionLimit: poolConfig.connectionLimit,
      poolTimeout: poolConfig.poolTimeout,
      environment: poolConfig.environment,
    };
    const start = process.hrtime.bigint();
    let timer;
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Health check timed out'), { code: 'HEALTH_TIMEOUT' })), timeoutMs);
        }),
      ]);
      const responseTimeMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      return res.json({
        status: 'healthy',
        database: {
          connected: true,
          responseTimeMs,
          poolConfig: configInfo,
          // Live pool state: connections open / idle / queries waiting for a free connection
          pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        },
        timestamp,
      });
    } catch (err) {
      logger.error(`Health check failed: ${err?.message}`);
      return res.status(503).json({
        status: 'degraded',
        database: {
          connected: false,
          error: describeDbError(err),
          poolConfig: configInfo,
          pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        },
        timestamp,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}

module.exports = { createHealthRouter, describeDbError };
