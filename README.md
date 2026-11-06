# Week 12 Day 4: Database Optimization

Express + Prisma + PostgreSQL. Covers slow-query analysis with `EXPLAIN ANALYZE` and indexes, fixing an N+1 query, connection pooling with a health endpoint, and (bonus) multi-tenant data isolation.

| Task | Where |
|---|---|
| 1. EXPLAIN ANALYZE before/after indexes | [`query-analysis.md`](query-analysis.md), `npm run analyze`, `prisma/migrations/*_add_indexes` |
| 2. N+1 fix | `GET /api/users-bad`, `/api/users-good`, `/api/users-comparison` (`src/services/users.js`) |
| 3. Pooling + health | `src/lib/prisma.js`, `GET /health` |
| Bonus: multi-tenancy | `X-Tenant-Id` header, `/api/v1/*`, `prisma/migrations/*_add_multi_tenancy` |

## Setup

```bash
npm install
cp .env.example .env            # then put your Supabase/Neon connection string in DATABASE_URL
npx prisma migrate dev          # applies the 3 migrations (init, add_indexes, add_multi_tenancy)
npm run seed                    # 2 tenants x (50 clients, 200 invoices with items, 300 posts)
npm run dev                     # http://localhost:3000
npm test                        # 36 tests (needs DATABASE_URL, uses its own throw-away schema)
```

`DATABASE_URL` carries the pool settings:

```bash
# development
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=5&pool_timeout=10"
# production (set in the deployment environment)
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20&pool_timeout=10"
```

If `npx prisma migrate dev` cannot download its engine on your network, `npm run db:deploy` applies the same migration files with a small built-in runner (same `_prisma_migrations` table and checksums).

## Task 1: slow queries and indexes

`npm run analyze` creates a separate `analysis` schema, loads 200,000 invoices (a 200-row table would always use a sequential scan, so there would be nothing to measure), runs the three queries from the assignment through `prisma.$queryRawUnsafe("EXPLAIN ANALYZE ...")` before and after the `add_indexes` migration, and writes [`query-analysis.md`](query-analysis.md) and `analysis/results.json`. Your real tables are not touched.

| Query | Before | After | Result |
|---|---|---|---|
| 1. `status = 'PAID' ORDER BY createdAt DESC LIMIT 20` | Parallel Seq Scan, 200,000 rows examined | Index Scan Backward using `Invoice_status_createdAt_idx`, 20 rows | about 300x faster |
| 2. overdue: `dueDate < NOW() AND status = 'SENT'` | Seq Scan | Bitmap scan on `Invoice_status_idx` | about 1.7x faster |
| 3. top 10 clients by paid total | Parallel Seq Scan | Index Only Scan using `Invoice_status_clientId_total_idx` | about 1.2x faster |

Exact numbers vary from run to run (see the file for the latest). Two findings worth reading in the report:

- **Query 2:** the planner estimated ~28,000 matching rows (only ~1,600 match), so it did not pick the composite `(status, dueDate)` index. With only that index available the query takes ~1.6 ms, about 8x faster than what the five assignment indexes give. The plain `status` index is redundant with the composites and can mislead the planner.
- **Query 3:** the five indexes from the assignment alone make this query *slower* (the planner picks the `status` index and fetches ~90,000 rows from the table). I added a covering index `(status, clientId, total)` so it can use an Index Only Scan. Reading 45% of the table can never be made dramatically cheaper by an index.

I also indexed the foreign keys `Post.authorId` and `InvoiceItem.invoiceId`; PostgreSQL does not do that automatically, and the N+1 fix needs the first one.

## Task 2: N+1

`GET /api/users-bad` loads 20 users and then each user's posts in a loop: **21 queries**. `GET /api/users-good` does the same with `include` + `_count` and `relationLoadStrategy: 'join'`: **1 query**. Query counts come from Prisma's `query` event, counted per request with `AsyncLocalStorage`, so concurrent requests don't mix their counts.

```text
$ curl localhost:3000/api/users-comparison
{"runs":5,"bad":{"queryCount":21,"responseTimeMs":33.6,"userCount":20},
 "good":{"queryCount":1,"responseTimeMs":2.9,"userCount":20},
 "improvement":{"queriesReduced":"21 -> 1 (95% reduction)","speedup":"11.5x faster"}}
```

(Median of 5 runs after a warm-up; `?runs=N` changes it. The gap grows with network latency, because every extra query is another round trip. This was measured against a local database.)

## Task 3: pooling and /health

`src/lib/prisma.js` is a singleton (cached on `globalThis`, so nodemon/hot reloads reuse one pool). `connection_limit` becomes the pool's max size and `pool_timeout` the time a query waits for a free connection. Development prints every query; production prints only warnings, errors and **slow queries (over 100 ms, `SLOW_QUERY_MS`)**, which are logged with `console.warn` in every environment.

```text
$ curl localhost:3000/health                        -> 200
{"status":"healthy","database":{"connected":true,"responseTimeMs":101,
 "poolConfig":{"connectionLimit":5,"poolTimeout":10,"environment":"development"},
 "pool":{"total":1,"idle":1,"waiting":0}},"timestamp":"2026-11-04T21:14:15.641Z"}

$ curl -i localhost:3001/health   (database unreachable) -> 503
{"status":"degraded","database":{"connected":false,"error":"Database server unreachable",
 "poolConfig":{...},"pool":{"total":0,"idle":0,"waiting":0}},"timestamp":"..."}
```

The check runs `SELECT 1` with its own timeout (`HEALTH_TIMEOUT_MS`, default 3 s) and returns fixed error strings, never host names or credentials.

## Bonus: multi-tenancy

`tenantId` (default 1) on `Client`, `Invoice` and `Post`, with indexes `tenantId`, `(tenantId, status)`, `(tenantId, createdAt)`, `(tenantId, clientId)` and so on. Client emails are unique **per tenant**. Every `/api/v1` route sits behind `tenantMiddleware`, which reads `X-Tenant-Id` (strictly: `1abc`, `0`, `-1`, `1.5` are rejected) and every query filters by it.

```text
GET /api/v1/invoices                 (no header)  -> 400 {"error":{"code":"TENANT_REQUIRED","message":"X-Tenant-Id header is required"}}
GET /api/v1/invoices   X-Tenant-Id: 1             -> INV-T1-0001, INV-T1-0002 ...  total 200
GET /api/v1/invoices   X-Tenant-Id: 2             -> INV-T2-0001, INV-T2-0002 ...  total 200
GET /api/v1/invoices/201  X-Tenant-Id: 1          -> 404 (invoice 201 belongs to tenant 2; existence is not revealed)
```

Endpoints: `GET /api/v1/invoices` (`page`, `limit`, `status`, `clientId`, `sort`), `GET /api/v1/invoices/:id`, `POST /api/v1/invoices`, `GET /api/v1/clients` (`q`), `GET /api/v1/clients/:id`, `GET /api/v1/posts` (`authorId`), `GET /api/v1/stats`. The `/api/users-*` demo endpoints are scoped when the header is sent and cover all tenants when it is not. `/health` needs no tenant.

`test/tenant.test.js` proves the isolation: disjoint datasets, every list endpoint scoped, cross-tenant ids give 404, cross-tenant search/filter returns nothing, and cross-tenant writes are rejected.

> **Security note.** A header only *identifies* a tenant; it does not prove the caller may use it, so anyone can send `X-Tenant-Id: 2`. In a real system the tenant must come from the authenticated identity (a JWT claim or API key). PostgreSQL row-level security would add a second line of defence. The header approach is what this assignment specifies.

## Design notes and deviations

- **Prisma 6 with `engineType = "client"` and `@prisma/adapter-pg`.** Queries run through node-postgres instead of the Rust engine, which lets the app own the pool (`max`, timeout) and report real pool numbers from `/health`. It is also why the client is created as `new PrismaClient({ adapter, log })`. `relationJoins` is enabled so `relationLoadStrategy: 'join'` gives one SQL statement.
- **Migrations were written by hand** in Prisma's own SQL format, because the environment this was built in could not download Prisma's migration engine. `test/schema.test.js` compares `schema.prisma` with the migrated database (tables, column types, nullability, every index name and column list, foreign key rules). `npx prisma migrate status` should be clean; if `migrate dev` ever proposes an extra migration, accept it and commit it.
- Raw SQL (`$queryRaw`, `TRUNCATE`) ignores the client's `schema` option; the seed and the analysis script name the schema explicitly.
- The bad/good user functions add `orderBy: { id: 'asc' }` so both return the same 20 users.
- Extra indexes beyond the assignment's list: `(status, clientId, total)`, `InvoiceItem(invoiceId)`, `Post(authorId)`.
