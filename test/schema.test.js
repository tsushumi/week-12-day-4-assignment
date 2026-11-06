'use strict';

/**
 * Drift guard. The migration SQL is written by hand (see README), so this test compares prisma/schema.prisma with what
 * the migrations really created: tables, columns, types, nullability, primary keys, unique and plain indexes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDb } = require('./helpers');
const { listMigrations, applyMigrations } = require('../scripts/lib/migrations');

const schemaText = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

function parseSchema(text) {
  const models = {};
  for (const match of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const model = { name, fields: [], indexes: [], uniques: [] };
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const attr = /^@@(index|unique)\(\[([^\]]+)\]/.exec(line);
      if (attr) {
        const cols = attr[2].split(',').map((c) => c.trim());
        (attr[1] === 'index' ? model.indexes : model.uniques).push(cols);
        continue;
      }
      const field = /^(\w+)\s+(\w+)(\?|\[\])?(.*)$/.exec(line);
      if (field) model.fields.push({ name: field[1], type: field[2], optional: field[3] === '?', list: field[3] === '[]', attrs: field[4] });
    }
    models[name] = model;
  }
  return models;
}

const PG_TYPES = { Int: 'integer', String: 'text', Float: 'double precision', DateTime: 'timestamp without time zone' };

let db;
test.before(async () => { db = await createTestDb({ seed: false }); });
test.after(async () => { await db.close(); });

test('every model, column, type and nullability in schema.prisma exists in the migrated database', async () => {
  const models = parseSchema(schemaText);
  assert.deepEqual(Object.keys(models).sort(), ['Client', 'Invoice', 'InvoiceItem', 'Post']);
  const { rows } = await db.admin.query(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name <> '_prisma_migrations'`, [db.schema]
  );
  const actual = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  let checked = 0;
  for (const model of Object.values(models)) {
    for (const field of model.fields) {
      if (!PG_TYPES[field.type]) continue; // relation field, not a column
      const col = actual.get(`${model.name}.${field.name}`);
      assert.ok(col, `column ${model.name}.${field.name} is missing from the database`);
      assert.equal(col.data_type, PG_TYPES[field.type], `${model.name}.${field.name} type`);
      assert.equal(col.is_nullable === 'YES', field.optional, `${model.name}.${field.name} nullability`);
      checked++;
    }
  }
  // ...and the database has no extra columns
  const expectedCount = Object.values(models).flatMap((m) => m.fields.filter((f) => PG_TYPES[f.type])).length;
  assert.equal(actual.size, expectedCount, 'database has columns that schema.prisma does not declare');
  assert.ok(checked >= 25);
});

test('every @@index / @@unique in schema.prisma exists with the same columns, and no other indexes exist', async () => {
  const models = parseSchema(schemaText);
  const { rows } = await db.admin.query(
    `SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
            array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_index ix
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1
     GROUP BY t.relname, i.relname, ix.indisunique, ix.indisprimary`, [db.schema]
  );
  const byName = new Map(rows.map((r) => [r.index_name, r]));
  const expected = new Set();
  for (const model of Object.values(models)) {
    expected.add(`${model.name}_pkey`);
    for (const cols of model.indexes) {
      const name = `${model.name}_${cols.join('_')}_idx`;
      expected.add(name);
      const row = byName.get(name);
      assert.ok(row, `index ${name} is missing from the database`);
      assert.deepEqual(row.columns, cols, `index ${name} columns`);
      assert.equal(row.is_unique, false);
    }
    for (const cols of model.uniques) {
      const name = `${model.name}_${cols.join('_')}_key`;
      expected.add(name);
      const row = byName.get(name);
      assert.ok(row, `unique index ${name} is missing from the database`);
      assert.deepEqual(row.columns, cols);
      assert.equal(row.is_unique, true);
    }
  }
  const unexpected = [...byName.keys()].filter((n) => !expected.has(n) && n !== '_prisma_migrations_pkey');
  assert.deepEqual(unexpected, [], 'database has indexes that schema.prisma does not declare');
});

test('the Task 1 indexes from the assignment are all present on Invoice', async () => {
  const names = (await db.admin.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'Invoice'`, [db.schema])).rows.map((r) => r.indexname);
  for (const expected of ['Invoice_status_idx', 'Invoice_dueDate_idx', 'Invoice_status_createdAt_idx', 'Invoice_status_dueDate_idx', 'Invoice_clientId_status_idx']) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
});

test('foreign keys behave as in the schema (items cascade with their invoice, others restrict)', async () => {
  const { rows } = await db.admin.query(
    `SELECT conname, confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND contype = 'f'`, [db.schema]
  );
  const rule = Object.fromEntries(rows.map((r) => [r.conname, r.confdeltype]));
  assert.equal(rule.InvoiceItem_invoiceId_fkey, 'c'); // CASCADE
  assert.equal(rule.Invoice_clientId_fkey, 'r'); // RESTRICT
  assert.equal(rule.Post_authorId_fkey, 'r');
});

test('migration runner: idempotent, records Prisma-compatible history, detects edited migrations', async () => {
  const again = await applyMigrations(db.admin, { schema: db.schema });
  assert.deepEqual(again, [], 'second run applies nothing');
  const history = (await db.admin.query('SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY migration_name')).rows;
  const files = listMigrations();
  assert.deepEqual(history.map((h) => h.migration_name), files.map((f) => f.name));
  history.forEach((h, i) => { assert.equal(h.checksum, files[i].checksum); assert.ok(h.finished_at); assert.match(h.checksum, /^[0-9a-f]{64}$/); });
  await db.admin.query(`UPDATE "_prisma_migrations" SET checksum = repeat('0', 64) WHERE migration_name = $1`, [files[0].name]);
  await assert.rejects(() => applyMigrations(db.admin, { schema: db.schema }), /checksum mismatch/);
  await db.admin.query(`UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2`, [files[0].checksum, files[0].name]);
});
