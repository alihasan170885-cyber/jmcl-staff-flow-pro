'use strict';
const { z } = require('zod');
const { isDate, isMonth } = require('../utils/time');

const date = z.string().refine(isDate, 'must be a valid date (YYYY-MM-DD)');
const month = z.string().refine(isMonth, 'must be a month like 2026-10');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be a time like 09:00');
const id = z.coerce.number().int().positive();
const money = z.coerce.number().min(0).max(100000000);
const password = z.string().min(8, 'must be at least 8 characters').max(128);

module.exports = { z, date, month, time, id, money, password };
