'use strict';
const webpush = require('web-push');
const { query } = require('../db');
const config = require('../config');
const { getSecret } = require('./settings');

let pushReady = false;
let publicKey = null;

/** Load (or generate once) the VAPID keypair used for Web Push. */
async function initPush() {
  const keys = await getSecret('vapid', async () => webpush.generateVAPIDKeys());
  webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
  pushReady = true;
}
const getPublicKey = () => publicKey;

async function sendPush(userId, payload) {
  if (!pushReady) return;
  const { rows } = await query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  await Promise.all(rows.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: payload.severity === 'critical' ? 'high' : 'normal' },
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); // subscription expired
      } else {
        console.warn('[push] send failed:', err.statusCode || err.message);
      }
    }
  }));
}

/**
 * Create an in-app notification (and a push) for every given user id.
 * `dedupe` makes the call idempotent per user, so scans can run repeatedly without spamming.
 */
async function notifyUsers(userIds, { type, severity = 'info', title, body = '', url = '/', dedupe = null }) {
  for (const userId of userIds) {
    const { rows } = await query(
      `INSERT INTO notifications (user_id, type, severity, title, body, url, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [userId, type, severity, title, body, url, dedupe],
    );
    if (rows.length) sendPush(userId, { id: rows[0].id, title, body, url, severity, type }).catch(() => {});
  }
}

async function notifyRoles(roles, payload) {
  const { rows } = await query('SELECT id FROM users WHERE active AND role = ANY($1)', [roles]);
  await notifyUsers(rows.map((r) => r.id), payload);
}
/** Attendance exceptions go to HR and Admin. */
const notifyManagers = (payload) => notifyRoles(['admin', 'hr'], payload);

module.exports = { initPush, getPublicKey, sendPush, notifyUsers, notifyRoles, notifyManagers };
