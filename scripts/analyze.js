'use strict';

/**
 * Task 1: runs the three slow queries with EXPLAIN ANALYZE BEFORE and AFTER the index migration and writes
 * analysis/results.json and query-analysis.md.
 *
 *   npm run analyze                    (200,000 invoices, takes about a minute)
 *   ANALYSIS_INVOICES=50000 npm run analyze
 *   npm run analyze -- --keep          keep the "analysis" schema afterwards so you can poke at it with psql
 *
 * Everything happens in a separate PostgreSQL schema called "analysis" inside your database, so your real
 * tables and data are never touched. Why not use the 400-row seed? With only a few hundred rows PostgreSQL
 * (correctly) prefers a sequential scan even when an index exists, so there is nothing to measure.
 */

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createPrismaClient } = require('../src/lib/prisma');
const { parsePoolConfig } = require('../src/lib/poolConfig');
const { applyMigrations, quoteIdent } = require('./lib/migrations');
const { loadAnalysisData } = require('./lib/analysisData');
const { parseExplain, median } = require('./lib/explain');
const { renderReport } = require('./lib/report');

const SCHEMA = 'analysis';
const RUNS = 5;

// The three queries exactly as given in the assignment
const QUERIES = [
  {
    id: 1,
    title: 'Filter by Status',
    summary: 'Latest 20 paid invoices (no index on status)',
    sql: `SELECT * FROM "Invoice"
WHERE status = 'PAID'
ORDER BY "createdAt" DESC
LIMIT 20`,
  },
  {
    id: 2,
    title: 'Overdue Invoices (dueDate + status)',
    summary: 'SENT invoices that are past their due date',
    sql: `SELECT * FROM "Invoice"
WHERE "dueDate" < NOW() AND status = 'SENT'`,
  },
  {
    id: 3,
    title: 'Aggregation per Client',
    summary: 'Top 10 clients by total paid',
    sql: `SELECT "clientId", COUNT(*), SUM(total)
FROM "Invoice"
WHERE status = 'PAID'
GROUP BY "clientId"
ORDER BY SUM(total) DESC
LIMIT 10`,
  },
];

// Runs EXPLAIN ANALYZE through Prisma. Raw queries ignore the client's schema, so search_path is set on the
// same connection (a transaction pins one connection).
async function explain(prisma, sql) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${quoteIdent(SCHEMA)}`);
    const rows = await tx.$queryRawUnsafe(`EXPLAIN ANALYZE ${sql}`);
    return rows.map((row) => row['QUERY PLAN']);
  });
}

async function measure(prisma, query, run = explain) {
  await run(prisma, query.sql); // warm-up: loads the pages into cache so every timed run starts equal
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const lines = await run(prisma, query.sql);
    samples.push({ lines, ...parseExplain(lines) });
  }
  const medianTime = median(samples.map((s) => s.executionTimeMs));
  // Keep the plan of the run closest to the median, so the printed plan matches the reported time
  const representative = samples.reduce((best, s) => (Math.abs(s.executionTimeMs - medianTime) < Math.abs(best.executionTimeMs - medianTime) ? s : best));
  return {
    id: query.id,
    scanType: representative.scanType,
    usesSeqScan: representative.usesSeqScan,
    indexes: representative.indexes,
    rowsExamined: representative.rowsExamined,
    estimatedRows: representative.estimatedRows,
    actualRows: representative.actualRows,
    executionTimeMs: Number(medianTime.toFixed(3)),
    allTimesMs: samples.map((s) => s.executionTimeMs),
    plan: representative.lines.join('\n'),
  };
}

async function main() {
  const keep = process.argv.includes('--keep');
  const invoices = Number.parseInt(process.env.ANALYSIS_INVOICES, 10) || 200000;
  const clients = Math.max(100, Math.round(invoices / 200));
  const posts = Math.round(invoices / 40);
  const log = (line) => console.log(line);

  const { connectionString } = parsePoolConfig(process.env.DATABASE_URL);
  const admin = new Client({ connectionString });
  await admin.connect();
  const { prisma, pool } = createPrismaClient({ schema: SCHEMA, env: { ...process.env, LOG_QUERIES: 'false', SLOW_QUERY_MS: '100000' } });

  try {
    log(`1/6 Creating schema "${SCHEMA}" and applying the init migration (no indexes besides primary/unique keys)`);
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await applyMigrations(admin, { schema: SCHEMA, only: 'init', log });

    log(`2/6 Loading ${invoices.toLocaleString()} invoices, ${clients.toLocaleString()} clients, ${posts.toLocaleString()} posts`);
    await loadAnalysisData(admin, { clients, invoices, posts });
    await admin.query('VACUUM (ANALYZE)'); // fresh statistics + visibility map, same in both phases

    const sizes = (await admin.query(
      `SELECT (SELECT count(*) FROM "Client")::int AS clients, (SELECT count(*) FROM "Invoice")::int AS invoices,
              (SELECT count(*) FROM "InvoiceItem")::int AS items, (SELECT count(*) FROM "Post")::int AS posts,
              pg_size_pretty(pg_table_size('"Invoice"')) AS invoice_table_size,
              (SELECT string_agg(status || '=' || n, ', ' ORDER BY status) FROM (SELECT status, count(*) AS n FROM "Invoice" GROUP BY status) s) AS status_mix,
              version() AS version`
    )).rows[0];

    log('3/6 BEFORE: running the three queries without indexes');
    const before = [];
    for (const query of QUERIES) {
      before.push(await measure(prisma, query));
      log(`    Query ${query.id}: ${before.at(-1).scanType}, ${before.at(-1).executionTimeMs} ms`);
    }

    log('4/6 Applying the add_indexes migration');
    await applyMigrations(admin, { schema: SCHEMA, only: 'add_indexes', log });
    await admin.query('VACUUM (ANALYZE)');
    const indexes = (await admin.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'Invoice' ORDER BY indexname`, [SCHEMA]
    )).rows;

    log('5/6 AFTER: running the three queries with indexes');
    const after = [];
    for (const query of QUERIES) {
      after.push(await measure(prisma, query));
      log(`    Query ${query.id}: ${after.at(-1).scanType}, ${after.at(-1).executionTimeMs} ms`);
    }

    // Experiments (each rolled back, nothing is changed; DDL is transactional in PostgreSQL):
    //  - Query 2 with only the composite (status, dueDate) index, i.e. without the plain indexes competing with it
    //  - Query 3 with only the five indexes listed in the assignment, i.e. without our extra covering index
    const experimentSpecs = [
      { queryId: 2, dropped: ['Invoice_status_idx', 'Invoice_dueDate_idx'] },
      { queryId: 3, dropped: ['Invoice_status_clientId_total_idx'] },
    ];
    const experiments = [];
    for (const spec of experimentSpecs) {
      log(`    Experiment: Query ${spec.queryId} without ${spec.dropped.join(', ')} (rolled back afterwards)`);
      try {
        await admin.query('BEGIN');
        for (const name of spec.dropped) await admin.query(`DROP INDEX ${quoteIdent(name)}`);
        const runOnAdmin = async (_unused, sql) => (await admin.query(`EXPLAIN ANALYZE ${sql}`)).rows.map((row) => row['QUERY PLAN']);
        const result = await measure(null, QUERIES[spec.queryId - 1], runOnAdmin);
        experiments.push({ ...spec, result });
        log(`    -> ${result.scanType}, ${result.executionTimeMs} ms`);
      } finally {
        await admin.query('ROLLBACK');
      }
    }

    const results = {
      generatedAt: new Date().toISOString(),
      method: { warmupRuns: 1, timedRuns: RUNS, statistic: 'median Execution Time' },
      dataset: { ...sizes, version: sizes.version.split(' on ')[0] },
      indexes: indexes.map((i) => i.indexname),
      queries: QUERIES.map((q, i) => ({ ...q, before: before[i], after: after[i] })),
      experiments,
    };
    fs.mkdirSync(path.join(__dirname, '..', 'analysis'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'analysis', 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    fs.writeFileSync(path.join(__dirname, '..', 'query-analysis.md'), renderReport(results));
    log('6/6 Wrote analysis/results.json and query-analysis.md');
  } finally {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
    if (!keep) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`).catch(() => {});
    await admin.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { QUERIES };
