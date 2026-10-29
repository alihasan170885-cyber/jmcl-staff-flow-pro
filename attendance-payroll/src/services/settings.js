'use strict';
const crypto = require('crypto');
const { query } = require('../db');
const config = require('../config');
const { DEFAULT_RULES: PAYROLL_DEFAULTS } = require('../logic/payrollCalc');
const { DEFAULT_RULES: ATTENDANCE_DEFAULTS } = require('../logic/attendanceRules');

const DEFAULTS = {
  company_name: 'Northwind Corporate',
  currency: 'BDT',
  timezone: config.defaultTimezone,
  attendance: {
    ...ATTENDANCE_DEFAULTS,
    not_checked_in_alert_after_minutes: 60,   // alert HR when staff are still not in this long after shift start
    device_offline_after_minutes: 15,
  },
  payroll: { ...PAYROLL_DEFAULTS },
};

let cache = null;

async function load() {
  const { rows } = await query(`SELECT key, value FROM settings WHERE key NOT LIKE '\\_%'`);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = {
    company_name: stored.company_name ?? DEFAULTS.company_name,
    currency: stored.currency ?? DEFAULTS.currency,
    timezone: stored.timezone ?? DEFAULTS.timezone,
    attendance: { ...DEFAULTS.attendance, ...(stored.attendance || {}) },
    payroll: { ...DEFAULTS.payroll, ...(stored.payroll || {}) },
  };
  return cache;
}

async function getSettings() { return cache || load(); }

async function updateSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  return load();
}

/** Secrets live in the settings table under keys starting with "_" and are never returned by the API. */
async function getSecret(name, generate) {
  const key = `_${name}`;
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (rows.length) return rows[0].value;
  const value = await generate();
  const ins = await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING value`,
    [key, JSON.stringify(value)],
  );
  if (ins.rows.length) return ins.rows[0].value;
  return (await query('SELECT value FROM settings WHERE key = $1', [key])).rows[0].value; // lost a race
}

const randomSecret = async () => crypto.randomBytes(48).toString('hex');

module.exports = { getSettings, updateSettings, getSecret, randomSecret, DEFAULTS };
