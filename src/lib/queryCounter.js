'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Counts the SQL statements Prisma runs inside one async call chain.
 *
 * A single global counter would mix up concurrent requests; AsyncLocalStorage gives every
 * countQueries() call its own counter, so two simultaneous requests are measured independently.
 * prisma.js calls recordQuery() from its `query` event handler.
 */
const storage = new AsyncLocalStorage();

function recordQuery() {
  const counter = storage.getStore();
  if (counter) counter.count += 1;
}

async function countQueries(fn) {
  const counter = { count: 0 };
  const start = process.hrtime.bigint();
  // Prisma promises are lazy: the query only starts when the promise is awaited. The await therefore has
  // to happen INSIDE storage.run(), otherwise the query runs outside this counter's async context.
  const result = await storage.run(counter, async () => await fn());
  return { result, queryCount: counter.count, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

module.exports = { recordQuery, countQueries };
