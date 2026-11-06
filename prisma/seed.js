'use strict';

/**
 * Seed data: TWO tenants, each with 50 clients, 200 invoices (2-5 line items each) and 300 posts.
 * Total: 100 clients, 400 invoices (~1,400 items), 600 posts, comfortably above the required minimum
 * (50 / 200 / 300), and enough for the multi-tenant isolation demo.
 *
 * The data is generated with loops and a seeded random number generator, so every run produces the same
 * dataset and tests can rely on it. Run with:  npx prisma db seed   (or npm run seed)
 */

require('dotenv').config({ quiet: true });

const FIRST_NAMES = ['Wanjiru', 'Otieno', 'Amina', 'Kipchoge', 'Njeri', 'Barasa', 'Achieng', 'Mutua', 'Fatuma', 'Kamau', 'Chebet', 'Mwende', 'Odhiambo', 'Wambui', 'Juma', 'Atieno', 'Kiprop', 'Nyambura', 'Hassan', 'Akinyi', 'Maina', 'Zawadi', 'Omondi', 'Wafula', 'Naliaka'];
const LAST_NAMES = ['Kamau', 'Odhiambo', 'Hassan', 'Rotich', 'Mwangi', 'Wekesa', 'Ouma', 'Kioko', 'Ali', 'Njoroge', 'Korir', 'Musyoka', 'Otieno', 'Karanja', 'Mohamed', 'Onyango', 'Cheruiyot', 'Wanjala', 'Mutiso', 'Githinji'];
const COMPANY_STEMS = {
  1: ['Savannah', 'Kisumu', 'Mombasa', 'Rift Valley', 'Nairobi', 'Western', 'Lakeside', 'Machakos', 'Lamu', 'Thika'],
  2: ['Mt Kenya', 'Nakuru', 'Coastal', 'Eldoret', 'Naivasha', 'Kitui', 'Kakamega', 'Nyeri', 'Malindi', 'Garissa'],
};
const COMPANY_KINDS = ['Coffee Traders', 'Boat Works', 'Spice Co.', 'Dairy', 'Fresh Produce', 'Bricks Ltd', 'Hotel', 'Hardware', 'Tours', 'Textile Mills', 'Grain Store', 'Solar Solutions', 'Logistics', 'Printers'];
const ITEM_CATALOG = [
  ['Website design', 85000], ['Hosting (per month)', 2500], ['Consulting (per hour)', 4500], ['Mobile app development', 250000],
  ['QA testing', 40000], ['M-Pesa integration', 60000], ['Brand identity package', 35000], ['Social media templates', 3000],
  ['SEO audit', 28000], ['Content writing (per article)', 3500], ['Data migration', 55000], ['Server maintenance', 12000],
];
const POST_TOPICS = ['Getting paid faster', 'How we cut invoice disputes', 'Why we moved to M-Pesa', 'Cash-flow lessons from this quarter', 'Hiring our first developer', 'Choosing a PostgreSQL host', 'Our onboarding checklist', 'Customer story', 'Pricing changes', 'Year in review'];
const POST_SENTENCES = [
  'We reviewed every open invoice this week and followed up with each client personally.',
  'Switching to mobile payments shortened our average collection time considerably.',
  'The hardest part was agreeing on payment terms before the work started.',
  'A clear invoice number and due date removed most of the back-and-forth.',
  'We now send a reminder three days before the due date.',
  'Small, regular invoices keep cash flow predictable.',
];

// Small deterministic PRNG (mulberry32) so the seed is reproducible
function createRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// Invoice status mix and matching dates (relative to "now") so the data looks like a real ledger
function invoiceTiming(rand, now) {
  const r = rand.next();
  let status;
  let ageDays;
  if (r < 0.45) { status = 'PAID'; ageDays = rand.int(5, 300); }
  else if (r < 0.65) { status = 'SENT'; ageDays = rand.int(0, 28); }
  else if (r < 0.8) { status = 'DRAFT'; ageDays = rand.int(0, 20); }
  else { status = 'OVERDUE'; ageDays = rand.int(35, 120); }
  const createdAt = new Date(now - ageDays * DAY_MS);
  const dueDate = new Date(createdAt.getTime() + 30 * DAY_MS);
  return { status, createdAt, dueDate };
}

async function seedTenant(prisma, tenantId, { clients, invoices, posts, now, log }) {
  const rand = createRandom(1000 + tenantId);
  const stems = COMPANY_STEMS[tenantId] || COMPANY_STEMS[1];

  const clientRows = [];
  for (let i = 1; i <= clients; i++) {
    const first = rand.pick(FIRST_NAMES);
    const last = rand.pick(LAST_NAMES);
    clientRows.push({
      tenantId,
      name: `${first} ${last}`,
      email: `${first}.${last}.t${tenantId}.${i}@example.com`.toLowerCase(),
      company: `${rand.pick(stems)} ${rand.pick(COMPANY_KINDS)}`,
      createdAt: new Date(now - rand.int(200, 700) * DAY_MS),
    });
  }
  await prisma.client.createMany({ data: clientRows });
  const clientIds = (await prisma.client.findMany({ where: { tenantId }, select: { id: true }, orderBy: { id: 'asc' } })).map((c) => c.id);

  // Invoices with their line items (one nested create per invoice)
  for (let n = 1; n <= invoices; n++) {
    const items = [];
    const lineCount = rand.int(2, 5);
    for (let k = 0; k < lineCount; k++) {
      const [description, unitPrice] = rand.pick(ITEM_CATALOG);
      const quantity = rand.int(1, 6);
      items.push({ description, quantity, unitPrice, total: round2(quantity * unitPrice) });
    }
    const { status, createdAt, dueDate } = invoiceTiming(rand, now);
    await prisma.invoice.create({
      data: {
        tenantId,
        invoiceNumber: `INV-T${tenantId}-${String(n).padStart(4, '0')}`,
        clientId: rand.pick(clientIds),
        status,
        total: round2(items.reduce((sum, item) => sum + item.total, 0)),
        currency: 'KES',
        dueDate,
        createdAt,
        items: { create: items },
      },
    });
    if (n % 100 === 0) log(`  tenant ${tenantId}: ${n}/${invoices} invoices`);
  }

  const postRows = [];
  for (let p = 1; p <= posts; p++) {
    postRows.push({
      tenantId,
      title: `${rand.pick(POST_TOPICS)} #${p}`,
      content: [rand.pick(POST_SENTENCES), rand.pick(POST_SENTENCES), rand.pick(POST_SENTENCES)].join(' '),
      authorId: rand.pick(clientIds),
      createdAt: new Date(now - rand.int(0, 365) * DAY_MS),
    });
  }
  await prisma.post.createMany({ data: postRows });
}

/**
 * Wipes the tables and seeds every tenant. `prisma` is any PrismaClient (tests pass their own).
 */
async function seedDatabase(prisma, { schema = 'public', tenants = [1, 2], clients = 50, invoices = 200, posts = 300, now = Date.now(), log = () => {} } = {}) {
  // Raw SQL ignores the client's schema setting, so the schema is named explicitly (and validated, it is part of SQL text)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const tables = ['InvoiceItem', 'Invoice', 'Post', 'Client'].map((t) => `"${schema}"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  for (const tenantId of tenants) {
    log(`Seeding tenant ${tenantId}: ${clients} clients, ${invoices} invoices, ${posts} posts`);
    await seedTenant(prisma, tenantId, { clients, invoices, posts, now, log });
  }
  const [c, i, it, p] = await Promise.all([prisma.client.count(), prisma.invoice.count(), prisma.invoiceItem.count(), prisma.post.count()]);
  return { clients: c, invoices: i, invoiceItems: it, posts: p };
}

module.exports = { seedDatabase, createRandom };

if (require.main === module) {
  const { createPrismaClient } = require('../src/lib/prisma');
  const { prisma, pool, schema } = createPrismaClient({ env: { ...process.env, LOG_QUERIES: 'false' } });
  seedDatabase(prisma, { schema, log: (line) => console.log(line) })
    .then((counts) => console.log('Seeded:', counts))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end().catch(() => {});
    });
}
