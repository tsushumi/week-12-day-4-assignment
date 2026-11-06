'use strict';

/** Bonus: multi-tenant data isolation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, startApp } = require('./helpers');

let db;
let app;
let t1;
let t2;
test.before(async () => {
  db = await createTestDb();
  app = await startApp(db);
  t1 = app.as(1);
  t2 = app.as(2);
});
test.after(async () => {
  await app.close();
  await db.close();
});

test('X-Tenant-Id is required and strictly validated', async () => {
  const missing = await app.request('GET', '/api/v1/invoices');
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json, { error: { code: 'TENANT_REQUIRED', message: 'X-Tenant-Id header is required' } });
  for (const bad of ['abc', '0', '-1', '1abc', '1.5', ' ', '99999999999']) {
    const res = await app.request('GET', '/api/v1/invoices', { headers: { 'X-Tenant-Id': bad } });
    assert.equal(res.status, 400, `"${bad}"`);
    assert.ok(['INVALID_TENANT', 'TENANT_REQUIRED'].includes(res.json.error.code));
  }
  assert.equal((await app.request('GET', '/health')).status, 200, '/health needs no tenant');
});

test('tenant 1 and tenant 2 see completely different invoices', async () => {
  const a = (await t1('GET', '/api/v1/invoices?limit=100')).json;
  const b = (await t2('GET', '/api/v1/invoices?limit=100')).json;
  assert.equal(a.meta.total, 200);
  assert.equal(b.meta.total, 200);
  assert.ok(a.data.every((i) => i.tenantId === 1 && i.invoiceNumber.startsWith('INV-T1-')));
  assert.ok(b.data.every((i) => i.tenantId === 2 && i.invoiceNumber.startsWith('INV-T2-')));
  const idsA = new Set(a.data.map((i) => i.id));
  assert.ok(b.data.every((i) => !idsA.has(i.id)), 'no invoice id appears in both tenants');
});

test('every list endpoint is scoped (invoices, clients, posts, stats)', async () => {
  for (const [tenantId, call] of [[1, t1], [2, t2]]) {
    for (const path of ['/api/v1/invoices', '/api/v1/clients', '/api/v1/posts']) {
      const res = await call('GET', `${path}?limit=100`);
      assert.ok(res.json.data.length > 0);
      assert.ok(res.json.data.every((row) => row.tenantId === tenantId), `${path} leaked rows for tenant ${tenantId}`);
    }
    assert.equal((await call('GET', '/api/v1/stats')).json.tenantId, tenantId);
  }
  const s1 = (await t1('GET', '/api/v1/stats')).json.data;
  const s2 = (await t2('GET', '/api/v1/stats')).json.data;
  assert.notDeepEqual(s1.invoicesByStatus, s2.invoicesByStatus, 'different tenants have different data');
});

test("another tenant's records are 404, not 403 (existence is not revealed)", async () => {
  const t2Invoice = (await t2('GET', '/api/v1/invoices?limit=1')).json.data[0];
  const t2Client = (await t2('GET', '/api/v1/clients?limit=1')).json.data[0];
  assert.equal((await t2(`GET`, `/api/v1/invoices/${t2Invoice.id}`)).status, 200);
  assert.equal((await t1('GET', `/api/v1/invoices/${t2Invoice.id}`)).status, 404);
  assert.equal((await t1('GET', `/api/v1/clients/${t2Client.id}`)).status, 404);
  // filtering by another tenant's client id yields nothing, never that client's data
  const leak = await t1('GET', `/api/v1/invoices?clientId=${t2Client.id}`);
  assert.equal(leak.json.meta.total, 0);
  assert.equal((await t1('GET', `/api/v1/posts?authorId=${t2Client.id}`)).json.meta.total, 0);
});

test('search cannot cross tenants', async () => {
  const tenant2Company = (await t2('GET', '/api/v1/clients?limit=1')).json.data[0].company;
  const own = await t2('GET', `/api/v1/clients?q=${encodeURIComponent(tenant2Company)}`);
  assert.ok(own.json.meta.total >= 1);
  const other = await t1('GET', `/api/v1/clients?q=${encodeURIComponent(tenant2Company)}`);
  assert.ok(other.json.data.every((c) => c.tenantId === 1));
});

test('writes are scoped: invoices go into the caller\'s tenant and cannot reference another tenant\'s client', async () => {
  const t1Client = (await t1('GET', '/api/v1/clients?limit=1')).json.data[0];
  const body = { clientId: t1Client.id, dueDate: '2027-03-01', items: [{ description: 'Scoped', quantity: 1, unitPrice: 100 }] };
  const crossTenant = await t2('POST', '/api/v1/invoices', { body });
  assert.equal(crossTenant.status, 400);
  assert.equal(crossTenant.json.error.details[0].field, 'clientId');
  const ok = await t1('POST', '/api/v1/invoices', { body });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.tenantId, 1);
  assert.equal((await t2('GET', `/api/v1/invoices/${ok.json.data.id}`)).status, 404);
  assert.equal((await t1('GET', '/api/v1/invoices')).json.meta.total, 201);
  assert.equal((await t2('GET', '/api/v1/invoices')).json.meta.total, 200);
});

test('an unknown tenant simply has no data', async () => {
  const res = await app.as(3)('GET', '/api/v1/invoices');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.data, []);
  assert.equal(res.json.meta.total, 0);
});

test('the same client email may exist in two tenants (unique per tenant, not global)', async () => {
  const { prisma } = db;
  await prisma.client.create({ data: { tenantId: 1, name: 'A', email: 'same@example.com' } });
  await prisma.client.create({ data: { tenantId: 2, name: 'B', email: 'same@example.com' } });
  await assert.rejects(() => prisma.client.create({ data: { tenantId: 1, name: 'C', email: 'same@example.com' } }), /Unique constraint/);
});

test('tenant queries use the tenant indexes', async () => {
  // Hint-free check on the seeded schema: a tenant+status filter must not need a sequential scan once there is enough data to prefer an index
  await db.admin.query('ANALYZE');
  await db.admin.query('SET enable_seqscan = off');
  const plan = (await db.admin.query(`EXPLAIN SELECT * FROM "Invoice" WHERE "tenantId" = 1 AND status = 'PAID'`)).rows.map((r) => r['QUERY PLAN']).join('\n');
  await db.admin.query('RESET enable_seqscan');
  assert.match(plan, /Invoice_tenantId_status_idx|Invoice_tenantId_idx/);
});
