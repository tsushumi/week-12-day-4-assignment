'use strict';

const { HttpError } = require('../errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function intParam(query, name, { min, max, fallback }) {
  const raw = query[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Query parameter "${name}" must be an integer between ${min} and ${max}`, { field: name });
  }
  return Number(raw);
}

// ?page=1&limit=20 -> { page, limit, skip, take }
function parsePagination(query) {
  const page = intParam(query, 'page', { min: 1, max: 1_000_000, fallback: 1 });
  const limit = intParam(query, 'limit', { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

function pageMeta({ page, limit }, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// ?sort=-createdAt -> { createdAt: 'desc' } (only whitelisted fields; id is always the tie-breaker)
function parseSort(query, allowed, fallback = 'id') {
  const raw = query.sort ?? fallback;
  const descending = typeof raw === 'string' && raw.startsWith('-');
  const field = typeof raw === 'string' ? raw.replace(/^-/, '') : '';
  if (!allowed.includes(field)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Query parameter "sort" must be one of: ${allowed.flatMap((f) => [f, `-${f}`]).join(', ')}`, { field: 'sort' });
  }
  const direction = descending ? 'desc' : 'asc';
  return field === 'id' ? [{ id: direction }] : [{ [field]: direction }, { id: 'asc' }];
}

function parseId(value, name = 'id') {
  if (!/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 2147483647) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"${name}" must be a positive integer`, { field: name });
  }
  return Number(value);
}

module.exports = { parsePagination, pageMeta, parseSort, parseId, intParam, DEFAULT_LIMIT, MAX_LIMIT };
