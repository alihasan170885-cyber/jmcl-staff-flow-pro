'use strict';
const router = require('express').Router();
const { wrap, toInt } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const dash = require('../services/dashboard');

// Personal summary for any signed-in user.
router.get('/mine', wrap(async (req, res) => res.json(await dash.mine(req.user.id))));

// Company-wide views are for Admin and HR.
router.use(requireRole('admin', 'hr'));

router.get('/overview', wrap(async (req, res) => {
  const [today, trend, departments, punches, devices] = await Promise.all([
    dash.today(), dash.trend(Math.min(Math.max(toInt(req.query.days, 14), 7), 60)), dash.departments(),
    dash.recentPunches(10), dash.deviceStatus(),
  ]);
  res.json({ today, trend, departments, punches, devices });
}));

module.exports = router;
