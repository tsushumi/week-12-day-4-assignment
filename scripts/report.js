'use strict';

// Regenerates query-analysis.md from analysis/results.json without re-running the measurements.
const fs = require('node:fs');
const path = require('node:path');
const { renderReport } = require('./lib/report');

const results = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'analysis', 'results.json'), 'utf8'));
fs.writeFileSync(path.join(__dirname, '..', 'query-analysis.md'), renderReport(results));
console.log('Wrote query-analysis.md');
