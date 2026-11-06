'use strict';

// Applies pending migrations to DATABASE_URL without needing Prisma's schema engine.
// Usage: npm run db:deploy
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { applyMigrations } = require('./lib/migrations');
const { parsePoolConfig } = require('../src/lib/poolConfig');

(async () => {
  const { connectionString } = parsePoolConfig(process.env.DATABASE_URL);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const applied = await applyMigrations(client, { log: (line) => console.log(line) });
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
