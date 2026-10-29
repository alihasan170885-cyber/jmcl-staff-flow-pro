'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, forbidden, notFound, bad } = require('../utils/http');
const { requireRole, isManager } = require('../middleware/auth');
const payroll = require('../services/payroll');
const { payslipPdf } = require('../services/reports');
const { z, month, id, money } = require('./schemas');

/* ---------- self-service: staff only ever see their own, finalised payslips ---------- */
router.get('/my-payslips', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, r.month, p.gross, p.total_deductions, p.net_pay
       FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
      WHERE p.user_id = $1 AND r.status = 'finalized' ORDER BY r.month DESC`, [req.user.id]);
  res.json({ payslips: rows });
}));

router.get('/payslips/:id', wrap(async (req, res) => {
  const p = await payroll.getPayslip(parse(id, req.params.id));
  // Same response for "missing" and "not yours" so ids cannot be probed.
  if (!p || (!isManager(req.user) && (p.user_id !== req.user.id || p.run_status !== 'finalized'))) throw notFound('Payslip not found');
  res.json({ payslip: p });
}));

router.get('/payslips/:id/pdf', wrap(async (req, res) => {
  const p = await payroll.getPayslip(parse(id, req.params.id));
  if (!p || (!isManager(req.user) && (p.user_id !== req.user.id || p.run_status !== 'finalized'))) throw notFound('Payslip not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.month}-${p.employee_code}.pdf"`);
  await payslipPdf(p, res);
}));

/* ---------- management ---------- */
router.use(requireRole('admin', 'hr'));

router.get('/runs', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT r.month, r.status, r.partial, r.generated_at, r.finalized_at, COUNT(p.id)::int AS employees, COALESCE(SUM(p.net_pay), 0) AS net_total
       FROM payroll_runs r LEFT JOIN payslips p ON p.run_id = r.id GROUP BY r.id ORDER BY r.month DESC LIMIT 24`);
  res.json({ runs: rows });
}));

router.get('/runs/:month', wrap(async (req, res) => {
  const data = await payroll.getRun(parse(month, req.params.month));
  if (!data) throw notFound('No payroll generated for this month yet');
  res.json(data);
}));

router.post('/runs/:month/generate', wrap(async (req, res) => {
  res.json(await payroll.generateRun(parse(month, req.params.month), req.user));
}));

// Separation of duties: HR prepares payroll, only an Admin can lock it.
router.post('/runs/:month/finalize', requireRole('admin'), wrap(async (req, res) => {
  res.json(await payroll.finalizeRun(parse(month, req.params.month), req.user));
}));

/* ---------- bonuses & manual deductions ---------- */
router.get('/adjustments', wrap(async (req, res) => {
  const m = parse(month, req.query.month);
  const { rows } = await query(
    `SELECT a.id, a.user_id, u.name, a.month, a.kind, a.amount, a.note, c.name AS created_by
       FROM adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.created_by
      WHERE a.month = $1 ORDER BY u.name, a.id`, [m]);
  res.json({ adjustments: rows });
}));

async function assertDraft(m) {
  const { rows: [r] } = await query('SELECT status FROM payroll_runs WHERE month = $1', [m]);
  if (r?.status === 'finalized') throw forbidden(`Payroll for ${m} is finalised; adjustments are locked`);
}

router.post('/adjustments', wrap(async (req, res) => {
  const b = parse(z.object({
    userId: id, month, kind: z.enum(['bonus', 'deduction']), amount: money.refine((n) => n > 0, 'must be greater than zero'),
    note: z.string().trim().min(2, 'is required').max(200),
  }), req.body);
  await assertDraft(b.month);
  const { rows: [r] } = await query(
    `INSERT INTO adjustments (user_id, month, kind, amount, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [b.userId, b.month, b.kind, b.amount, b.note, req.user.id]);
  res.status(201).json({ id: r.id, note: 'Regenerate the payroll run to apply this.' });
}));

router.delete('/adjustments/:id', wrap(async (req, res) => {
  const aid = parse(id, req.params.id);
  const { rows: [a] } = await query('SELECT month FROM adjustments WHERE id = $1', [aid]);
  if (!a) throw notFound('Adjustment not found');
  await assertDraft(a.month);
  await query('DELETE FROM adjustments WHERE id = $1', [aid]);
  res.json({ ok: true });
}));

module.exports = router;
