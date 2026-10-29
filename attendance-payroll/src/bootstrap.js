'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for PostgreSQL (containers start in parallel). */
async function waitForDb(attempts = 40) {
  for (let i = 1; i <= attempts; i++) {
    try { await query('SELECT 1'); return; } catch (e) {
      if (i === attempts) throw e;
      console.log(`[db] waiting for PostgreSQL (${i}/${attempts}): ${e.code || e.message}`);
      await sleep(1500);
    }
  }
}

/** Apply db/schema.sql (idempotent). An advisory lock serialises concurrent replicas. */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7100)');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7100)').catch(() => {});
    client.release();
  }
  console.log('[db] schema is up to date');
}

/** First-run data: reference data always, demo data or a lone admin account depending on configuration. */
async function firstRun() {
  const seed = require('./seed');
  await seed.seedReference();
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM users');
  if (c.n > 0) return;

  if (config.seedDemo) {
    await seed.seedDemo();
    return;
  }
  const generated = !config.adminPassword;
  const pw = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  await query(
    `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id, must_change_password)
     VALUES ('ADMIN', '0', 'Administrator', $1, $2, 'admin', 'Management', 'System administrator', (SELECT id FROM shifts ORDER BY id LIMIT 1), $3)`,
    [config.adminEmail, await bcrypt.hash(pw, 10), true]);
  console.log('──────────────────────────────────────────────────────────');
  console.log(` First-run admin account created`);
  console.log(`   email:    ${config.adminEmail}`);
  console.log(`   password: ${generated ? pw + '   (generated — you must change it at first sign-in)' : '(from ADMIN_PASSWORD — you must change it at first sign-in)'}`);
  console.log('──────────────────────────────────────────────────────────');
}

module.exports = { waitForDb, migrate, firstRun };
