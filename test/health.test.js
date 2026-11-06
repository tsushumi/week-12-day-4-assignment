'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, startApp, silent } = require('./helpers');
const { createPrismaClient } = require('../src/lib/prisma');
const { parsePoolConfig } = require('../src/lib/poolConfig');

let db;
let app;
test.before(async () => {
  db = await createTestDb({ seed: false });
  app = await startApp(db);
});
test.after(async () => {
  await app.close();
  await db.close();
});

test('GET /health with the database up: 200 and the documented shape', async () => {
  const res = await app.request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'healthy');
  assert.equal(res.json.database.connected, true);
  assert.equal(typeof res.json.database.responseTimeMs, 'number');
  assert.deepEqual(res.json.database.poolConfig, { connectionLimit: 5, poolTimeout: 10, environment: process.env.NODE_ENV || 'development' });
  const { total, idle, waiting } = res.json.database.pool;
  assert.ok(total >= 1 && total <= 5 && idle <= total && waiting === 0);
  assert.ok(!Number.isNaN(Date.parse(res.json.timestamp)));
});

test('GET /health with the database unreachable: 503 degraded, without leaking connection details', async () => {
  const dead = createPrismaClient({ url: 'postgresql://secretuser:secretpass@127.0.0.1:1/nodb?connection_limit=2&pool_timeout=2', logger: silent });
  const deadApp = await startApp(dead, { healthTimeoutMs: 3000 });
  try {
    const res = await deadApp.request('GET', '/health');
    assert.equal(res.status, 503);
    assert.equal(res.json.status, 'degraded');
    assert.equal(res.json.database.connected, false);
    assert.match(res.json.database.error, /^(Database server unreachable|Connection (refused|timed out|lost))$/);
    assert.deepEqual(res.json.database.poolConfig.connectionLimit, 2);
    assert.ok(!res.text.includes('secretpass') && !res.text.includes('secretuser') && !res.text.includes('127.0.0.1'));
    assert.ok(!Number.isNaN(Date.parse(res.json.timestamp)));
  } finally {
    await deadApp.close();
    await dead.prisma.$disconnect().catch(() => {});
    await dead.pool.end().catch(() => {});
  }
});

test('GET /health answers 503 "Connection timed out" when the database does not answer in time', async () => {
  const slow = { ...db, prisma: { $queryRaw: () => new Promise(() => {}) } }; // never resolves
  const slowApp = await startApp(slow, { healthTimeoutMs: 150 });
  try {
    const started = Date.now();
    const res = await slowApp.request('GET', '/health');
    assert.equal(res.status, 503);
    assert.equal(res.json.database.error, 'Connection timed out');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await slowApp.close();
  }
});

test('parsePoolConfig: reads the URL, strips Prisma-only parameters, falls back per environment', () => {
  const dev = parsePoolConfig('postgresql://u:p@h:5432/db?connection_limit=5&pool_timeout=10&sslmode=require', { NODE_ENV: 'development' });
  assert.deepEqual([dev.connectionLimit, dev.poolTimeout, dev.environment], [5, 10, 'development']);
  assert.ok(!dev.connectionString.includes('connection_limit') && !dev.connectionString.includes('pool_timeout'));
  assert.ok(dev.connectionString.includes('sslmode=require'), 'other parameters are kept');
  const prod = parsePoolConfig('postgresql://u:p@h:5432/db?connection_limit=20&pool_timeout=10', { NODE_ENV: 'production' });
  assert.deepEqual([prod.connectionLimit, prod.environment], [20, 'production']);
  assert.equal(parsePoolConfig('postgresql://u:p@h/db', { NODE_ENV: 'production' }).connectionLimit, 20, 'production default');
  assert.equal(parsePoolConfig('postgresql://u:p@h/db', {}).connectionLimit, 5, 'development default');
  assert.equal(parsePoolConfig('postgresql://u:p@h/db?connection_limit=abc&pool_timeout=-1', {}).poolTimeout, 10, 'bad values fall back');
  assert.equal(parsePoolConfig('postgresql://u:p@h/db?schema=foo').schema, 'foo');
  assert.throws(() => parsePoolConfig(undefined), /DATABASE_URL is not set/);
});

test('the pool never opens more connections than connection_limit, extra queries wait', async () => {
  const limited = createPrismaClient({ url: `${process.env.DATABASE_URL.split('?')[0]}?connection_limit=2&pool_timeout=10`, schema: db.schema, logger: silent, env: { ...process.env, LOG_QUERIES: 'false' } });
  try {
    let maxTotal = 0;
    let maxWaiting = 0;
    const sampler = setInterval(() => {
      maxTotal = Math.max(maxTotal, limited.pool.totalCount);
      maxWaiting = Math.max(maxWaiting, limited.pool.waitingCount);
    }, 10);
    await Promise.all(Array.from({ length: 8 }, () => limited.prisma.$queryRaw`SELECT pg_sleep(0.1)::text`));
    clearInterval(sampler);
    assert.ok(maxTotal <= 2, `pool grew to ${maxTotal}`);
    assert.ok(maxWaiting >= 1, 'queries queued while the pool was busy');
  } finally {
    await limited.prisma.$disconnect();
    await limited.pool.end();
  }
});

test('slow queries (>100ms) are logged with a warning in development AND production; normal queries only in development', async () => {
  for (const [nodeEnv, expectQueryLog] of [['development', true], ['production', false]]) {
    const warnings = [];
    const lines = [];
    const logger = { log: (m) => lines.push(m), warn: (m) => warnings.push(m), error() {} };
    const c = createPrismaClient({ url: process.env.DATABASE_URL, schema: db.schema, logger, env: { ...process.env, NODE_ENV: nodeEnv, SLOW_QUERY_MS: '100' } });
    try {
      await c.prisma.$queryRaw`SELECT 1`;
      await c.prisma.$queryRaw`SELECT pg_sleep(0.2)::text`;
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(warnings.some((w) => w.startsWith('SLOW QUERY (') && w.includes('pg_sleep')), `${nodeEnv}: slow query warning`);
      assert.ok(!warnings.some((w) => w.includes('SELECT 1')), 'fast query is not a warning');
      assert.equal(lines.some((l) => l.startsWith('prisma:query') && l.includes('SELECT 1')), expectQueryLog, `${nodeEnv}: per-query log`);
    } finally {
      await c.prisma.$disconnect();
      await c.pool.end();
    }
  }
});

test('singleton: loading src/lib/prisma.js again (hot reload) reuses the same client and pool', async () => {
  const modulePath = require.resolve('../src/lib/prisma');
  const first = require('../src/lib/prisma');
  const a = first.prisma;
  delete require.cache[modulePath];
  const second = require('../src/lib/prisma');
  assert.equal(second.prisma, a);
  assert.equal(second.pool, first.pool);
  await a.$disconnect();
  await first.pool.end();
  delete globalThis.__prismaClient;
});
