'use strict';

require('dotenv').config({ quiet: true });

const { prisma, pool, poolConfig } = require('./src/lib/prisma');
const { createApp } = require('./src/app');

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const app = createApp({
  prisma,
  pool,
  poolConfig,
  healthTimeoutMs: Number.parseInt(process.env.HEALTH_TIMEOUT_MS, 10) || 3000,
});

const server = app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  console.log(`Database pool: max ${poolConfig.connectionLimit} connections, ${poolConfig.poolTimeout}s wait (${poolConfig.environment})`);
});

// Release database connections on shutdown (nodemon restarts, Ctrl+C, container stop)
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 8000).unref();
  server.close(async () => {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach((signal) => process.on(signal, () => shutdown(signal)));
