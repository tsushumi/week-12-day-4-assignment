'use strict';

/**
 * Parses the text output of PostgreSQL's EXPLAIN ANALYZE into the few numbers we report.
 * `lines` is the list of plan lines (one per row of the "QUERY PLAN" column).
 */

const SCAN_RE = /^\s*(?:->\s+)?((?:Parallel )?(?:Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan)(?: Backward)?)(?: using (?:"([^"]+)"|(\S+)))? on (?:"([^"]+)"|(\S+))/;
const BITMAP_INDEX_RE = /^\s*(?:->\s+)?Bitmap Index Scan on (?:"([^"]+)"|(\S+))/;
const ACTUAL_RE = /\(actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+) loops=(\d+)\)/;
const REMOVED_RE = /^\s*Rows Removed by (Filter|Index Recheck): (\d+)/;

function parseExplain(lines, { table = 'Invoice' } = {}) {
  const text = lines.join('\n');
  const execution = /Execution Time: ([\d.]+) ms/.exec(text);
  const planning = /Planning Time: ([\d.]+) ms/.exec(text);

  const scans = [];
  const bitmapIndexes = [];
  let current = null;

  for (const line of lines) {
    const scan = SCAN_RE.exec(line);
    if (scan) {
      const relation = scan[4] || scan[5];
      current = null;
      if (relation === table) {
        const actual = ACTUAL_RE.exec(line);
        current = {
          type: scan[1],
          index: scan[2] || scan[3] || null,
          neverExecuted: /\(never executed\)/.test(line),
          rows: actual ? Number(actual[1]) : 0,
          loops: actual ? Number(actual[2]) : 0,
          removed: 0,
        };
        scans.push(current);
      }
      continue;
    }
    const bitmap = BITMAP_INDEX_RE.exec(line);
    if (bitmap) {
      bitmapIndexes.push(bitmap[1] || bitmap[2]);
      continue;
    }
    const removed = REMOVED_RE.exec(line);
    if (removed && current) current.removed += Number(removed[2]);
  }

  // Rows examined = rows the scan node read from the table (kept + discarded by its filter), summed over loops
  const rowsExamined = scans.reduce((sum, s) => sum + (s.rows + s.removed) * Math.max(s.loops, 1), 0);

  // Root node: the planner's row estimate vs the real number of rows (a big gap explains surprising plan choices)
  const root = /\(cost=[\d.]+\.\.[\d.]+ rows=(\d+) [^)]*\) \(actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+)/.exec(lines[0] || '');

  const primary = scans[0];
  let scanType = 'Unknown';
  if (primary) {
    const usedIndex = primary.index || bitmapIndexes[0];
    scanType = primary.type;
    if (primary.index) scanType += ` using ${primary.index}`;
    else if (usedIndex) scanType += ` (Bitmap Index Scan using ${[...new Set(bitmapIndexes)].join(', ')})`;
  }

  return {
    scanType,
    usesSeqScan: scans.some((s) => /Seq Scan/.test(s.type)),
    indexes: [...new Set([...scans.map((s) => s.index).filter(Boolean), ...bitmapIndexes])],
    rowsExamined,
    estimatedRows: root ? Number(root[1]) : null,
    actualRows: root ? Number(root[2]) : null,
    executionTimeMs: execution ? Number(execution[1]) : null,
    planningTimeMs: planning ? Number(planning[1]) : null,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

module.exports = { parseExplain, median };
