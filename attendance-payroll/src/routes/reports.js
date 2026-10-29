'use strict';
const router = require('express').Router();
const { wrap, parse, bad } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { REPORT_TYPES, buildReport, toXlsx, toPdf } = require('../services/reports');
const { getSettings } = require('../services/settings');
const { addDays, todayIn, diffDays } = require('../utils/time');
const { z, date, month, id } = require('./schemas');

router.use(requireRole('admin', 'hr'));

router.get('/types', (req, res) => res.json({ types: REPORT_TYPES }));

/**
 * GET /api/reports/:type?format=json|pdf|xlsx&from&to&month&userId&department&status&columns=a,b,c
 */
router.get('/:type', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const q = parse(z.object({
    format: z.enum(['json', 'pdf', 'xlsx']).default('json'),
    from: date.optional(), to: date.optional(), month: month.optional(),
    userId: id.optional(), department: z.string().max(80).optional(), status: z.string().max(20).optional(),
    columns: z.string().max(400).optional(),
  }), req.query);

  const to = q.to || todayIn(timezone);
  const from = q.from || addDays(to, -29);
  if (from > to) throw bad('"from" must not be after "to"');
  if (diffDays(from, to) > 366) throw bad('Choose a range of up to one year');
  const params = { ...q, from, to };

  const report = await buildReport(req.params.type, params);
  if (q.format === 'json') return res.json({ ...report, params: { from, to, month: q.month } });

  const base = `${report.type}-${q.month || `${from}_${to}`}`;
  if (q.format === 'xlsx') {
    const buf = await toXlsx(report, params);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(Buffer.from(buf));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
  return toPdf(report, params, res);
}));

module.exports = router;
