'use strict';

const express = require('express');
const { countQueries } = require('../lib/queryCounter');
const { getUsersWithPosts, getUsersWithPostsOptimized } = require('../services/users');
const { intParam } = require('../lib/pagination');
const { optionalTenant } = require('../middleware/tenant');

const round1 = (n) => Math.round(n * 10) / 10;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function createUsersRouter({ prisma, logger = console }) {
  const router = express.Router();
  router.use(optionalTenant);

  // GET /api/users-bad  (N+1: 21 queries)
  router.get('/users-bad', async (req, res) => {
    const { result, queryCount, ms } = await countQueries(() => getUsersWithPosts(prisma, { tenantId: req.tenantId }));
    logger.log(`[users-bad] ${queryCount} queries in ${ms.toFixed(1)}ms for ${result.length} users`);
    res.json({ queryCount, responseTimeMs: round1(ms), userCount: result.length, data: result });
  });

  // GET /api/users-good  (single query)
  router.get('/users-good', async (req, res) => {
    const { result, queryCount, ms } = await countQueries(() => getUsersWithPostsOptimized(prisma, { tenantId: req.tenantId }));
    logger.log(`[users-good] ${queryCount} queries in ${ms.toFixed(1)}ms for ${result.length} users`);
    res.json({ queryCount, responseTimeMs: round1(ms), userCount: result.length, data: result });
  });

  // GET /api/users-comparison[?runs=5]  runs both versions and compares them
  router.get('/users-comparison', async (req, res) => {
    const runs = intParam(req.query, 'runs', { min: 1, max: 20, fallback: 5 });
    const tenantId = req.tenantId;

    // Warm-up: opens the pool's connections and primes caches, so the first timed run is not unfairly slow
    await getUsersWithPosts(prisma, { tenantId });
    await getUsersWithPostsOptimized(prisma, { tenantId });

    // Run the two versions alternately so neither one always benefits from the other's warm cache
    const measure = { bad: [], good: [] };
    let bad;
    let good;
    for (let i = 0; i < runs; i++) {
      bad = await countQueries(() => getUsersWithPosts(prisma, { tenantId }));
      good = await countQueries(() => getUsersWithPostsOptimized(prisma, { tenantId }));
      measure.bad.push(bad.ms);
      measure.good.push(good.ms);
    }

    const badMs = median(measure.bad);
    const goodMs = median(measure.good);
    const reduction = bad.queryCount === 0 ? 0 : Math.round((1 - good.queryCount / bad.queryCount) * 100);
    const ratio = goodMs > 0 ? badMs / goodMs : Infinity;
    const speedup = ratio >= 1 ? `${round1(ratio)}x faster` : `${round1(1 / ratio)}x slower`;

    logger.log(`[users-comparison] bad ${bad.queryCount} queries / ${badMs.toFixed(1)}ms, good ${good.queryCount} queries / ${goodMs.toFixed(1)}ms (${speedup})`);
    res.json({
      runs,
      bad: { queryCount: bad.queryCount, responseTimeMs: round1(badMs), userCount: bad.result.length },
      good: { queryCount: good.queryCount, responseTimeMs: round1(goodMs), userCount: good.result.length },
      improvement: {
        queriesReduced: `${bad.queryCount} -> ${good.queryCount} (${reduction}% reduction)`,
        speedup,
      },
    });
  });

  return router;
}

module.exports = { createUsersRouter };
