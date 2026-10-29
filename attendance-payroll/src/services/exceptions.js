'use strict';
/**
 * Attendance exception detection -> in-app notifications + mobile push for Admin/HR.
 * Every alert uses a dedupe key, so scans can run every minute without duplicates.
 */
const { query } = require('../db');
const { getSettings } = require('./settings');
const { notifyManagers } = require('./notifications');
const { rebuildRange } = require('./attendance');
const { addDays, todayIn, nowMinIn, toMin, dow } = require('../utils/time');

const list = (names, max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

/** Immediate alert when a punch makes someone late. Called after ingest. */
async function checkLate(userId, date) {
  const { timezone } = await getSettings();
  const { rows: [r] } = await query(
    `SELECT u.name, a.late_minutes, to_char(a.check_in AT TIME ZONE $3, 'HH24:MI') AS at, to_char(s.start_time, 'HH24:MI') AS start
       FROM attendance a JOIN users u ON u.id = a.user_id JOIN shifts s ON s.id = a.shift_id
      WHERE a.user_id = $1 AND a.work_date = $2 AND a.late_minutes > 0`, [userId, date, timezone]);
  if (!r) return;
  await notifyManagers({
    type: 'late', severity: 'warning', title: `Late arrival: ${r.name}`,
    body: `Checked in at ${r.at}, ${r.late_minutes} min after the ${r.start} shift start.`,
    url: '/attendance', dedupe: `late:${userId}:${date}`,
  });
}

async function unknownPunch(device, pins) {
  await notifyManagers({
    type: 'unknown-pin', severity: 'warning', title: 'Punch from an unregistered PIN',
    body: `${device.name} recorded PIN ${pins.slice(0, 5).join(', ')} which is not linked to any employee.`,
    url: '/employees', dedupe: `unknown-pin:${device.id}:${pins.slice().sort().join(',')}`,
  });
}

/** Periodic scan: not-checked-in, early departure, missing checkout, absences, offline devices. */
async function scan() {
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const nowMin = nowMinIn(tz);
  const yesterday = addDays(today, -1);

  await rebuildRange(yesterday, today);

  // 1) Late arrivals that were not alerted at punch time (e.g. imported/polled data).
  const { rows: lates } = await query(
    `SELECT user_id FROM attendance WHERE work_date = $1 AND late_minutes > 0`, [today]);
  for (const l of lates) await checkLate(l.user_id, today);

  // 2) Still not checked in, N minutes after the shift started (one summary alert per day).
  const { rows: people } = await query(
    `SELECT u.id, u.name, s.start_time::text AS start_time, s.end_time::text AS end_time, s.weekly_off
       FROM users u JOIN shifts s ON s.id = u.shift_id
      WHERE u.active AND u.join_date <= $1 AND u.role <> 'admin'`, [today]);
  const [{ rows: hol }, { rows: onLeave }, { rows: punched }] = await Promise.all([
    query('SELECT 1 FROM holidays WHERE date = $1', [today]),
    query(`SELECT DISTINCT user_id FROM leave_requests WHERE status = 'approved' AND start_date <= $1 AND end_date >= $1`, [today]),
    query(`SELECT DISTINCT user_id FROM punch_logs WHERE user_id IS NOT NULL
             AND (punched_at AT TIME ZONE $1)::date = $2::date`, [tz, today]),
  ]);
  if (!hol.length) {
    const skip = new Set([...onLeave.map((r) => r.user_id), ...punched.map((r) => r.user_id)]);
    const wait = settings.attendance.not_checked_in_alert_after_minutes;
    const missing = people.filter((p) =>
      !p.weekly_off.includes(dow(today)) && !skip.has(p.id) &&
      nowMin >= toMin(p.start_time) + wait && nowMin < toMin(p.end_time));
    if (missing.length) {
      await notifyManagers({
        type: 'not-checked-in', severity: 'warning',
        title: `${missing.length} employee${missing.length === 1 ? ' has' : 's have'} not checked in`,
        body: list(missing.map((m) => m.name)), url: '/attendance', dedupe: `not-in:${today}`,
      });
    }
  }

  // 3) Finished days (yesterday, and today once the shift has ended).
  const { rows: done } = await query(
    `SELECT a.user_id, a.work_date::text AS d, a.status, a.early_out_minutes, a.missing_checkout, u.name,
            s.end_time::text AS end_time, to_char(a.check_out AT TIME ZONE $3, 'HH24:MI') AS out_at
       FROM attendance a JOIN users u ON u.id = a.user_id JOIN shifts s ON s.id = a.shift_id
      WHERE a.work_date IN ($1, $2)`, [yesterday, today, tz]);
  const absentByDay = new Map();
  for (const r of done) {
    const over = r.d < today || nowMin >= toMin(r.end_time);
    if (!over) continue;
    if (r.early_out_minutes > 0) {
      await notifyManagers({
        type: 'early-out', severity: 'info', title: `Early departure: ${r.name}`,
        body: `Left at ${r.out_at}, ${r.early_out_minutes} min before shift end.`, url: '/attendance', dedupe: `early:${r.user_id}:${r.d}`,
      });
    }
    if (r.missing_checkout) {
      await notifyManagers({
        type: 'missing-checkout', severity: 'warning', title: `No check-out: ${r.name}`,
        body: `Only one punch was recorded on ${r.d}. Add a manual correction if needed.`, url: '/attendance', dedupe: `nocheckout:${r.user_id}:${r.d}`,
      });
    }
    if (r.status === 'absent') {
      if (!absentByDay.has(r.d)) absentByDay.set(r.d, []);
      absentByDay.get(r.d).push(r.name);
    }
  }
  for (const [d, names] of absentByDay) {
    await notifyManagers({
      type: 'absent', severity: 'critical', title: `${names.length} absent on ${d}`,
      body: list(names), url: '/attendance', dedupe: `absent:${d}`,
    });
  }

  // 4) Devices that went quiet.
  const mins = settings.attendance.device_offline_after_minutes;
  const { rows: quiet } = await query(
    `UPDATE devices SET online = false
      WHERE approved AND active AND online AND last_seen < now() - make_interval(mins => $1)
      RETURNING id, name, extract(epoch FROM last_seen)::bigint AS seen`, [mins]);
  for (const d of quiet) {
    await notifyManagers({
      type: 'device-offline', severity: 'critical', title: `Device offline: ${d.name}`,
      body: `No contact for over ${mins} minutes. Punches will arrive late once it reconnects.`,
      url: '/devices', dedupe: `device-offline:${d.id}:${d.seen}`,
    });
  }
}

module.exports = { checkLate, unknownPunch, scan };
