'use strict';
const router = require('express').Router();
const { query, tx } = require('../db');
const { wrap, parse, bad, notFound } = require('../utils/http');
const { requireRole, isManager } = require('../middleware/auth');
const { listAttendance, rebuildRange } = require('../services/attendance');
const { getSettings } = require('../services/settings');
const { addDays, todayIn, diffDays, monthRange, isMonth } = require('../utils/time');
const { z, date, time, id } = require('./schemas');

const manager = requireRole('admin', 'hr');

/** Staff only ever see their own records; managers may filter by employee. */
const scopeUser = (req) => (isManager(req.user) ? (req.query.userId ? parse(id, req.query.userId) : null) : req.user.id);

router.get('/', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.query.to ? parse(date, req.query.to) : todayIn(timezone);
  const from = req.query.from ? parse(date, req.query.from) : addDays(to, -13);
  if (from > to) throw bad('"from" must not be after "to"');
  if (diffDays(from, to) > 366) throw bad('Choose a range of up to one year');
  const rows = await listAttendance({
    from, to, userId: scopeUser(req),
    department: isManager(req.user) ? req.query.department : undefined,
    status: req.query.status || undefined, limit: 2000,
  });
  res.json({ from, to, rows });
}));

router.get('/summary', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const month = req.query.month || todayIn(timezone).slice(0, 7);
  if (!isMonth(month)) throw bad('month must look like 2026-10');
  const { from, to } = monthRange(month);
  const uid = scopeUser(req);
  const { rows: [s] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('present','late','half_day'))::int AS present,
            COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late_days,
            COALESCE(SUM(late_minutes), 0)::int AS late_minutes,
            COUNT(*) FILTER (WHERE early_out_minutes > 0)::int AS early_out_days,
            COUNT(*) FILTER (WHERE status = 'half_day')::int AS half_days,
            COUNT(*) FILTER (WHERE status IN ('leave','unpaid_leave'))::int AS leave_days,
            COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
            COALESCE(SUM(worked_minutes), 0)::int AS worked_minutes,
            COALESCE(SUM(overtime_minutes), 0)::int AS overtime_minutes
       FROM attendance WHERE work_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR user_id = $3)`, [from, to, uid]);
  res.json({ month, summary: s });
}));

/** Raw device punches (audit trail). */
router.get('/punches', manager, wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.query.to ? parse(date, req.query.to) : todayIn(timezone);
  const from = req.query.from ? parse(date, req.query.from) : addDays(to, -2);
  const uid = req.query.userId ? parse(id, req.query.userId) : null;
  const { rows } = await query(
    `SELECT p.id, p.pin, p.user_id, COALESCE(u.name, '') AS name, p.source, p.state, p.verify, d.name AS device,
            to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS at
       FROM punch_logs p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN devices d ON d.id = p.device_id
      WHERE p.punched_at >= ($2::date::timestamp AT TIME ZONE $1) AND p.punched_at < (($3::date + 1)::timestamp AT TIME ZONE $1)
        AND ($4::int IS NULL OR p.user_id = $4)
      ORDER BY p.punched_at DESC LIMIT 1000`, [timezone, from, to, uid]);
  res.json({ rows });
}));

/** HR correction: replace a day's punches with the given check-in / check-out. Always audited. */
router.post('/manual', manager, wrap(async (req, res) => {
  const b = parse(z.object({
    userId: id, date, checkIn: time, checkOut: time.nullable().optional(),
    reason: z.string().trim().min(3, 'is required').max(300),
  }), req.body);
  if (b.checkOut && b.checkOut <= b.checkIn) throw bad('Check-out must be after check-in');
  const { timezone } = await getSettings();
  if (b.date > todayIn(timezone)) throw bad('Cannot record attendance for a future date');

  const { rows: [u] } = await query('SELECT id, device_pin FROM users WHERE id = $1', [b.userId]);
  if (!u) throw notFound('Employee not found');

  const removed = await tx(async (db) => {
    const del = await db.query(
      `DELETE FROM punch_logs WHERE user_id = $1
          AND punched_at >= ($2::date::timestamp AT TIME ZONE $3) AND punched_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`,
      [u.id, b.date, timezone]);
    const ins = (t, state) => db.query(
      `INSERT INTO punch_logs (device_sn, pin, user_id, punched_at, state, source)
       VALUES ('MANUAL', $1, $2, ($3::timestamp AT TIME ZONE $4), $5, 'manual') ON CONFLICT DO NOTHING`,
      [u.device_pin, u.id, `${b.date} ${t.length === 5 ? t + ':00' : t}`, timezone, state]);
    await ins(b.checkIn, 0);
    if (b.checkOut) await ins(b.checkOut, 1);
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'manual-correction','attendance',$2,$3::jsonb)`,
      [req.user.id, `${u.id}:${b.date}`, JSON.stringify({ checkIn: b.checkIn, checkOut: b.checkOut || null, reason: b.reason, replacedPunches: del.rowCount })]);
    return del.rowCount;
  });
  await rebuildRange(b.date, b.date, { userId: u.id });
  res.json({ ok: true, replacedPunches: removed });
}));

/** Recompute derived attendance, e.g. after changing shifts, holidays or settings. */
router.post('/recalculate', manager, wrap(async (req, res) => {
  const b = parse(z.object({ from: date, to: date }), req.body);
  if (b.from > b.to) throw bad('"from" must not be after "to"');
  if (diffDays(b.from, b.to) > 92) throw bad('Recalculate up to 93 days at a time');
  const rows = await rebuildRange(b.from, b.to);
  res.json({ ok: true, rows });
}));

module.exports = router;
