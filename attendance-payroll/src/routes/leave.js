'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, forbidden } = require('../utils/http');
const { requireRole, isManager } = require('../middleware/auth');
const leave = require('../services/leave');
const { z, date, id } = require('./schemas');

router.get('/balances', wrap(async (req, res) => {
  const uid = isManager(req.user) && req.query.userId ? parse(id, req.query.userId) : req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
  res.json({ year, balances: await leave.getBalances(uid, year) });
}));

/** scope=mine (default) | pending (managers: queue) | all (managers) */
router.get('/requests', wrap(async (req, res) => {
  const scope = req.query.scope || 'mine';
  if (scope !== 'mine' && !isManager(req.user)) throw forbidden();
  const params = [];
  let where = 'TRUE';
  if (scope === 'mine') { params.push(req.user.id); where = `lr.user_id = $${params.length}`; }
  if (scope === 'pending') where = `lr.status = 'pending'`;
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) { params.push(req.query.status); where += ` AND lr.status = $${params.length}`; }
  const { rows } = await query(
    `SELECT lr.id, lr.user_id, u.name, u.department, lt.name AS type, lt.paid, lr.start_date::text AS start_date, lr.end_date::text AS end_date,
            lr.half_day, lr.days, lr.reason, lr.status, rv.name AS reviewer, lr.review_note, lr.created_at
       FROM leave_requests lr JOIN users u ON u.id = lr.user_id JOIN leave_types lt ON lt.id = lr.leave_type_id
       LEFT JOIN users rv ON rv.id = lr.reviewed_by
      WHERE ${where} ORDER BY (lr.status = 'pending') DESC, lr.start_date DESC LIMIT 300`, params);
  res.json({ requests: rows });
}));

router.post('/requests', wrap(async (req, res) => {
  const b = parse(z.object({
    leaveTypeId: id, startDate: date, endDate: date, halfDay: z.boolean().default(false), reason: z.string().trim().max(500).default(''),
  }), req.body);
  res.status(201).json(await leave.createRequest(req.user, b));
}));

const noteSchema = z.object({ note: z.string().trim().max(300).optional() });
router.post('/requests/:id/approve', requireRole('admin', 'hr'), wrap(async (req, res) => {
  res.json(await leave.review(parse(id, req.params.id), req.user, 'approved', parse(noteSchema, req.body ?? {}).note));
}));
router.post('/requests/:id/reject', requireRole('admin', 'hr'), wrap(async (req, res) => {
  res.json(await leave.review(parse(id, req.params.id), req.user, 'rejected', parse(noteSchema, req.body ?? {}).note));
}));
router.post('/requests/:id/cancel', wrap(async (req, res) => {
  res.json(await leave.cancel(parse(id, req.params.id), req.user));
}));

module.exports = router;
