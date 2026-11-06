'use strict';

/**
 * Minimal migration runner for the SQL files in prisma/migrations.
 *
 * `npx prisma migrate dev|deploy` is the normal way to apply them. This runner exists for
 * environments where Prisma's schema-engine binary can't be downloaded (restricted networks,
 * CI sandboxes), and for the throw-away schemas used by the analysis script and the tests.
 * It uses the same bookkeeping table as Prisma (_prisma_migrations, sha256 checksums), so
 * `prisma migrate status` agrees with what was applied here.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

// Resolve "init", "add_indexes" or a full folder name to a migration folder name.
function resolveMigration(nameOrSuffix) {
  const match = listMigrations().find((m) => m.name === nameOrSuffix || m.name.endsWith(`_${nameOrSuffix}`));
  if (!match) throw new Error(`No migration named "${nameOrSuffix}" in prisma/migrations`);
  return match.name;
}

const CREATE_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`;

/**
 * Applies pending migrations (in order) using a connected pg client.
 * @param client  a connected `pg` Client
 * @param opts.schema  PostgreSQL schema to apply into (default: the connection's default)
 * @param opts.only    stop after this migration (name or suffix), e.g. 'init'
 * @returns names of the migrations that were applied by this call
 */
async function applyMigrations(client, { schema, only, log = () => {} } = {}) {
  const stopAfter = only ? resolveMigration(only) : null;
  const applied = [];

  if (schema) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  }
  await client.query(CREATE_HISTORY_TABLE);
  const done = new Map((await client.query('SELECT migration_name, checksum FROM "_prisma_migrations" WHERE rolled_back_at IS NULL')).rows.map((r) => [r.migration_name, r.checksum]));

  for (const migration of listMigrations()) {
    if (done.has(migration.name)) {
      if (done.get(migration.name) !== migration.checksum) {
        throw new Error(`Migration ${migration.name} was modified after it was applied (checksum mismatch)`);
      }
    } else {
      log(`applying ${migration.name}`);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), 1)`,
          [crypto.randomUUID(), migration.checksum, migration.name]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${migration.name} failed: ${err.message}`;
        throw err;
      }
      applied.push(migration.name);
    }
    if (stopAfter && migration.name === stopAfter) break;
  }
  return applied;
}

module.exports = { MIGRATIONS_DIR, listMigrations, resolveMigration, applyMigrations, quoteIdent };
