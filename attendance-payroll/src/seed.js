'use strict';
/**
 * Reference data (shifts, leave types, holidays) and optional demo data.
 * Demo data is deterministic: the same employees and a reproducible 3-month punch history for the current date.
 */
const bcrypt = require('bcryptjs');
const { query, tx } = require('./db');
const { getSettings } = require('./services/settings');
const { ensureBalances } = require('./services/leave');
const { rebuildRange } = require('./services/attendance');
const payroll = require('./services/payroll');
const { addDays, dow, eachDay, monthRange, prevMonth, todayIn, nowMinIn, toMin } = require('./utils/time');

const DEMO_PASSWORD = 'Demo@12345';

async function seedReference() {
  const { rows: [s] } = await query('SELECT COUNT(*)::int AS n FROM shifts');
  if (!s.n) {
    await query(`INSERT INTO shifts (name, start_time, end_time, break_minutes, grace_minutes, early_out_grace_minutes, overtime_after_minutes, weekly_off) VALUES
      ('General (09:00–18:00)', '09:00', '18:00', 60, 10, 10, 30, '{5}'),
      ('Early (07:00–15:00)',   '07:00', '15:00', 45, 10, 10, 30, '{5}')`);
  }
  const { rows: [l] } = await query('SELECT COUNT(*)::int AS n FROM leave_types');
  if (!l.n) {
    await query(`INSERT INTO leave_types (name, annual_quota, paid) VALUES
      ('Annual leave', 14, true), ('Sick leave', 10, true), ('Casual leave', 8, true), ('Unpaid leave', NULL, false)`);
  }
  const { rows: [h] } = await query('SELECT COUNT(*)::int AS n FROM holidays');
  if (!h.n) {
    await query(`INSERT INTO holidays (date, name) VALUES
      ('2026-12-16', 'Victory Day'), ('2026-12-25', 'Christmas Day'), ('2027-02-21', 'International Mother Language Day'), ('2027-03-26', 'Independence Day')
      ON CONFLICT DO NOTHING`);
  }
}

// Small deterministic PRNG so demo data is reproducible.
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const PEOPLE = [
  // code, name, email, role, department, designation, salary, allowances, shift(0=general,1=early), reliability(0 best..1 worst)
  ['E0001', 'Rahim Chowdhury', 'admin@company.test', 'admin', 'Management', 'Managing Director', 150000, 20000, 0, 0.05],
  ['E0002', 'Nusrat Jahan', 'hr@company.test', 'hr', 'Human Resources', 'HR Manager', 85000, 10000, 0, 0.1],
  ['E0003', 'Tanvir Ahmed', 'tanvir@company.test', 'hr', 'Human Resources', 'HR Executive', 52000, 6000, 0, 0.2],
  ['E0004', 'Sadia Islam', 'staff@company.test', 'staff', 'Engineering', 'Software Engineer', 78000, 8000, 0, 0.15],
  ['E0005', 'Farhan Kabir', 'farhan@company.test', 'staff', 'Engineering', 'Senior Engineer', 110000, 12000, 0, 0.2],
  ['E0006', 'Mim Akter', 'mim@company.test', 'staff', 'Engineering', 'QA Engineer', 64000, 7000, 0, 0.5],
  ['E0007', 'Rafiq Uddin', 'rafiq@company.test', 'staff', 'Engineering', 'DevOps Engineer', 95000, 10000, 0, 0.3],
  ['E0008', 'Tasnim Haque', 'tasnim@company.test', 'staff', 'Finance', 'Accountant', 60000, 6000, 0, 0.1],
  ['E0009', 'Sohel Rana', 'sohel@company.test', 'staff', 'Finance', 'Finance Officer', 54000, 5000, 0, 0.7],
  ['E0010', 'Lamia Sultana', 'lamia@company.test', 'staff', 'Sales', 'Sales Executive', 48000, 5000, 0, 0.4],
  ['E0011', 'Arif Mahmud', 'arif@company.test', 'staff', 'Sales', 'Sales Manager', 90000, 9000, 0, 0.25],
  ['E0012', 'Nabila Khan', 'nabila@company.test', 'staff', 'Sales', 'Sales Executive', 46000, 5000, 0, 0.6],
  ['E0013', 'Jahid Hasan', 'jahid@company.test', 'staff', 'Operations', 'Floor Supervisor', 42000, 4000, 1, 0.3],
  ['E0014', 'Shirin Akter', 'shirin@company.test', 'staff', 'Operations', 'Operator', 30000, 3000, 1, 0.2],
  ['E0015', 'Mehedi Hasan', 'mehedi@company.test', 'staff', 'Operations', 'Operator', 30000, 3000, 1, 0.8],
  ['E0016', 'Fariha Rahman', 'fariha@company.test', 'staff', 'Operations', 'Quality Inspector', 34000, 3500, 1, 0.35],
  ['E0017', 'Kamal Hossain', 'kamal@company.test', 'staff', 'Operations', 'Store Keeper', 32000, 3000, 1, 0.45],
  ['E0018', 'Ayesha Siddika', 'ayesha@company.test', 'staff', 'Finance', 'Payroll Officer', 50000, 5000, 0, 0.15],
  ['E0019', 'Rubel Mia', 'rubel@company.test', 'staff', 'Sales', 'Sales Executive', 44000, 4000, 0, 0.3], // joins mid-way through last month
];

async function seedDemo() {
  console.log('[seed] creating demo data (this takes a few seconds)…');
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const nowMin = nowMinIn(tz);
  const thisMonth = today.slice(0, 7);
  const m1 = prevMonth(thisMonth);
  const m2 = prevMonth(m1);
  const from = monthRange(m2).from;
  const rng = mulberry32(20261028);
  const rand = (a, b) => a + Math.floor(rng() * (b - a + 1));

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const { rows: shifts } = await query(`SELECT id, start_time::text AS st, end_time::text AS et, weekly_off FROM shifts ORDER BY id`);

  // Demo holiday inside last month so holiday handling is visible in history.
  const demoHoliday = `${m1}-14`;
  await query(`INSERT INTO holidays (date, name) VALUES ($1, 'Company Foundation Day (demo)') ON CONFLICT DO NOTHING`, [demoHoliday]);
  const { rows: hols } = await query('SELECT date::text AS date FROM holidays');
  const holidaySet = new Set(hols.map((h) => h.date));

  // Users
  const users = [];
  for (const [i, p] of PEOPLE.entries()) {
    const [code, name, email, role, dept, desig, salary, allow, shiftIdx, rel] = p;
    const join = code === 'E0019' ? `${m1}-10` : `2024-0${1 + (i % 9)}-15`;
    const { rows: [u] } = await query(
      `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id, base_salary, allowances, join_date, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false) RETURNING id`,
      [code, String(1000 + i + 1), name, email, hash, role, dept, desig, shifts[shiftIdx].id, salary, allow, join]);
    users.push({ id: u.id, code, name, pin: String(1000 + i + 1), join, rel, shift: shifts[shiftIdx], role });
    await ensureBalances(u.id, Number(thisMonth.slice(0, 4)));
  }
  const byCode = Object.fromEntries(users.map((u) => [u.code, u]));

  // Device
  const { rows: [dev] } = await query(
    `INSERT INTO devices (name, serial_number, model, location, protocol, ip_address, port, approved, active, online, last_seen)
     VALUES ('Main entrance — uFace800', 'DEMO-UFACE800-001', 'ZKTeco uFace800', 'Head office, ground floor', 'adms', '192.168.1.201', 4370, true, true, true, now())
     RETURNING id, serial_number`);

  // Leave: a couple of approved periods in the past, some pending, one rejected.
  const types = Object.fromEntries((await query('SELECT id, name FROM leave_types')).rows.map((t) => [t.name, t.id]));
  const leaveDays = new Map(); // `${uid}|${date}` -> true
  const addLeave = async (u, type, s, e, status, reason, days, half = false) => {
    await query(`INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, half_day, days, reason, status, reviewed_by, reviewed_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8 = 'pending' THEN NULL ELSE now() END)`,
      [u.id, types[type], s, e, half, days, reason, status, status === 'pending' ? null : byCode.E0002.id]);
    if (status === 'approved') {
      if (type !== 'Unpaid leave') {
        await query('UPDATE leave_balances SET used = used + $4 WHERE user_id = $1 AND leave_type_id = $2 AND year = $3', [u.id, types[type], Number(s.slice(0, 4)), days]);
      }
      for (const d of eachDay(s, e)) leaveDays.set(`${u.id}|${d}`, true);
    }
  };
  const workdays = (s, e, off) => eachDay(s, e).filter((d) => !off.includes(dow(d)) && !holidaySet.has(d));
  const lv1 = [addDays(today, -23), addDays(today, -22)];
  await addLeave(byCode.E0005, 'Sick leave', lv1[0], lv1[1], 'approved', 'Fever', workdays(lv1[0], lv1[1], [5]).length);
  const lv2 = [addDays(today, -40), addDays(today, -38)];
  await addLeave(byCode.E0010, 'Annual leave', lv2[0], lv2[1], 'approved', 'Family trip', workdays(lv2[0], lv2[1], [5]).length);
  const lv3 = [addDays(today, -30), addDays(today, -30)];
  await addLeave(byCode.E0012, 'Unpaid leave', lv3[0], lv3[1], 'approved', 'Personal errand', workdays(lv3[0], lv3[1], [5]).length || 1);
  await addLeave(byCode.E0004, 'Casual leave', addDays(today, 6), addDays(today, 7), 'pending', 'Family function', workdays(addDays(today, 6), addDays(today, 7), [5]).length || 1);
  await addLeave(byCode.E0016, 'Sick leave', addDays(today, 2), addDays(today, 2), 'pending', 'Dental appointment', 1, false);
  await addLeave(byCode.E0009, 'Annual leave', addDays(today, -12), addDays(today, -11), 'rejected', 'Short break during month-end close', 2);

  // Bonus and deduction adjustments for last month.
  await query(`INSERT INTO adjustments (user_id, month, kind, amount, note, created_by) VALUES
    ($1,$3,'bonus',5000,'Project delivery bonus',$5), ($2,$3,'bonus',3000,'Quarterly performance bonus',$5), ($4,$3,'deduction',2000,'Advance recovery',$5)`,
    [byCode.E0005.id, byCode.E0011.id, m1, byCode.E0014.id, byCode.E0002.id]);

  // Three months of device punches.
  const pins = [], uids = [], locals = [], states = [];
  const punch = (u, date, min, state) => { pins.push(u.pin); uids.push(u.id); locals.push(`${date} ${fmt(min)}:${String(rand(0, 59)).padStart(2, '0')}`); states.push(state); };
  for (const u of users) {
    const lateProb = 0.03 + 0.25 * u.rel, absentProb = 0.01 + 0.05 * u.rel, otProb = 0.1 + 0.25 * (1 - u.rel);
    const start = toMin(u.shift.st), end = toMin(u.shift.et);
    for (const date of eachDay(from, today)) {
      if (date < u.join) continue;
      const off = u.shift.weekly_off.includes(dow(date)) || holidaySet.has(date);
      if (off) {
        if (!holidaySet.has(date) && u.code === 'E0007' && rng() < 0.12) { punch(u, date, 10 * 60 + rand(0, 30), 4); punch(u, date, 14 * 60 + rand(0, 40), 5); } // off-day work
        continue;
      }
      if (leaveDays.has(`${u.id}|${date}`) || (u.role !== 'admin' && rng() < absentProb)) continue;

      const late = rng() < lateProb;
      const arrive = late ? start + rand(11, 70) : start + rand(-25, 8);
      if (date === today && arrive > nowMin) continue;                       // not in yet
      punch(u, date, Math.max(0, arrive), 0);
      if (rng() < 0.05) punch(u, date, Math.max(0, arrive), 0);               // double tap on the reader (deduplicated by the gap rule)

      let leave = end + rand(-8, 12);
      const r = rng();
      if (r < otProb) leave = end + rand(40, 150);
      else if (r > 0.96) leave = end - rand(25, 90);                          // early out
      if (date === today) { if (leave > nowMin) continue; }
      else if (rng() < 0.015) continue;                                       // forgot to check out
      punch(u, date, Math.min(23 * 60 + 50, leave), 1);
    }
  }
  for (let i = 0; i < pins.length; i += 5000) {
    await query(
      `INSERT INTO punch_logs (device_id, device_sn, pin, user_id, punched_at, state, verify, source)
       SELECT $1, $2, x.pin, x.uid, (x.local::timestamp AT TIME ZONE $3), x.state, 15, 'simulator'
         FROM unnest($4::text[], $5::int[], $6::text[], $7::int[]) AS x(pin, uid, local, state)
       ON CONFLICT DO NOTHING`,
      [dev.id, dev.serial_number, tz, pins.slice(i, i + 5000), uids.slice(i, i + 5000), locals.slice(i, i + 5000), states.slice(i, i + 5000)]);
  }
  console.log(`[seed] ${pins.length} punches inserted`);

  await rebuildRange(from, today);

  // Payroll history: two months back is finalised (staff can open payslips), last month is left as a draft for the demo.
  const admin = byCode.E0001;
  await payroll.generateRun(m2, admin);
  await payroll.finalizeRun(m2, admin);
  await payroll.generateRun(m1, byCode.E0002);

  console.log('[seed] done. Demo logins (password for all: %s):', DEMO_PASSWORD);
  console.log('         admin@company.test   (Admin)\n         hr@company.test      (HR)\n         staff@company.test   (Staff)');
}

module.exports = { seedReference, seedDemo, DEMO_PASSWORD };
