'use strict';
// Dependency-free unit tests: `node tests/unit.test.js`
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDay } = require('../src/logic/attendanceRules');
const { calcPayslip } = require('../src/logic/payrollCalc');
const { parseAttLog, handshakeResponse } = require('../src/logic/adms');
const T = require('../src/utils/time');

const shift = {
  id: 1, start_time: '09:00:00', end_time: '18:00:00', break_minutes: 60, grace_minutes: 10,
  early_out_grace_minutes: 10, overtime_after_minutes: 30, weekly_off: [5],
};
// 2026-10-26 is a Monday, 2026-10-30 is a Friday (weekly off).
const mk = (date, times, extra = {}) => computeDay({
  date, today: '2026-11-02', nowMin: 600, user: { join_date: '2026-01-01' }, shift,
  punches: times.map((t) => ({ t, at: `${date}T${t}` })), holiday: false, leave: null, ...extra,
});

test('on-time full day', () => {
  const r = mk('2026-10-26', ['08:55:00', '18:05:00']);
  assert.equal(r.status, 'present');
  assert.equal(r.late_minutes, 0);
  assert.equal(r.early_out_minutes, 0);
  assert.equal(r.overtime_minutes, 0);
  assert.equal(r.worked_minutes, 490); // 08:55 -> 18:05 = 550 min, minus 60 min break
});

test('late beyond grace is measured from shift start', () => {
  const r = mk('2026-10-26', ['09:25:00', '18:00:00']);
  assert.equal(r.status, 'late');
  assert.equal(r.late_minutes, 25);
});

test('within grace is not late', () => {
  assert.equal(mk('2026-10-26', ['09:10:00', '18:00:00']).late_minutes, 0);
  assert.equal(mk('2026-10-26', ['09:11:00', '18:00:00']).late_minutes, 11);
});

test('early out and overtime thresholds', () => {
  assert.equal(mk('2026-10-26', ['09:00:00', '17:30:00']).early_out_minutes, 30);
  assert.equal(mk('2026-10-26', ['09:00:00', '17:55:00']).early_out_minutes, 0);
  assert.equal(mk('2026-10-26', ['09:00:00', '18:20:00']).overtime_minutes, 0);   // under 30 min threshold
  assert.equal(mk('2026-10-26', ['09:00:00', '19:30:00']).overtime_minutes, 90);
  assert.equal(mk('2026-10-26', ['09:00:00', '23:30:00']).overtime_minutes, 240); // capped
});

test('single punch: missing checkout once the day is over', () => {
  const r = mk('2026-10-26', ['09:02:00']);
  assert.equal(r.check_out, null);
  assert.equal(r.missing_checkout, true);
  const open = mk('2026-11-02', ['09:02:00'], { nowMin: 12 * 60 });
  assert.equal(open.missing_checkout, false);
});

test('duplicate punches within minimum gap do not create a checkout', () => {
  const r = mk('2026-10-26', ['09:00:00', '09:02:00']);
  assert.equal(r.check_out, null);
});

test('half day when worked time below threshold', () => {
  assert.equal(mk('2026-10-26', ['09:00:00', '12:00:00']).status, 'half_day');
});

test('absent only after the day/shift is over', () => {
  assert.equal(mk('2026-10-26', []).status, 'absent');
  assert.equal(mk('2026-11-02', [], { nowMin: 10 * 60 }), null);
  assert.equal(mk('2026-11-02', [], { nowMin: 18 * 60 + 1 }).status, 'absent');
});

test('weekly off, holiday, leave', () => {
  assert.equal(mk('2026-10-30', []).status, 'weekend');
  assert.equal(mk('2026-10-26', [], { holiday: true }).status, 'holiday');
  assert.equal(mk('2026-10-26', [], { leave: { paid: true } }).status, 'leave');
  assert.equal(mk('2026-10-26', [], { leave: { paid: false } }).status, 'unpaid_leave');
});

test('working on an off day counts all time as overtime', () => {
  const r = mk('2026-10-30', ['10:00:00', '14:00:00']);
  assert.equal(r.off_day_work, true);
  assert.equal(r.overtime_minutes, 240);
  assert.equal(r.late_minutes, 0);
});

test('future dates and pre-join dates produce no row', () => {
  assert.equal(mk('2026-11-03', []), null);
  assert.equal(mk('2026-10-26', [], { user: { join_date: '2026-10-27' } }), null);
});

test('payroll: full attendance earns bonus, pf and tax', () => {
  const p = calcPayslip({
    baseSalary: 60000, allowances: 5000, workingDaysFull: 26, workingDaysActual: 26,
    stats: {}, scheduledHoursPerDay: 8, rules: { perfect_attendance_bonus: 1000, tax_free_amount: 25000, tax_rate_percent: 5, pf_percent: 5 },
  });
  assert.equal(p.base_pay, 60000);
  assert.equal(p.bonus, 1000);
  assert.equal(p.gross, 66000);
  assert.equal(p.pf_deduction, 3000);
  assert.equal(p.tax_deduction, 2050);
  assert.equal(p.net_pay, 66000 - 3000 - 2050);
});

test('payroll: absence, lates and overtime', () => {
  const p = calcPayslip({
    baseSalary: 26000, allowances: 0, workingDaysFull: 26, workingDaysActual: 26,
    stats: { absentDays: 2, halfDays: 1, lateCount: 7, overtimeMinutes: 120, offDayOvertimeMinutes: 60 },
    scheduledHoursPerDay: 8, rules: { tax_free_amount: 1e9, pf_percent: 0 },
  });
  // daily = 1000, hourly = 125
  assert.equal(p.absence_deduction, 2500);   // 2.5 days
  assert.equal(p.late_deduction, 2000);      // floor(7/3)=2 days
  assert.equal(p.overtime_pay, 125 * 2 * 1.5 + 125 * 1 * 2);
  assert.equal(p.bonus, 0);
});

test('payroll: mid-month joiner is prorated; net never negative', () => {
  const p = calcPayslip({
    baseSalary: 26000, workingDaysFull: 26, workingDaysActual: 13, stats: {}, scheduledHoursPerDay: 8,
    adjustments: { deduction: 99999 }, rules: { pf_percent: 0, tax_free_amount: 1e9 },
  });
  assert.equal(p.base_pay, 13000);
  assert.equal(p.net_pay, 0);
  assert.equal(p.breakdown.negativeNetClamped, true);
});

test('ADMS ATTLOG parsing', () => {
  const body = '1001\t2026-10-26 09:02:11\t0\t1\t0\t0\r\n1002\t2026-10-26 18:30:00\t1\t15\n\ngarbage line\n1003\t2026-13-45 99:00:00\t0\t1';
  const { records, rejected } = parseAttLog(body);
  assert.equal(records.length, 2);
  assert.equal(rejected, 2);
  assert.deepEqual(records[0], { pin: '1001', local: '2026-10-26 09:02:11', state: 0, verify: 1, workcode: '0' });
  assert.equal(records[1].verify, 15);
});

test('ADMS handshake response', () => {
  const r = handshakeResponse('SN123', null);
  assert.match(r, /^GET OPTION FROM: SN123\nATTLOGSTAMP=None\n/);
});

test('date helpers', () => {
  assert.equal(T.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(T.dow('2026-10-26'), 1);
  assert.deepEqual(T.monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(T.prevMonth('2026-01'), '2025-12');
  assert.equal(T.isDate('2026-02-30'), false);
  assert.equal(T.toMin('09:30:15'), 570);
  assert.match(T.todayIn('Asia/Dhaka'), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(T.nowMinIn('Asia/Dhaka') >= 0);
});
