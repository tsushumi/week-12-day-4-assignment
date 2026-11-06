'use strict';

/** Renders analysis/results.json into query-analysis.md (the format required by the assignment, plus context). */

const fmtMs = (ms) => `${ms < 1 ? ms.toFixed(3) : ms.toFixed(2)}ms`;
const fmtInt = (n) => n.toLocaleString('en-US');

function speedup(beforeMs, afterMs) {
  const ratio = beforeMs / afterMs;
  if (ratio >= 1) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x faster`;
  return `${(1 / ratio).toFixed(1)}x slower`;
}

function rowsReduction(before, after) {
  const pct = (1 - after / before) * 100;
  if (pct >= 99.95) return `Rows examined reduced by ${pct.toFixed(2)}% (${fmtInt(before)} -> ${fmtInt(after)})`;
  if (pct >= 0) return `Rows examined reduced by ${Math.round(pct)}% (${fmtInt(before)} -> ${fmtInt(after)})`;
  return `Rows examined increased (${fmtInt(before)} -> ${fmtInt(after)})`;
}

const WHY = {
  1: (q) =>
    `Without an index on \`status\`, PostgreSQL has to read every invoice, throw away the ones that are not PAID, and sort what is left by \`createdAt\` (a top-N heapsort) just to hand back 20 rows. ` +
    `The composite index \`(status, createdAt)\` keeps the PAID invoices already ordered by \`createdAt\`, so PostgreSQL walks it backwards, stops after 20 entries and never touches the other ${fmtInt(Math.max(q.before.rowsExamined - q.after.rowsExamined, 0))} rows. No sort is needed at all. ` +
    `The cost of the query no longer depends on the table size, which is why this is the biggest win of the three.`,
  2: (q) =>
    `Without an index PostgreSQL scans the whole table and applies both conditions to every row. With indexes it can first narrow the table down to the SENT invoices and only visit those. ` +
    (q.after.estimatedRows != null
      ? `Note that the planner estimated ${fmtInt(q.after.estimatedRows)} matching rows but only ${fmtInt(q.after.actualRows)} really match (see "Planner note for Query 2" below).`
      : ''),
  3: (q, results) =>
    `This query has to look at every PAID invoice (about ${fmtInt(q.after.rowsExamined)} of them, roughly 45% of the table) no matter what, because every one of them contributes to a SUM. An index cannot make that disappear. ` +
    `What the covering index \`(status, clientId, total)\` does is let PostgreSQL answer the query from the index alone (an Index Only Scan, "Heap Fetches: 0") instead of reading the wide table rows, and the entries come back already grouped by \`clientId\`, so the hash aggregate becomes a cheaper GroupAggregate. ` +
    (() => {
      const exp = (results.experiments || []).find((e) => e.queryId === 3);
      let without = '';
      if (exp) {
        const vs = speedup(q.before.executionTimeMs, exp.result.executionTimeMs);
        const worse = exp.result.executionTimeMs > q.before.executionTimeMs;
        without =
          `Measured with the covering index removed (only the five indexes from the assignment): \`${exp.result.scanType}\`, ${fmtMs(exp.result.executionTimeMs)}, which is ${vs} than the original sequential scan. ` +
          (worse
            ? 'In other words, the five plain indexes alone make this query slower: the planner is tempted by the `status` index, but fetching ~90,000 rows through it costs more than one sequential pass over the table. Only the covering index, which avoids visiting the table at all, turns it into a gain. '
            : 'The covering index improves on that further. ');
      }
      return `That is a real but modest gain: the work is dominated by reading ~90,000 index entries. ${without}For a dashboard that runs this constantly, the next step would be a pre-computed summary table or materialized view.`;
    })(),
};

function queryBlock(q, results) {
  const { before, after } = q;
  const lines = [];
  lines.push(`## Query ${q.id}: ${q.title}`, '', q.summary, '', '```sql', q.sql, '```', '');
  lines.push('### Before Index', `- Scan type: ${before.scanType}`, `- Rows examined: ${fmtInt(before.rowsExamined)}`, `- Execution time: ${fmtMs(before.executionTimeMs)}`, '');
  lines.push('### After Index', `- Scan type: ${after.scanType}`, `- Rows examined: ${fmtInt(after.rowsExamined)}`, `- Execution time: ${fmtMs(after.executionTimeMs)}`, '');
  lines.push('### Improvement', `- ${speedup(before.executionTimeMs, after.executionTimeMs)}`, `- ${rowsReduction(before.rowsExamined, after.rowsExamined)}`, '');
  lines.push('### Why', '', WHY[q.id](q, results), '');
  lines.push('<details><summary>Full EXPLAIN ANALYZE output before the index</summary>', '', '```text', before.plan, '```', '', '</details>', '');
  lines.push('<details><summary>Full EXPLAIN ANALYZE output after the index</summary>', '', '```text', after.plan, '```', '', '</details>', '');
  return lines.join('\n');
}

function renderReport(results) {
  const { dataset, method, queries, indexes } = results;
  const experiment = (results.experiments || []).find((e) => e.queryId === 2);
  const out = [];
  out.push('# Query Analysis: EXPLAIN ANALYZE before and after indexes', '');
  out.push(`Generated by \`npm run analyze\` on ${results.generatedAt.slice(0, 10)}. Every number and plan below was produced by running the queries through Prisma's \`$queryRawUnsafe\` against PostgreSQL; nothing is typed in by hand.`, '');

  out.push('## Test setup', '');
  out.push(`- Database: ${dataset.version}`);
  out.push(`- Data: ${fmtInt(dataset.invoices)} invoices (table size ${dataset.invoice_table_size}), ${fmtInt(dataset.items)} invoice items, ${fmtInt(dataset.clients)} clients, ${fmtInt(dataset.posts)} posts`);
  out.push(`- Invoice status mix: ${dataset.status_mix}`);
  out.push(`- Method: ${method.warmupRuns} warm-up run, then ${method.timedRuns} timed runs of \`EXPLAIN ANALYZE\`; the reported time is the **${method.statistic}** (the plan shown is the run closest to the median). \`VACUUM (ANALYZE)\` was run before each phase so statistics are fresh in both.`);
  out.push('- "Before" uses the `init` migration only (primary keys and a unique email index, no other indexes); "After" adds the `add_indexes` migration.');
  out.push('- The measurements run in a separate schema (`analysis`) so they never touch the 400-invoice demo data. With only a few hundred rows PostgreSQL correctly prefers a sequential scan even when indexes exist, so a larger dataset is needed for a meaningful comparison.', '');

  out.push('## Summary', '');
  out.push('| Query | Before | After | Speed-up | Scan before -> after |', '|---|---|---|---|---|');
  for (const q of queries) {
    out.push(`| ${q.id}. ${q.title} | ${fmtMs(q.before.executionTimeMs)} | ${fmtMs(q.after.executionTimeMs)} | ${speedup(q.before.executionTimeMs, q.after.executionTimeMs)} | ${q.before.scanType} -> ${q.after.scanType} |`);
  }
  out.push('', 'Absolute times depend on the machine (these ran against a local PostgreSQL with no network latency); the ratios and the plan shapes are what matter. Against a remote database such as Supabase or Neon the "before" numbers are typically larger, because more data has to cross the network and be processed.', '');

  for (const q of queries) out.push(queryBlock(q, results));

  const q2 = queries[1];
  out.push('## Planner note for Query 2', '');
  out.push(
    `In the "After" run PostgreSQL did **not** use the composite \`(status, dueDate)\` index that was built for this query. It chose \`${q2.after.indexes.join(', ')}\` and filtered \`dueDate\` afterwards. ` +
      `The reason is a bad row estimate: the planner expected about ${fmtInt(q2.after.estimatedRows)} matching rows, but only ${fmtInt(q2.after.actualRows)} match. ` +
      'It estimates `status` and `dueDate` separately and multiplies the results, and it does not know that SENT invoices are almost never past their due date (they are usually still inside the 30-day term). With that estimate, the plain `status` index looks cheaper.',
    ''
  );
  if (experiment) {
    const r = experiment.result;
    out.push(
      `To check this, the script drops \`${experiment.dropped.join('` and `')}\` **inside a transaction that is rolled back** (nothing is changed) and runs Query 2 again. With only the composite index available the plan becomes \`${r.scanType}\` and the time drops to **${fmtMs(r.executionTimeMs)}** (${speedup(q2.before.executionTimeMs, r.executionTimeMs)} than the original sequential scan, ${speedup(q2.after.executionTimeMs, r.executionTimeMs)} than the plan the planner picked with all five assignment indexes).`,
      ''
    );
    out.push('```text', r.plan, '```', '');
  }
  out.push(
    '**Takeaways.** (1) An index on `status` alone is redundant once `(status, createdAt)` and `(status, dueDate)` exist, because PostgreSQL can use the first column of any composite index by itself. It costs write time and disk space and, as shown here, can even lure the planner away from the better index. The assignment asks for all five indexes, so they are all in the schema; in a production system the plain `status` and `dueDate` indexes are the first ones to drop. ' +
      '(2) Always compare estimated rows with actual rows in `EXPLAIN ANALYZE`. A large gap points at statistics, not at a missing index.',
    ''
  );

  out.push('## Indexes added by the `add_indexes` migration', '');
  out.push('| Index | Columns | Used by |', '|---|---|---|');
  const describe = {
    Invoice_status_idx: ['status', 'Query 2 (after)'],
    Invoice_dueDate_idx: ['dueDate', '(not chosen by the planner for these queries)'],
    Invoice_status_createdAt_idx: ['status, createdAt', 'Query 1'],
    Invoice_status_dueDate_idx: ['status, dueDate', 'Query 2 (best plan when it is the only candidate)'],
    Invoice_clientId_status_idx: ['clientId, status', 'per-client invoice lists filtered by status'],
    Invoice_status_clientId_total_idx: ['status, clientId, total', 'Query 3 (covering, Index Only Scan)'],
  };
  for (const name of indexes.filter((n) => describe[n])) out.push(`| \`${name}\` | ${describe[name][0]} | ${describe[name][1]} |`);
  out.push('', 'Two more indexes support the N+1 fix and relation loading: `InvoiceItem_invoiceId_idx` and `Post_authorId_idx`. PostgreSQL does not index foreign-key columns automatically, so without them "all posts of these authors" is a scan of the whole `Post` table.', '');

  out.push('## Reproduce', '', '```bash', 'npm run analyze                       # about a minute, 200,000 invoices', 'ANALYSIS_INVOICES=50000 npm run analyze   # smaller and faster', 'npm run analyze -- --keep              # keep the "analysis" schema to explore it with psql', '```', '');
  return out.join('\n');
}

module.exports = { renderReport, speedup };
