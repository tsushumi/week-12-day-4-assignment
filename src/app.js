'use strict';

const express = require('express');
const cors = require('cors');
const { createHealthRouter } = require('./routes/health');
const { createUsersRouter } = require('./routes/users');
const { createV1Router } = require('./routes/v1');
const { tenantMiddleware } = require('./middleware/tenant');
const { notFound, errorHandler } = require('./middleware/errorHandler');

/**
 * @param deps.prisma, deps.pool, deps.poolConfig  from src/lib/prisma.js (tests pass their own)
 */
function createApp({ prisma, pool, poolConfig, logger = console, healthTimeoutMs = 3000, isProduction = process.env.NODE_ENV === 'production' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/', (req, res) =>
    res.json({
      name: 'Week 12 Day 4: Database Optimization',
      endpoints: {
        health: 'GET /health',
        nPlusOne: ['GET /api/users-bad', 'GET /api/users-good', 'GET /api/users-comparison'],
        tenantScoped: 'GET /api/v1/{invoices,invoices/:id,clients,clients/:id,posts,stats} and POST /api/v1/invoices (header X-Tenant-Id required)',
      },
    })
  );

  app.use(createHealthRouter({ prisma, pool, poolConfig, timeoutMs: healthTimeoutMs, logger }));
  app.use('/api', createUsersRouter({ prisma, logger }));
  app.use('/api/v1', tenantMiddleware, createV1Router({ prisma }));

  app.use(notFound);
  app.use(errorHandler({ isProduction, logger }));
  return app;
}

module.exports = { createApp };
