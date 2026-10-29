'use strict';

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://payroll:payroll@localhost:5432/payroll',
  // Default company timezone; can be changed later in Settings. Device timestamps are interpreted in this zone.
  defaultTimezone: process.env.TZ_DEFAULT || process.env.TZ || 'Asia/Dhaka',
  // Optional. When unset, random secrets are generated on first boot and kept in the database.
  jwtSecret: process.env.JWT_SECRET || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // Demo data (employees, 60 days of punches, leave, payroll history).
  seedDemo: bool(process.env.SEED_DEMO, false),
  // First-run admin account when SEED_DEMO is false.
  adminEmail: process.env.ADMIN_EMAIL || 'admin@company.test',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Background jobs (exception scan, device heartbeat, http-pull poller).
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),
  sessionHours: parseInt(process.env.SESSION_HOURS || '12', 10),
  trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
};
