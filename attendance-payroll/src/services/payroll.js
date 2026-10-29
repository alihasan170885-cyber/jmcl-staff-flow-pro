'use strict';
const { query, tx } = require('../db');
const { conflict, notFound, bad } = require('../utils/http');
const { eachDay, dow, monthRange, todayIn, toMin } = require('../utils/time');
const { getSettings } = require('./settings');
const { rebuildRange } = require('./attendance');
const { countWorkingDays } = require('./leave');
const { calcPayslip } = require('../logic/payrollCalc');

/**
 * Generate (or regenerate) the draft payroll run for a month from attendance data.
 * Finalised runs are immutable. A run for a month that has not finished yet is marked `partial`
 * and cannot be finalised.
 */
async function generateRun(month, actor) {
  const settings = await getSettings();
  const { from, to } = monthRange(month);
  const today = todayIn(settings.timezone);
  if (from > today) throw bad('That month has not started yet');

  const { rows: [existing] } = await query('SELECT id, status FROM payroll_runs WHERE month = $1', [month]);
  if (existing?.status === 'finalized') throw conflict(`Payroll for ${month} is finalised and cannot be regenerated`);

  await rebuildRange(from, to); // materialise absences etc. so numbers reflect the latest punches

  const [users, hol, stats, adj] = await Promise.all([
    query(`SELECT u.id, u.name, u.base_salary, u.allowances, u.join_date::text AS join_date,
                  s.start_time::text AS st, s.end_time::text AS et, s.break_minutes, s.weekly_off
             FROM users u JOIN shifts s ON s.id = u.shift_id
            WHERE u.active AND u.join_date <= $1 ORDER BY u.name`, [to]),
    query('SELECT date::text AS date FROM holidays WHERE date BETWEEN $1 AND $2', [from, to]),
    query(`SELECT user_id,
                  COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
                  COUNT(*) FILTER (WHERE status = 'half_day')::int AS half,
                  COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late,
                  COALESCE(SUM(overtime_minutes) FILTER (WHERE NOT off_day_work), 0)::int AS ot,
                  COALESCE(SUM(overtime_minutes) FILTER (WHERE off_day_work), 0)::int AS ot_off
             FROM attendance WHERE work_date BETWEEN $1 AND $2 GROUP BY user_id`, [from, to]),
    query(`SELECT user_id, kind, SUM(amount) AS total FROM adjustments WHERE month = $1 GROUP BY user_id, kind`, [month]),
  ]);

  const holidays = new Set(hol.rows.map((h) => h.date));
  const statsBy = new Map(stats.rows.map((s) => [s.user_id, s]));
  const adjBy = new Map();
  for (const a of adj.rows) {
    if (!adjBy.has(a.user_id)) adjBy.set(a.user_id, { bonus: 0, deduction: 0 });
    adjBy.get(a.user_id)[a.kind] = a.total;
  }

  const slips = [];
  for (const u of users.rows) {
    const days = eachDay(from, to).filter((d) => !u.weekly_off.includes(dow(d)) && !holidays.has(d));
    const workingDaysFull = days.length;
    const workingDaysActual = days.filter((d) => d >= u.join_date).length;

    // Unpaid leave is computed from approved requests so half-day requests count as 0.5.
    const { rows: unpaid } = await query(
      `SELECT lr.start_date::text AS s, lr.end_date::text AS e, lr.half_day
         FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.user_id = $1 AND lr.status = 'approved' AND NOT lt.paid AND lr.start_date <= $3 AND lr.end_date >= $2`,
      [u.id, from, to]);
    let unpaidLeaveDays = 0;
    for (const r of unpaid) {
      const s = r.s > from ? r.s : from;
      const e = r.e < to ? r.e : to;
      unpaidLeaveDays += (await countWorkingDays(u.id, s, e)) * (r.half_day ? 0.5 : 1);
    }

    const st = statsBy.get(u.id) || {};
    const slip = calcPayslip({
      baseSalary: u.base_salary, allowances: u.allowances, workingDaysFull, workingDaysActual,
      scheduledHoursPerDay: (toMin(u.et) - toMin(u.st) - u.break_minutes) / 60,
      stats: {
        absentDays: st.absent || 0, halfDays: st.half || 0, lateCount: st.late || 0, unpaidLeaveDays,
        overtimeMinutes: st.ot || 0, offDayOvertimeMinutes: st.ot_off || 0,
      },
      adjustments: adjBy.get(u.id), rules: settings.payroll,
    });
    slips.push({ userId: u.id, ...slip });
  }

  const partial = today <= to;
  const runId = await tx(async (db) => {
    const { rows: [run] } = await db.query(
      `INSERT INTO payroll_runs (month, status, partial, generated_by, generated_at)
       VALUES ($1, 'draft', $2, $3, now())
       ON CONFLICT (month) DO UPDATE SET partial = EXCLUDED.partial, generated_by = EXCLUDED.generated_by, generated_at = now()
       RETURNING id`, [month, partial, actor?.id || null]);
    await db.query('DELETE FROM payslips WHERE run_id = $1', [run.id]);
    for (const s of slips) {
      await db.query(
        `INSERT INTO payslips (run_id, user_id, base_pay, allowances, overtime_pay, bonus, gross, absence_deduction,
                               late_deduction, pf_deduction, tax_deduction, other_deduction, total_deductions, net_pay, breakdown)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [run.id, s.userId, s.base_pay, s.allowances, s.overtime_pay, s.bonus, s.gross, s.absence_deduction, s.late_deduction,
          s.pf_deduction, s.tax_deduction, s.other_deduction, s.total_deductions, s.net_pay, JSON.stringify(s.breakdown)]);
    }
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'generate','payroll_run',$2,$3::jsonb)`,
      [actor?.id || null, month, JSON.stringify({ employees: slips.length, partial })]);
    return run.id;
  });
  return { runId, month, employees: slips.length, partial };
}

async function finalizeRun(month, actor) {
  const settings = await getSettings();
  const { to } = monthRange(month);
  const { rows: [run] } = await query('SELECT * FROM payroll_runs WHERE month = $1', [month]);
  if (!run) throw notFound('Generate payroll for this month first');
  if (run.status === 'finalized') throw conflict('Already finalised');
  if (todayIn(settings.timezone) <= to) throw conflict('The month has not finished yet. Finalise after the last day.');
  await query(`UPDATE payroll_runs SET status = 'finalized', finalized_by = $2, finalized_at = now() WHERE id = $1`, [run.id, actor.id]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'finalize','payroll_run',$2)`, [actor.id, month]);
  return { month, status: 'finalized' };
}

async function getRun(month) {
  const { rows: [run] } = await query(
    `SELECT r.*, g.name AS generated_by_name, f.name AS finalized_by_name
       FROM payroll_runs r LEFT JOIN users g ON g.id = r.generated_by LEFT JOIN users f ON f.id = r.finalized_by
      WHERE r.month = $1`, [month]);
  if (!run) return null;
  const { rows: slips } = await query(
    `SELECT p.*, u.name, u.employee_code, u.department, u.designation
       FROM payslips p JOIN users u ON u.id = p.user_id WHERE p.run_id = $1 ORDER BY u.name`, [run.id]);
  const totals = slips.reduce((t, s) => ({
    gross: t.gross + s.gross, deductions: t.deductions + s.total_deductions, net: t.net + s.net_pay, overtime: t.overtime + s.overtime_pay,
  }), { gross: 0, deductions: 0, net: 0, overtime: 0 });
  return { run, slips, totals };
}

async function getPayslip(id) {
  const { rows: [p] } = await query(
    `SELECT p.*, r.month, r.status AS run_status, u.name, u.employee_code, u.department, u.designation
       FROM payslips p JOIN payroll_runs r ON r.id = p.run_id JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [id]);
  return p || null;
}

module.exports = { generateRun, finalizeRun, getRun, getPayslip };
