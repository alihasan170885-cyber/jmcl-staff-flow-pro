'use strict';
const { query, tx } = require('../db');
const { HttpError, bad, conflict, forbidden, notFound } = require('../utils/http');
const { eachDay, dow, todayIn } = require('../utils/time');
const { getSettings } = require('./settings');
const { rebuildRange } = require('./attendance');
const { notifyManagers, notifyUsers } = require('./notifications');

/** Create balance rows for every quota-tracked leave type for a user/year (idempotent). */
async function ensureBalances(userId, year, db = { query }) {
  await db.query(
    `INSERT INTO leave_balances (user_id, leave_type_id, year, allocated)
     SELECT $1, id, $2, annual_quota FROM leave_types WHERE active AND annual_quota IS NOT NULL
     ON CONFLICT DO NOTHING`, [userId, year]);
}

async function getBalances(userId, year) {
  await ensureBalances(userId, year);
  const { rows } = await query(
    `SELECT lt.id AS leave_type_id, lt.name, lt.paid, b.allocated, b.used,
            COALESCE((SELECT SUM(days) FROM leave_requests r
                       WHERE r.user_id = b.user_id AND r.leave_type_id = b.leave_type_id
                         AND r.status = 'pending' AND EXTRACT(YEAR FROM r.start_date) = b.year), 0) AS pending
       FROM leave_balances b JOIN leave_types lt ON lt.id = b.leave_type_id
      WHERE b.user_id = $1 AND b.year = $2 AND lt.active
      ORDER BY lt.id`, [userId, year]);
  return rows.map((r) => ({ ...r, remaining: Number((r.allocated - r.used).toFixed(1)), available: Number((r.allocated - r.used - r.pending).toFixed(1)) }));
}

/** Working days in [start, end] for this employee: excludes their weekly off days and company holidays. */
async function countWorkingDays(userId, start, end, db = { query }) {
  const [{ rows: u }, { rows: h }] = await Promise.all([
    db.query('SELECT s.weekly_off FROM users u LEFT JOIN shifts s ON s.id = u.shift_id WHERE u.id = $1', [userId]),
    db.query('SELECT date::text AS date FROM holidays WHERE date BETWEEN $1 AND $2', [start, end]),
  ]);
  const off = u[0]?.weekly_off || [];
  const holidays = new Set(h.map((x) => x.date));
  return eachDay(start, end).filter((d) => !off.includes(dow(d)) && !holidays.has(d)).length;
}

async function createRequest(user, { leaveTypeId, startDate, endDate, halfDay, reason }) {
  if (endDate < startDate) throw bad('End date must be on or after the start date');
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) throw bad('A request cannot span two calendar years — submit one request per year');
  if (halfDay && startDate !== endDate) throw bad('A half-day request must be for a single day');
  const year = Number(startDate.slice(0, 4));

  const { rows: [type] } = await query('SELECT * FROM leave_types WHERE id = $1 AND active', [leaveTypeId]);
  if (!type) throw bad('Unknown leave type');

  const working = await countWorkingDays(user.id, startDate, endDate);
  if (working === 0) throw bad('The selected dates are all weekly offs or holidays — nothing to request');
  const days = halfDay ? 0.5 : working;

  const { rows: overlap } = await query(
    `SELECT id FROM leave_requests WHERE user_id = $1 AND status IN ('pending','approved')
        AND start_date <= $3 AND end_date >= $2 LIMIT 1`, [user.id, startDate, endDate]);
  if (overlap.length) throw conflict('You already have a pending or approved leave request overlapping these dates');

  if (type.annual_quota !== null) {
    const balances = await getBalances(user.id, year);
    const b = balances.find((x) => x.leave_type_id === type.id);
    if (!b || b.available < days) {
      throw conflict(`Not enough ${type.name} balance: ${b ? b.available : 0} day(s) available, ${days} requested`);
    }
  }

  const { rows: [req] } = await query(
    `INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, half_day, days, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, days`,
    [user.id, type.id, startDate, endDate, !!halfDay, days, reason || '']);

  await notifyManagers({
    type: 'leave', severity: 'info', title: `Leave request: ${user.name}`,
    body: `${type.name}, ${startDate}${startDate !== endDate ? ' to ' + endDate : ''} (${days} day${days === 1 ? '' : 's'})`,
    url: '/leave', dedupe: `leave-req:${req.id}`,
  });
  return req;
}

/** Approve or reject. Approval deducts the balance atomically and refuses to overdraw it. */
async function review(requestId, reviewer, decision, note) {
  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.annual_quota, u.name AS user_name
         FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN users u ON u.id = lr.user_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [requestId]);
    if (!r) throw notFound('Leave request not found');
    if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
    if (r.user_id === reviewer.id) throw forbidden('You cannot review your own leave request');

    if (decision === 'approved' && r.annual_quota !== null) {
      const year = Number(r.start_date.slice(0, 4));
      await ensureBalances(r.user_id, year, db);
      const { rows: [b] } = await db.query(
        `SELECT allocated, used FROM leave_balances WHERE user_id = $1 AND leave_type_id = $2 AND year = $3 FOR UPDATE`,
        [r.user_id, r.leave_type_id, year]);
      if (!b || b.allocated - b.used < r.days) {
        throw conflict(`Insufficient ${r.type_name} balance (${b ? b.allocated - b.used : 0} left, ${r.days} requested)`);
      }
      await db.query(
        `UPDATE leave_balances SET used = used + $4 WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [r.user_id, r.leave_type_id, year, r.days]);
    }
    await db.query(
      `UPDATE leave_requests SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
      [requestId, decision, reviewer.id, note || null]);
    return r;
  });

  if (decision === 'approved') await rebuildRange(result.start_date, result.end_date, { userId: result.user_id });
  await notifyUsers([result.user_id], {
    type: 'leave', severity: decision === 'approved' ? 'info' : 'warning',
    title: `Leave ${decision}`, body: `${result.type_name}: ${result.start_date}${result.start_date !== result.end_date ? ' to ' + result.end_date : ''}${note ? ' — ' + note : ''}`,
    url: '/leave', dedupe: `leave-decision:${requestId}`,
  });
  return { id: requestId, status: decision };
}

/** Owner can cancel a pending request; HR/Admin can also cancel an approved one (balance is restored). */
async function cancel(requestId, actor) {
  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.annual_quota FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [requestId]);
    if (!r) throw notFound('Leave request not found');
    const isOwner = r.user_id === actor.id;
    const isManager = ['admin', 'hr'].includes(actor.role);
    if (!isOwner && !isManager) throw forbidden();
    if (r.status === 'approved' && !isManager) throw forbidden('Only HR or Admin can cancel an approved leave');
    if (!['pending', 'approved'].includes(r.status)) throw conflict(`This request is already ${r.status}`);
    if (r.status === 'approved' && r.annual_quota !== null) {
      await db.query(
        `UPDATE leave_balances SET used = GREATEST(0, used - $4) WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [r.user_id, r.leave_type_id, Number(r.start_date.slice(0, 4)), r.days]);
    }
    await db.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1`, [requestId]);
    return r;
  });
  if (result.status === 'approved') await rebuildRange(result.start_date, result.end_date, { userId: result.user_id });
  return { id: requestId, status: 'cancelled' };
}

module.exports = { ensureBalances, getBalances, countWorkingDays, createRequest, review, cancel };
