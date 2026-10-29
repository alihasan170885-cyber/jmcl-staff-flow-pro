'use strict';
/**
 * Pure payroll maths for one employee and one month.
 *
 * daily rate        = base salary / scheduled working days in the full month
 * base pay          = daily rate x scheduled working days since joining (full base when employed all month)
 * absence deduction = daily rate x (absent days + unpaid leave days + 0.5 x half days)
 * late deduction    = daily rate x floor(late arrivals / late_count_per_day_deduction)   (0 disables)
 * overtime pay      = hourly rate x overtime hours x multiplier (separate multiplier for off-day work)
 * attendance bonus  = fixed amount when the employee has no absences, unpaid leave, half days or lates all month
 * provident fund    = pf_percent of base pay
 * income tax        = tax_rate_percent of (gross - tax_free_amount)
 */
const { round2 } = require('../utils/money');

const DEFAULT_RULES = {
  ot_multiplier: 1.5,
  off_day_ot_multiplier: 2,
  late_count_per_day_deduction: 3,
  perfect_attendance_bonus: 1000,
  pf_percent: 5,
  tax_free_amount: 25000,
  tax_rate_percent: 5,
};

function calcPayslip({ baseSalary, allowances = 0, workingDaysFull, workingDaysActual, stats, scheduledHoursPerDay, adjustments, rules }) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const s = { absentDays: 0, halfDays: 0, unpaidLeaveDays: 0, lateCount: 0, overtimeMinutes: 0, offDayOvertimeMinutes: 0, ...(stats || {}) };
  const adj = { bonus: 0, deduction: 0, ...(adjustments || {}) };

  const daily = workingDaysFull > 0 ? baseSalary / workingDaysFull : 0;
  const basePay = workingDaysActual >= workingDaysFull ? round2(baseSalary) : round2(daily * workingDaysActual);

  const unpaidDays = Math.min(s.absentDays + s.unpaidLeaveDays + s.halfDays * 0.5, workingDaysActual);
  const absenceDeduction = round2(daily * unpaidDays);

  const lateDays = r.late_count_per_day_deduction > 0 ? Math.floor(s.lateCount / r.late_count_per_day_deduction) : 0;
  const lateDeduction = round2(daily * lateDays);

  const hourly = scheduledHoursPerDay > 0 ? daily / scheduledHoursPerDay : 0;
  const overtimePay = round2(hourly * (s.overtimeMinutes / 60) * r.ot_multiplier + hourly * (s.offDayOvertimeMinutes / 60) * r.off_day_ot_multiplier);

  const perfect = workingDaysFull > 0 && workingDaysActual === workingDaysFull
    && s.absentDays === 0 && s.unpaidLeaveDays === 0 && s.halfDays === 0 && s.lateCount === 0;
  const attendanceBonus = perfect ? round2(r.perfect_attendance_bonus) : 0;

  const bonus = round2(adj.bonus + attendanceBonus);
  const gross = round2(basePay + allowances + overtimePay + bonus);
  const pf = round2(basePay * r.pf_percent / 100);
  const tax = round2(Math.max(0, gross - r.tax_free_amount) * r.tax_rate_percent / 100);
  const other = round2(adj.deduction);
  const totalDeductions = round2(absenceDeduction + lateDeduction + pf + tax + other);
  const net = Math.max(0, round2(gross - totalDeductions));

  return {
    base_pay: basePay, allowances: round2(allowances), overtime_pay: overtimePay, bonus, gross,
    absence_deduction: absenceDeduction, late_deduction: lateDeduction, pf_deduction: pf, tax_deduction: tax,
    other_deduction: other, total_deductions: totalDeductions, net_pay: net,
    breakdown: {
      dailyRate: round2(daily), hourlyRate: round2(hourly), workingDaysFull, workingDaysActual,
      absentDays: s.absentDays, halfDays: s.halfDays, unpaidLeaveDays: s.unpaidLeaveDays, lateCount: s.lateCount,
      lateDeductionDays: lateDays, overtimeMinutes: s.overtimeMinutes, offDayOvertimeMinutes: s.offDayOvertimeMinutes,
      attendanceBonus, manualBonus: round2(adj.bonus), manualDeduction: other, negativeNetClamped: gross - totalDeductions < 0,
      rules: r,
    },
  };
}

module.exports = { calcPayslip, DEFAULT_RULES };
