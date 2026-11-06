'use strict';

require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createPrismaClient } = require('../src/lib/prisma');
const { parsePoolConfig } = require('../src/lib/poolConfig');
const { applyMigrations, quoteIdent } = require('../scripts/lib/migrations');
const { seedDatabase } = require('../prisma/seed');
const { createApp } = require('../src/app');

const silent = { log() {}, warn() {}, error() {} };

/**
 * A private PostgreSQL schema (test_<pid>_<random>) inside DATABASE_URL's database: migrated with the real
 * migration files and seeded with the real seed. Your development data in the "public" schema is never touched.
 */
async function createTestDb({ seed = true, seedOptions = {} } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set to run the tests');
  const schema = `test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const admin = new Client({ connectionString: parsePoolConfig(url).connectionString });
  await admin.connect();
  await applyMigrations(admin, { schema });
  const client = createPrismaClient({ url, schema, env: { ...process.env, LOG_QUERIES: 'false' }, logger: silent });
  const counts = seed ? await seedDatabase(client.prisma, { schema, ...seedOptions }) : null;

  return {
    ...client,
    admin,
    schema,
    counts,
    async close() {
      await client.prisma.$disconnect().catch(() => {});
      await client.pool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

async function startApp(deps, options = {}) {
  const logs = { log: [], warn: [], error: [] };
  const logger = { log: (...a) => logs.log.push(a.join(' ')), warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.join(' ')) };
  const app = createApp({ ...deps, logger, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, headers: res.headers, text, json };
  }
  const as = (tenantId) => (method, path, opts = {}) => request(method, path, { ...opts, headers: { 'X-Tenant-Id': String(tenantId), ...(opts.headers || {}) } });

  return {
    base, request, as, logs,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

module.exports = { createTestDb, startApp, silent };
