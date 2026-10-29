'use strict';
const router = require('express').Router();
const { wrap, parse, bad } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { getSettings, updateSettings } = require('../services/settings');
const { isValidTimezone } = require('../utils/time');
const { query } = require('../db');
const { z } = require('./schemas');

const int = (min, max) => z.coerce.number().int().min(min).max(max);
const num = (min, max) => z.coerce.number().min(min).max(max);

const patch = z.object({
  company_name: z.string().trim().min(1).max(100),
  currency: z.string().trim().min(1).max(8),
  timezone: z.string().refine(isValidTimezone, 'must be a valid IANA timezone, e.g. Asia/Dhaka'),
  attendance: z.object({
    min_punch_gap_minutes: int(1, 60), half_day_minutes: int(30, 600), ot_max_minutes: int(0, 720),
    not_checked_in_alert_after_minutes: int(5, 480), device_offline_after_minutes: int(2, 1440),
  }).partial(),
  payroll: z.object({
    ot_multiplier: num(1, 5), off_day_ot_multiplier: num(1, 5), late_count_per_day_deduction: int(0, 31),
    perfect_attendance_bonus: num(0, 10000000), pf_percent: num(0, 50), tax_free_amount: num(0, 1e9), tax_rate_percent: num(0, 60),
  }).partial(),
}).partial();

router.get('/', requireRole('admin', 'hr'), wrap(async (req, res) => res.json({ settings: await getSettings() })));

router.put('/', requireRole('admin'), wrap(async (req, res) => {
  const p = parse(patch, req.body);
  if (!Object.keys(p).length) throw bad('Nothing to update');
  const current = await getSettings();
  const merged = {};
  if (p.company_name !== undefined) merged.company_name = p.company_name;
  if (p.currency !== undefined) merged.currency = p.currency;
  if (p.timezone !== undefined) merged.timezone = p.timezone;
  if (p.attendance) merged.attendance = { ...current.attendance, ...p.attendance };
  if (p.payroll) merged.payroll = { ...current.payroll, ...p.payroll };
  const settings = await updateSettings(merged);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','settings','settings',$2::jsonb)`,
    [req.user.id, JSON.stringify({ keys: Object.keys(p) })]);
  res.json({ settings, note: 'Changes apply to new calculations. Use Recalculate on the Attendance page to refresh past days.' });
}));

router.get('/audit', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.at, l.action, l.entity, l.entity_id, l.detail, u.name AS actor FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.at DESC LIMIT 100`);
  res.json({ entries: rows });
}));

module.exports = router;
