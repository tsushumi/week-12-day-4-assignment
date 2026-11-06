'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, startApp } = require('./helpers');

let db;
let app;
test.before(async () => {
  db = await createTestDb();
  app = await startApp(db);
});
test.after(async () => {
  await app.close();
  await db.close();
});

test('seed meets the assignment minimums, per tenant and in total', async () => {
  assert.ok(db.counts.clients >= 50 && db.counts.invoices >= 200 && db.counts.posts >= 300);
  for (const tenantId of [1, 2]) {
    assert.equal(await db.prisma.client.count({ where: { tenantId } }), 50);
    assert.equal(await db.prisma.invoice.count({ where: { tenantId } }), 200);
    assert.equal(await db.prisma.post.count({ where: { tenantId } }), 300);
  }
  assert.ok(db.counts.invoiceItems >= db.counts.invoices * 2, 'every invoice has line items');
});

test('seed data is consistent: totals match items, relations stay inside one tenant', async () => {
  const invoices = await db.prisma.invoice.findMany({ include: { items: true, client: true } });
  for (const inv of invoices) {
    assert.ok(inv.items.length >= 2);
    const sum = Math.round(inv.items.reduce((s, i) => s + i.total, 0) * 100) / 100;
    assert.equal(inv.total, sum, `invoice ${inv.id} total`);
    assert.equal(inv.client.tenantId, inv.tenantId, `invoice ${inv.id} client tenant`);
  }
  const posts = await db.prisma.post.findMany({ include: { author: true } });
  assert.ok(posts.every((p) => p.author.tenantId === p.tenantId));
  assert.deepEqual([...new Set(invoices.map((i) => i.status))].sort(), ['DRAFT', 'OVERDUE', 'PAID', 'SENT']);
});

test('Task 2: users-bad runs 21 queries, users-good runs 1, and both return the same data', async () => {
  const bad = await app.request('GET', '/api/users-bad');
  const good = await app.request('GET', '/api/users-good');
  assert.equal(bad.status, 200);
  assert.equal(bad.json.queryCount, 21);
  assert.equal(bad.json.userCount, 20);
  assert.equal(typeof bad.json.responseTimeMs, 'number');
  assert.equal(good.json.queryCount, 1);
  assert.equal(good.json.userCount, 20);
  assert.deepEqual(good.json.data.map((u) => u.id), bad.json.data.map((u) => u.id));
  assert.deepEqual(good.json.data.map((u) => u._count.posts), bad.json.data.map((u) => u.postCount));
  assert.deepEqual(good.json.data.map((u) => u.posts.length), bad.json.data.map((u) => u.posts.length));
});

test('Task 2: users-comparison has the documented shape', async () => {
  const res = await app.request('GET', '/api/users-comparison?runs=3');
  assert.equal(res.status, 200);
  const { bad, good, improvement } = res.json;
  assert.deepEqual([bad.queryCount, good.queryCount, bad.userCount, good.userCount], [21, 1, 20, 20]);
  assert.equal(improvement.queriesReduced, '21 -> 1 (95% reduction)');
  assert.match(improvement.speedup, /^\d+(\.\d)?x (faster|slower)$/);
  assert.equal((await app.request('GET', '/api/users-comparison?runs=0')).status, 400);
});

test('Task 2: query counts stay correct for concurrent requests (per-request counters)', async () => {
  const calls = Array.from({ length: 6 }, (_, i) => app.request('GET', i % 2 ? '/api/users-good' : '/api/users-bad'));
  const results = await Promise.all(calls);
  results.forEach((r, i) => assert.equal(r.json.queryCount, i % 2 ? 1 : 21));
});

test('users-* endpoints are scoped when X-Tenant-Id is sent', async () => {
  for (const tenantId of [1, 2]) {
    for (const path of ['/api/users-bad', '/api/users-good']) {
      const res = await app.as(tenantId)('GET', path);
      assert.equal(res.json.queryCount, path.endsWith('bad') ? 21 : 1);
      assert.ok(res.json.data.every((u) => u.tenantId === tenantId));
      assert.ok(res.json.data.every((u) => u.posts.every((p) => p.tenantId === tenantId)));
    }
  }
  assert.equal((await app.as('abc')('GET', '/api/users-good')).status, 400);
});

test('/api/v1 pagination, filters and sorting', async () => {
  const t1 = app.as(1);
  const page = await t1('GET', '/api/v1/invoices?page=2&limit=15');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.meta, { page: 2, limit: 15, total: 200, totalPages: 14 });
  assert.equal(page.json.data.length, 15);
  const paid = await t1('GET', '/api/v1/invoices?status=paid&limit=100');
  assert.ok(paid.json.data.length > 0 && paid.json.data.every((i) => i.status === 'PAID'));
  const sorted = (await t1('GET', '/api/v1/invoices?sort=-total&limit=100')).json.data.map((i) => i.total);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
  for (const q of ['page=0', 'limit=101', 'limit=abc', 'status=NOPE', 'sort=password', 'clientId=x']) {
    const res = await t1('GET', `/api/v1/invoices?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  }
});

test('/api/v1 invoice detail, creation and validation', async () => {
  const t1 = app.as(1);
  const one = await t1('GET', '/api/v1/invoices/1');
  assert.equal(one.json.data.id, 1);
  assert.ok(one.json.data.items.length >= 2 && one.json.data.client.id);
  assert.equal((await t1('GET', '/api/v1/invoices/999999')).status, 404);
  assert.equal((await t1('GET', '/api/v1/invoices/abc')).status, 400);

  const clientId = (await db.prisma.client.findFirst({ where: { tenantId: 1 } })).id;
  const created = await t1('POST', '/api/v1/invoices', { body: { clientId, dueDate: '2027-01-31', items: [{ description: 'Test', quantity: 3, unitPrice: 0.1 }] } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.data.total, 0.3);
  assert.equal(created.json.data.tenantId, 1);
  assert.equal(created.json.data.invoiceNumber, 'INV-T1-0201');
  assert.equal(created.headers.get('location'), `/api/v1/invoices/${created.json.data.id}`);

  const bad = await t1('POST', '/api/v1/invoices', { body: { clientId: 'x', dueDate: '31/01/2027', items: [] } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.error.details.map((d) => d.field).sort(), ['clientId', 'dueDate', 'items']);
  assert.equal((await t1('POST', '/api/v1/invoices', { raw: '{oops', headers: { 'Content-Type': 'application/json' } })).json.error.code, 'INVALID_JSON');
});

test('clients, posts and stats endpoints', async () => {
  const t1 = app.as(1);
  const clients = await t1('GET', '/api/v1/clients?limit=10&q=Company');
  assert.equal(clients.status, 200);
  const all = await t1('GET', '/api/v1/clients?limit=100');
  assert.equal(all.json.meta.total, 50);
  const first = await t1('GET', `/api/v1/clients/${all.json.data[0].id}`);
  assert.ok(first.json.data._count);
  const posts = await t1('GET', `/api/v1/posts?authorId=${all.json.data[0].id}`);
  assert.ok(posts.json.data.every((p) => p.authorId === all.json.data[0].id));
  const stats = await t1('GET', '/api/v1/stats');
  assert.equal(stats.json.data.clients, 50);
  assert.equal(stats.json.data.posts, 300);
  assert.ok(stats.json.data.invoiceCount >= 200);
});

test('404 for unknown routes; 500 details are hidden in production but shown in development', async () => {
  assert.equal((await app.request('GET', '/nope')).json.error.code, 'NOT_FOUND');
  const broken = { ...db, prisma: { invoice: { count: async () => { throw new Error('secret db detail'); }, findMany: async () => [] } } };
  const prod = await startApp(broken, { isProduction: true });
  const dev = await startApp(broken, { isProduction: false });
  try {
    const p = await prod.as(1)('GET', '/api/v1/invoices');
    assert.equal(p.status, 500);
    assert.ok(!p.text.includes('secret db detail'));
    assert.equal(p.json.error.code, 'INTERNAL_ERROR');
    assert.ok(prod.logs.error.some((l) => l.includes('/api/v1/invoices')));
    assert.match((await dev.as(1)('GET', '/api/v1/invoices')).json.error.message, /secret db detail/);
  } finally {
    await prod.close();
    await dev.close();
  }
});
