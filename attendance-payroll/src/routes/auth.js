'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { wrap, parse, HttpError, bad } = require('../utils/http');
const { issueSession, clearSession, authenticate } = require('../middleware/auth');
const { z, password } = require('./schemas');

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, employeeCode: u.employee_code,
  department: u.department, designation: u.designation, mustChangePassword: u.must_change_password,
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password: pw } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || !u.active) throw new HttpError(401, 'Email or password is incorrect');
  issueSession(res, req, u);
  res.json({ user: publicUser(u) });
}));

router.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const { rows: [u] } = await query('SELECT password_hash, email FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword, u.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  if (newPassword === currentPassword) throw bad('Choose a password different from the current one');
  if (newPassword.toLowerCase() === u.email.toLowerCase()) throw bad('Password cannot be your email address');
  await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.user.id, await bcrypt.hash(newPassword, 10)]);
  res.json({ ok: true });
}));

module.exports = router;
