'use strict';

const express = require('express');
const { HttpError } = require('../errors');
const { parsePagination, pageMeta, parseSort, parseId, intParam } = require('../lib/pagination');

const STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE'];
const INVOICE_SORTS = ['id', 'createdAt', 'dueDate', 'total'];
const round2 = (n) => Math.round(n * 100) / 100;

const invoiceListSelect = { id: true, invoiceNumber: true, clientId: true, status: true, total: true, currency: true, dueDate: true, createdAt: true, tenantId: true };

function validationError(details) {
  return new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

function parseInvoiceBody(body) {
  const details = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError([{ field: 'body', message: 'Request body must be a JSON object' }]);
  }
  const { clientId, items, dueDate, status = 'DRAFT' } = body;
  if (!Number.isInteger(clientId) || clientId < 1) details.push({ field: 'clientId', message: 'Must be a positive integer' });
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    details.push({ field: 'items', message: 'Provide between 1 and 100 items' });
  } else {
    items.forEach((item, i) => {
      if (typeof item?.description !== 'string' || !item.description.trim() || item.description.length > 200) details.push({ field: `items[${i}].description`, message: 'Required, at most 200 characters' });
      if (!Number.isInteger(item?.quantity) || item.quantity < 1) details.push({ field: `items[${i}].quantity`, message: 'Must be an integer of at least 1' });
      if (typeof item?.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) details.push({ field: `items[${i}].unitPrice`, message: 'Must be a number of 0 or more' });
    });
  }
  const due = typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? new Date(`${dueDate}T00:00:00Z`) : null;
  if (!due || Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== dueDate) details.push({ field: 'dueDate', message: 'Must be a valid date in YYYY-MM-DD format' });
  if (!['DRAFT', 'SENT'].includes(status)) details.push({ field: 'status', message: 'Must be DRAFT or SENT' });
  if (details.length) throw validationError(details);
  return { clientId, items, dueDate: due, status };
}

/**
 * Everything here runs behind tenantMiddleware, and EVERY query includes `tenantId: req.tenantId`.
 * A record that belongs to another tenant is reported as 404 (not 403), so its existence is not revealed.
 */
function createV1Router({ prisma }) {
  const router = express.Router();

  // GET /api/v1/invoices?page=1&limit=20&status=PAID&clientId=5&sort=-createdAt
  router.get('/invoices', async (req, res) => {
    const pagination = parsePagination(req.query);
    const orderBy = parseSort(req.query, INVOICE_SORTS);
    const where = { tenantId: req.tenantId };
    if (req.query.status !== undefined) {
      const status = String(req.query.status).toUpperCase();
      if (!STATUSES.includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', `Query parameter "status" must be one of: ${STATUSES.join(', ')}`, { field: 'status' });
      where.status = status;
    }
    if (req.query.clientId !== undefined) where.clientId = parseId(req.query.clientId, 'clientId');

    const [total, data] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({ where, orderBy, skip: pagination.skip, take: pagination.take, select: invoiceListSelect }),
    ]);
    res.json({ tenantId: req.tenantId, data, meta: pageMeta(pagination, total) });
  });

  // GET /api/v1/invoices/:id
  router.get('/invoices/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const invoice = await prisma.invoice.findFirst({
      where: { id, tenantId: req.tenantId },
      include: { items: { orderBy: { id: 'asc' } }, client: { select: { id: true, name: true, email: true, company: true } } },
    });
    if (!invoice) throw new HttpError(404, 'NOT_FOUND', `Invoice with ID ${id} was not found`);
    res.json({ tenantId: req.tenantId, data: invoice });
  });

  // POST /api/v1/invoices  (created inside the caller's tenant; the client must belong to the same tenant)
  router.post('/invoices', async (req, res) => {
    const input = parseInvoiceBody(req.body);
    const client = await prisma.client.findFirst({ where: { id: input.clientId, tenantId: req.tenantId }, select: { id: true } });
    if (!client) throw validationError([{ field: 'clientId', message: `Client with ID ${input.clientId} does not exist` }]);

    const items = input.items.map((item) => ({
      description: item.description.trim(),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: round2(item.quantity * item.unitPrice),
    }));
    const last = await prisma.invoice.findFirst({ where: { tenantId: req.tenantId }, orderBy: { id: 'desc' }, select: { invoiceNumber: true } });
    const lastSeq = Number.parseInt(last?.invoiceNumber.split('-').pop() ?? '0', 10) || 0;

    const created = await prisma.invoice.create({
      data: {
        tenantId: req.tenantId,
        invoiceNumber: `INV-T${req.tenantId}-${String(lastSeq + 1).padStart(4, '0')}`,
        clientId: input.clientId,
        status: input.status,
        total: round2(items.reduce((sum, item) => sum + item.total, 0)),
        dueDate: input.dueDate,
        items: { create: items },
      },
      include: { items: true },
    });
    res.status(201).location(`${req.baseUrl}/invoices/${created.id}`).json({ tenantId: req.tenantId, data: created });
  });

  // GET /api/v1/clients?page&limit&q
  router.get('/clients', async (req, res) => {
    const pagination = parsePagination(req.query);
    const orderBy = parseSort(req.query, ['id', 'name', 'createdAt']);
    const where = { tenantId: req.tenantId };
    if (req.query.q !== undefined) {
      const q = String(req.query.q).trim();
      if (!q || q.length > 100) throw new HttpError(400, 'VALIDATION_ERROR', 'Query parameter "q" must be 1 to 100 characters', { field: 'q' });
      where.OR = ['name', 'email', 'company'].map((field) => ({ [field]: { contains: q, mode: 'insensitive' } }));
    }
    const [total, data] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where, orderBy, skip: pagination.skip, take: pagination.take,
        select: { id: true, name: true, email: true, company: true, createdAt: true, tenantId: true, _count: { select: { invoices: true, posts: true } } },
      }),
    ]);
    res.json({ tenantId: req.tenantId, data, meta: pageMeta(pagination, total) });
  });

  // GET /api/v1/clients/:id
  router.get('/clients/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const client = await prisma.client.findFirst({
      where: { id, tenantId: req.tenantId },
      include: { _count: { select: { invoices: true, posts: true } } },
    });
    if (!client) throw new HttpError(404, 'NOT_FOUND', `Client with ID ${id} was not found`);
    res.json({ tenantId: req.tenantId, data: client });
  });

  // GET /api/v1/posts?page&limit&authorId
  router.get('/posts', async (req, res) => {
    const pagination = parsePagination(req.query);
    const orderBy = parseSort(req.query, ['id', 'createdAt']);
    const where = { tenantId: req.tenantId };
    if (req.query.authorId !== undefined) where.authorId = parseId(req.query.authorId, 'authorId');
    const [total, data] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({ where, orderBy, skip: pagination.skip, take: pagination.take, include: { author: { select: { id: true, name: true } } } }),
    ]);
    res.json({ tenantId: req.tenantId, data, meta: pageMeta(pagination, total) });
  });

  // GET /api/v1/stats  (invoice totals per status for this tenant only)
  router.get('/stats', async (req, res) => {
    const [byStatus, clients, posts] = await Promise.all([
      prisma.invoice.groupBy({ by: ['status'], where: { tenantId: req.tenantId }, _count: { _all: true }, _sum: { total: true } }),
      prisma.client.count({ where: { tenantId: req.tenantId } }),
      prisma.post.count({ where: { tenantId: req.tenantId } }),
    ]);
    const invoices = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, total: 0 }]));
    for (const row of byStatus) invoices[row.status] = { count: row._count._all, total: round2(row._sum.total ?? 0) };
    res.json({
      tenantId: req.tenantId,
      data: { clients, posts, invoiceCount: byStatus.reduce((n, r) => n + r._count._all, 0), invoicesByStatus: invoices, currency: 'KES' },
    });
  });

  return router;
}

module.exports = { createV1Router };
