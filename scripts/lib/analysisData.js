'use strict';

/**
 * Loads a large, realistic invoice dataset into the (already migrated) analysis schema with set-based SQL.
 * generate_series is used instead of a JS loop because inserting 200,000 rows one statement at a time would take minutes.
 *
 * Status mix and dates (relative to now) look like a real ledger:
 *   PAID 45%     created over the last ~18 months
 *   SENT 20%     mostly created in the last 29 days (still inside the 30-day term); ~4% are older, i.e. genuinely past due
 *   DRAFT 15%    created in the last 60 days
 *   OVERDUE 20%  created 31-120 days ago
 * Client ids are skewed (a few big clients have many invoices) so the "top 10 clients" query is meaningful.
 */

async function loadAnalysisData(client, { clients = 1000, invoices = 200000, posts = 5000 } = {}) {
  await client.query('SELECT setseed(0.42)'); // reproducible random()

  await client.query(
    `INSERT INTO "Client" (name, email, company, "createdAt")
     SELECT 'Client ' || g, 'client' || g || '@example.com', 'Company ' || g, now() - (random() * interval '700 days')
     FROM generate_series(1, $1::int) g`,
    [clients]
  );

  await client.query(
    `WITH base AS (
       SELECT g, random() AS r_status, random() AS r_date, random() AS r_late, random() AS r_client, random() AS r_amount
       FROM generate_series(1, $1::int) g
     ), typed AS (
       SELECT *, CASE WHEN r_status < 0.45 THEN 'PAID' WHEN r_status < 0.65 THEN 'SENT' WHEN r_status < 0.80 THEN 'DRAFT' ELSE 'OVERDUE' END AS status
       FROM base
     ), dated AS (
       SELECT *, now() - (CASE status
           WHEN 'PAID'  THEN r_date * 540
           WHEN 'DRAFT' THEN r_date * 60
           WHEN 'SENT'  THEN CASE WHEN r_late < 0.04 THEN 30 + r_date * 30 ELSE r_date * 29 END
           ELSE 31 + r_date * 90 END) * interval '1 day' AS created
       FROM typed
     )
     INSERT INTO "Invoice" ("invoiceNumber", "clientId", status, total, currency, "dueDate", "createdAt", "updatedAt")
     SELECT 'INV-' || lpad(g::text, 7, '0'),
            1 + floor($2::int * power(r_client, 2))::int,
            status,
            round((500 + r_amount * 200000)::numeric, 2)::float8,
            'KES',
            created + interval '30 days',
            created,
            created
     FROM dated`,
    [invoices, clients]
  );

  // 1-4 line items per invoice
  await client.query(
    `INSERT INTO "InvoiceItem" ("invoiceId", description, quantity, "unitPrice", total)
     SELECT i.id, 'Line item ' || n, 1 + (i.id + n) % 5, 1000 + ((i.id * n) % 50) * 100, (1 + (i.id + n) % 5) * (1000 + ((i.id * n) % 50) * 100)
     FROM "Invoice" i CROSS JOIN LATERAL generate_series(1, 1 + i.id % 4) n`
  );

  await client.query(
    `INSERT INTO "Post" (title, content, "authorId", "createdAt")
     SELECT 'Post ' || g, 'Some content for post ' || g, 1 + floor($2::int * random())::int, now() - (random() * interval '365 days')
     FROM generate_series(1, $1::int) g`,
    [posts, clients]
  );
}

module.exports = { loadAnalysisData };
