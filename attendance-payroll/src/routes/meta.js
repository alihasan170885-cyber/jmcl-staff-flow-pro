'use strict';
const router = require('express').Router();
const { getSettings } = require('../services/settings');
const { todayIn } = require('../utils/time');
const { query } = require('../db');
const { wrap } = require('../utils/http');
const config = require('../config');

// Public: just enough for the login screen and the PWA shell.
router.get('/meta', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ company: s.company_name, timezone: s.timezone, currency: s.currency, today: todayIn(s.timezone), demo: config.seedDemo });
}));

router.get('/health', wrap(async (req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok', time: new Date().toISOString() });
}));

module.exports = router;
