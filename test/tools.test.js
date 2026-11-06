'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExplain, median } = require('../scripts/lib/explain');
const { speedup, renderReport } = require('../scripts/lib/report');
const { QUERIES } = require('../scripts/analyze');

test('parseExplain: sequential scan (parallel, with filter)', () => {
  const lines = [
    'Limit  (cost=6345.80..6348.10 rows=20 width=61) (actual time=15.703..19.067 rows=20 loops=1)',
    '  ->  Gather Merge  (cost=6345.80..12418.72 rows=52808 width=61) (actual time=15.700..19.061 rows=20 loops=1)',
    '        ->  Parallel Seq Scan on "Invoice"  (cost=0.00..3940.59 rows=52808 width=61) (actual time=0.008..10.562 rows=44868 loops=2)',
    "              Filter: (status = 'PAID'::text)",
    '              Rows Removed by Filter: 55132',
    'Planning Time: 0.105 ms',
    'Execution Time: 19.096 ms',
  ];
  const r = parseExplain(lines);
  assert.equal(r.scanType, 'Parallel Seq Scan');
  assert.equal(r.usesSeqScan, true);
  assert.equal(r.rowsExamined, 200000);
  assert.equal(r.executionTimeMs, 19.096);
  assert.equal(r.planningTimeMs, 0.105);
});

test('parseExplain: index scan and bitmap scan, index names reported without quotes', () => {
  const idx = parseExplain([
    'Limit  (cost=0.42..3.17 rows=20 width=61) (actual time=0.023..0.041 rows=20 loops=1)',
    '  ->  Index Scan Backward using "Invoice_status_createdAt_idx" on "Invoice"  (cost=0.42..12372.36 rows=89860 width=61) (actual time=0.022..0.039 rows=20 loops=1)',
    "        Index Cond: (status = 'PAID'::text)",
    'Execution Time: 0.053 ms',
  ]);
  assert.equal(idx.scanType, 'Index Scan Backward using Invoice_status_createdAt_idx');
  assert.equal(idx.rowsExamined, 20);
  assert.equal(idx.usesSeqScan, false);

  const bitmap = parseExplain([
    'Bitmap Heap Scan on "Invoice"  (cost=446.48..3614.38 rows=28325 width=61) (actual time=1.709..12.641 rows=1585 loops=1)',
    "  Recheck Cond: (status = 'SENT'::text)",
    '  Rows Removed by Filter: 38465',
    '  ->  Bitmap Index Scan on "Invoice_status_idx"  (cost=0.00..439.39 rows=39880 width=0) (actual time=1.347..1.347 rows=40050 loops=1)',
    'Execution Time: 12.757 ms',
  ]);
  assert.equal(bitmap.scanType, 'Bitmap Heap Scan (Bitmap Index Scan using Invoice_status_idx)');
  assert.equal(bitmap.rowsExamined, 40050);
  assert.deepEqual([bitmap.estimatedRows, bitmap.actualRows], [28325, 1585]);
});

test('median and speedup formatting', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(speedup(19, 0.06), '317x faster');
  assert.equal(speedup(23, 14), '1.6x faster');
  assert.equal(speedup(19, 37), '1.9x slower');
});

test('the three assignment queries are exactly as specified', () => {
  assert.equal(QUERIES.length, 3);
  assert.match(QUERIES[0].sql, /WHERE status = 'PAID'\s+ORDER BY "createdAt" DESC\s+LIMIT 20/);
  assert.match(QUERIES[1].sql, /"dueDate" < NOW\(\) AND status = 'SENT'/);
  assert.match(QUERIES[2].sql, /GROUP BY "clientId"\s+ORDER BY SUM\(total\) DESC\s+LIMIT 10/);
});

test('the committed query-analysis.md matches the committed results and shows measurable improvement', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const results = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'analysis', 'results.json'), 'utf8'));
  const md = fs.readFileSync(path.join(__dirname, '..', 'query-analysis.md'), 'utf8');
  assert.equal(md, renderReport(results), 'run `npm run report` to regenerate');
  for (const q of results.queries) assert.ok(q.after.executionTimeMs < q.before.executionTimeMs, `query ${q.id} improved`);
  assert.equal(results.queries[0].before.usesSeqScan, true);
  assert.equal(results.queries[0].after.usesSeqScan, false);
  for (const heading of ['## Query 1:', '## Query 2:', '## Query 3:', '### Before Index', '### After Index', '### Improvement']) assert.ok(md.includes(heading), heading);
});
