'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../db');
const { wrap, parse, bad, forbidden, notFound } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { ensureBalances } = require('./../services/leave');
const { backfillPin, rebuildRange } = require('../services/attendance');
const { todayIn, addDays } = require('../utils/time');
const { getSettings } = require('../services/settings');
const { z, date, id, money, password } = require('./schemas');

router.use(requireRole('admin', 'hr'));

const COLS = `u.id, u.employee_code, u.device_pin, u.name, u.email, u.role, u.department, u.designation, u.shift_id,
              s.name AS shift_name, u.base_salary, u.allowances, u.join_date::text AS join_date, u.active, u.must_change_password`;

const body = z.object({
  employeeCode: z.string().trim().min(1).max(32),
  devicePin: z.string().trim().regex(/^\d{1,9}$/, 'must be 1–9 digits, as enrolled on the device').optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  role: z.enum(['admin', 'hr', 'staff']).default('staff'),
  department: z.string().trim().min(1).max(80).default('General'),
  designation: z.string().trim().max(80).default(''),
  shiftId: id.nullable().optional(),
  baseSalary: money.default(0),
  allowances: money.default(0),
  joinDate: date.optional(),
  active: z.boolean().default(true),
  password: password.optional(),
});

/** Admin manages everyone; HR manages Staff only. */
function assertCanManage(actor, targetRole, newRole) {
  if (actor.role === 'admin') return;
  if (targetRole !== 'staff' || (newRole && newRole !== 'staff')) throw forbidden('HR can only manage Staff accounts');
}

const tempPassword = () => `Tmp-${crypto.randomBytes(6).toString('base64url')}`;

router.get('/', wrap(async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 60)}%`); where += ` AND (u.name ILIKE $${params.length} OR u.employee_code ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  if (req.query.department) { params.push(req.query.department); where += ` AND u.department = $${params.length}`; }
  if (req.query.active === 'true' || req.query.active === 'false') { params.push(req.query.active === 'true'); where += ` AND u.active = $${params.length}`; }
  const { rows } = await query(`SELECT ${COLS} FROM users u LEFT JOIN shifts s ON s.id = u.shift_id WHERE ${where} ORDER BY u.name`, params);
  res.json({ users: rows });
}));

router.get('/departments', wrap(async (req, res) => {
  const { rows } = await query('SELECT DISTINCT department FROM users ORDER BY department');
  res.json({ departments: rows.map((r) => r.department) });
}));

router.post('/', wrap(async (req, res) => {
  const d = parse(body, req.body);
  assertCanManage(req.user, 'staff', d.role);
  const pw = d.password || tempPassword();
  const pin = d.devicePin || (/^\d{1,9}$/.test(d.employeeCode) ? d.employeeCode : null);
  if (!pin) throw bad('Device PIN is required when the employee code is not numeric');
  const { rows: [u] } = await query(
    `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id,
                        base_salary, allowances, join_date, active, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13,true) RETURNING id`,
    [d.employeeCode, pin, d.name, d.email, await bcrypt.hash(pw, 10), d.role, d.department, d.designation, d.shiftId ?? null,
      d.baseSalary, d.allowances, d.joinDate ?? null, d.active]);
  await ensureBalances(u.id, new Date().getUTCFullYear());
  const matched = await backfillPin(u.id, pin);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'create','user',$2)`, [req.user.id, String(u.id)]);
  res.status(201).json({ id: u.id, temporaryPassword: d.password ? undefined : pw, matchedPunches: matched });
}));

router.patch('/:id', wrap(async (req, res) => {
  const uid = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT id, role, device_pin FROM users WHERE id = $1', [uid]);
  if (!target) throw notFound('Employee not found');
  const d = parse(body.omit({ password: true }).partial(), req.body);
  assertCanManage(req.user, target.role, d.role);
  if (uid === req.user.id && (d.active === false || (d.role && d.role !== req.user.role))) {
    throw forbidden('You cannot deactivate or change the role of your own account');
  }
  const map = {
    employeeCode: 'employee_code', devicePin: 'device_pin', name: 'name', email: 'email', role: 'role', department: 'department',
    designation: 'designation', shiftId: 'shift_id', baseSalary: 'base_salary', allowances: 'allowances', joinDate: 'join_date', active: 'active',
  };
  const sets = [];
  const params = [uid];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { params.push(d[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) throw bad('Nothing to update');
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','user',$2,$3::jsonb)`,
    [req.user.id, String(uid), JSON.stringify({ fields: Object.keys(d) })]);

  if (d.devicePin && d.devicePin !== target.device_pin) await backfillPin(uid, d.devicePin);
  if (d.shiftId !== undefined || d.joinDate !== undefined) {
    const { timezone } = await getSettings();
    const today = todayIn(timezone);
    await rebuildRange(addDays(today, -7), today, { userId: uid }); // shift change affects recent days only
  }
  res.json({ ok: true });
}));

router.post('/:id/reset-password', wrap(async (req, res) => {
  const uid = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT role FROM users WHERE id = $1', [uid]);
  if (!target) throw notFound('Employee not found');
  assertCanManage(req.user, target.role);
  const pw = tempPassword();
  await query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [uid, await bcrypt.hash(pw, 10)]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'reset-password','user',$2)`, [req.user.id, String(uid)]);
  res.json({ temporaryPassword: pw });
}));

module.exports = router;
