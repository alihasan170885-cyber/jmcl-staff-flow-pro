'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, bad } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { getPublicKey, notifyUsers } = require('../services/notifications');
const { z, id } = require('./schemas');

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT id, type, severity, title, body, url, read_at, created_at FROM notifications
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ notifications: rows, unread: c.n });
}));

router.post('/read-all', wrap(async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));
router.post('/:id/read', wrap(async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [parse(id, req.params.id), req.user.id]);
  res.json({ ok: true });
}));

/* ---------- Web Push (Admin / HR receive attendance exceptions on their phones) ---------- */
router.get('/push/key', (req, res) => res.json({ publicKey: getPublicKey() }));

const subSchema = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'must be an https push endpoint'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
});

router.post('/push/subscribe', requireRole('admin', 'hr'), wrap(async (req, res) => {
  const s = parse(subSchema, req.body);
  // A device re-subscribing under a different account moves the subscription to the current user.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth]);
  res.status(201).json({ ok: true });
}));

router.post('/push/unsubscribe', wrap(async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
  res.json({ ok: true });
}));

router.get('/push/status', wrap(async (req, res) => {
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
  res.json({ subscriptions: c.n });
}));

router.post('/push/test', requireRole('admin', 'hr'), wrap(async (req, res) => {
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
  if (!c.n) throw bad('Turn on notifications on this device first');
  await notifyUsers([req.user.id], {
    type: 'test', severity: 'info', title: 'Notifications are working',
    body: 'You will get a message like this when an attendance exception needs attention.', url: '/',
  });
  res.json({ ok: true });
}));

module.exports = router;
