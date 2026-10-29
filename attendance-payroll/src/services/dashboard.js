'use strict';
const { query } = require('../db');
const { getSettings } = require('./settings');
const { todayIn, nowMinIn, addDays, dow, toMin, monthRange } = require('../utils/time');

/** Today's headline numbers + the per-employee "shift ribbon" data. */
async function today() {
  const { timezone: tz } = await getSettings();
  const date = todayIn(tz);
  const nowMin = nowMinIn(tz);

  const [people, rows, hol, leave] = await Promise.all([
    query(`SELECT u.id, u.name, u.department, s.start_time::text AS st, s.end_time::text AS et, s.weekly_off
             FROM users u JOIN shifts s ON s.id = u.shift_id
            WHERE u.active AND u.join_date <= $1 AND u.role <> 'admin' ORDER BY u.name`, [date]),
    query(`SELECT a.user_id, a.status, a.late_minutes, a.early_out_minutes, a.overtime_minutes,
                  to_char(a.check_in AT TIME ZONE $2, 'HH24:MI') AS cin, to_char(a.check_out AT TIME ZONE $2, 'HH24:MI') AS cout
             FROM attendance a WHERE a.work_date = $1`, [date, tz]),
    query('SELECT name FROM holidays WHERE date = $1', [date]),
    query(`SELECT DISTINCT user_id FROM leave_requests WHERE status = 'approved' AND start_date <= $1 AND end_date >= $1`, [date]),
  ]);

  const byUser = new Map(rows.rows.map((r) => [r.user_id, r]));
  const onLeave = new Set(leave.rows.map((l) => l.user_id));
  const holiday = hol.rows[0]?.name || null;
  const isOff = (p) => p.weekly_off.includes(dow(date));

  const expected = people.rows.filter((p) => !holiday && !isOff(p));
  const kpi = { expected: expected.length, present: 0, late: 0, absent: 0, onLeave: 0, notYet: 0, overtimeMinutes: 0 };
  const ribbon = [];

  for (const p of expected) {
    const r = byUser.get(p.id);
    let state;
    if (r && ['present', 'late', 'half_day'].includes(r.status)) {
      kpi.present++;
      if (r.late_minutes > 0) kpi.late++;
      kpi.overtimeMinutes += r.overtime_minutes || 0;
      state = r.late_minutes > 0 ? 'late' : r.status;
    } else if (onLeave.has(p.id) || (r && ['leave', 'unpaid_leave'].includes(r.status))) {
      kpi.onLeave++; state = 'leave';
    } else if (r && r.status === 'absent') {
      kpi.absent++; state = 'absent';
    } else {
      kpi.notYet++; state = 'waiting';
    }
    ribbon.push({
      id: p.id, name: p.name, department: p.department, state,
      shiftStart: p.st.slice(0, 5), shiftEnd: p.et.slice(0, 5),
      checkIn: r?.cin || null, checkOut: r?.cout || null,
      lateMinutes: r?.late_minutes || 0, earlyOutMinutes: r?.early_out_minutes || 0, overtimeMinutes: r?.overtime_minutes || 0,
    });
  }
  return { date, nowLocal: `${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')}`, holiday, kpi, ribbon };
}

/** Status counts per day for the last N days (stacked bar). */
async function trend(days = 14) {
  const { timezone: tz } = await getSettings();
  const to = todayIn(tz);
  const from = addDays(to, -(days - 1));
  const { rows } = await query(
    `SELECT work_date::text AS d,
            COUNT(*) FILTER (WHERE status = 'present')::int AS present,
            COUNT(*) FILTER (WHERE status = 'late')::int AS late,
            COUNT(*) FILTER (WHERE status = 'half_day')::int AS half_day,
            COUNT(*) FILTER (WHERE status IN ('leave','unpaid_leave'))::int AS leave,
            COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
            COALESCE(SUM(overtime_minutes), 0)::int AS overtime
       FROM attendance WHERE work_date BETWEEN $1 AND $2 AND status NOT IN ('weekend','holiday') GROUP BY work_date ORDER BY work_date`,
    [from, to]);
  return { from, to, rows };
}

/** Month-to-date attendance rate and lateness per department. */
async function departments() {
  const { timezone: tz } = await getSettings();
  const { from } = monthRange(todayIn(tz).slice(0, 7));
  const { rows } = await query(
    `SELECT u.department,
            COUNT(*) FILTER (WHERE a.status IN ('present','late','half_day'))::int AS attended,
            COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent,
            COUNT(*) FILTER (WHERE a.late_minutes > 0)::int AS late,
            COALESCE(SUM(a.overtime_minutes), 0)::int AS overtime
       FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.work_date >= $1 AND a.status NOT IN ('weekend','holiday','leave','unpaid_leave') AND NOT a.off_day_work
      GROUP BY u.department ORDER BY u.department`, [from]);
  return rows.map((r) => ({ ...r, rate: r.attended + r.absent ? Math.round((r.attended / (r.attended + r.absent)) * 100) : null }));
}

async function recentPunches(limit = 12) {
  const { timezone: tz } = await getSettings();
  const { rows } = await query(
    `SELECT p.id, COALESCE(u.name, 'Unknown PIN ' || p.pin) AS name, p.pin, (p.user_id IS NULL) AS unknown, p.source,
            to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS at, d.name AS device
       FROM punch_logs p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN devices d ON d.id = p.device_id
      ORDER BY p.punched_at DESC LIMIT $2`, [tz, limit]);
  return rows;
}

async function deviceStatus() {
  const { rows } = await query(
    `SELECT id, name, serial_number, location, online, approved, active, last_seen FROM devices ORDER BY name`);
  return rows;
}

/** Self-service summary for Staff users. */
async function mine(userId) {
  const { timezone: tz } = await getSettings();
  const date = todayIn(tz);
  const { from } = monthRange(date.slice(0, 7));
  const [todayRow, month] = await Promise.all([
    query(`SELECT status, late_minutes, early_out_minutes, overtime_minutes, worked_minutes,
                  to_char(check_in AT TIME ZONE $3, 'HH24:MI') AS cin, to_char(check_out AT TIME ZONE $3, 'HH24:MI') AS cout
             FROM attendance WHERE user_id = $1 AND work_date = $2`, [userId, date, tz]),
    query(`SELECT COUNT(*) FILTER (WHERE status IN ('present','late','half_day'))::int AS present,
                  COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late,
                  COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
                  COUNT(*) FILTER (WHERE status IN ('leave','unpaid_leave'))::int AS leave,
                  COALESCE(SUM(overtime_minutes), 0)::int AS overtime,
                  COALESCE(SUM(worked_minutes), 0)::int AS worked
             FROM attendance WHERE user_id = $1 AND work_date >= $2 AND work_date <= $3`, [userId, from, date]),
  ]);
  return { date, today: todayRow.rows[0] || null, month: month.rows[0] };
}

module.exports = { today, trend, departments, recentPunches, deviceStatus, mine };
