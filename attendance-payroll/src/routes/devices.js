'use strict';
/**
 * Device management (Admin only). The IP address / API URL stored here is editable at any time from the dashboard.
 *  - protocol "adms": the device pushes to this server; ip_address is used for display, the connectivity test and (optionally)
 *    source-IP enforcement.
 *  - protocol "http-pull": the server polls api_url on an interval (see services/devicePoller.js).
 */
const router = require('express').Router();
const net = require('net');
const { query } = require('../db');
const { wrap, parse, notFound, bad } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { probeDevice } = require('../services/deviceProbe');
const { pollDevice } = require('../services/devicePoller');
const { z, id } = require('./schemas');

router.use(requireRole('admin'));

const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const host = z.string().trim().max(253).refine((h) => net.isIP(h) !== 0 || HOST_RE.test(h), 'must be an IP address or hostname');
const apiUrl = z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

const device = z.object({
  name: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9_.-]+$/, 'may only contain letters, digits and - _ .'),
  model: z.string().trim().max(60).default('ZKTeco uFace800'),
  location: z.string().trim().max(120).default(''),
  protocol: z.enum(['adms', 'http-pull']).default('adms'),
  ipAddress: host.nullable().optional().or(z.literal('').transform(() => null)),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  apiUrl: apiUrl.nullable().optional().or(z.literal('').transform(() => null)),
  enforceIp: z.boolean().default(false),
  pollIntervalSec: z.coerce.number().int().min(10).max(86400).default(60),
  approved: z.boolean().optional(),
  active: z.boolean().default(true),
}).superRefine((d, ctx) => {
  if (d.protocol === 'http-pull' && !d.apiUrl) ctx.addIssue({ code: 'custom', path: ['apiUrl'], message: 'is required for HTTP pull mode' });
  if (d.enforceIp && !d.ipAddress) ctx.addIssue({ code: 'custom', path: ['ipAddress'], message: 'is required to enforce the source IP' });
});

const COLS = `id, name, serial_number, model, location, protocol, ip_address, port, api_url, enforce_ip, poll_interval_sec, approved,
  active, online, last_seen, last_ip, last_poll_at, last_poll_error, created_at`;

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ${COLS}, (SELECT COUNT(*)::int FROM punch_logs p WHERE p.device_id = devices.id AND p.punched_at > now() - interval '24 hours') AS punches_24h
       FROM devices ORDER BY approved, name`);
  res.json({ devices: rows });
}));

router.post('/', wrap(async (req, res) => {
  const d = parse(device, req.body);
  const { rows: [r] } = await query(
    `INSERT INTO devices (name, serial_number, model, location, protocol, ip_address, port, api_url, enforce_ip, poll_interval_sec, approved, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) RETURNING id`,
    [d.name, d.serialNumber, d.model, d.location, d.protocol, d.ipAddress ?? null, d.port ?? null, d.apiUrl ?? null, d.enforceIp, d.pollIntervalSec, d.active]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'create','device',$2)`, [req.user.id, String(r.id)]);
  res.status(201).json({ id: r.id });
}));

/** Update connection settings (IP address / API URL / protocol …) or approve a self-registered device. */
router.put('/:id', wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const d = parse(device, req.body);
  const { rowCount } = await query(
    `UPDATE devices SET name=$2, serial_number=$3, model=$4, location=$5, protocol=$6, ip_address=$7, port=$8, api_url=$9,
            enforce_ip=$10, poll_interval_sec=$11, approved=COALESCE($12, approved), active=$13 WHERE id=$1`,
    [did, d.name, d.serialNumber, d.model, d.location, d.protocol, d.ipAddress ?? null, d.port ?? null, d.apiUrl ?? null,
      d.enforceIp, d.pollIntervalSec, d.approved ?? null, d.active]);
  if (!rowCount) throw notFound('Device not found');
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','device',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ ip: d.ipAddress ?? null, apiUrl: d.apiUrl ?? null, protocol: d.protocol })]);
  res.json({ ok: true });
}));

router.post('/:id/approve', wrap(async (req, res) => {
  const { rowCount } = await query('UPDATE devices SET approved = true, active = true WHERE id = $1', [parse(id, req.params.id)]);
  if (!rowCount) throw notFound('Device not found');
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!rowCount) throw notFound('Device not found');
  res.json({ ok: true }); // punch history is kept (device_id becomes null)
}));

/** Connectivity check: TCP connect to ip:port and/or HTTP request to the API URL. Reports status and latency only. */
router.post('/:id/test', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!d) throw notFound('Device not found');
  res.json(await probeDevice(d));
}));

router.post('/:id/poll', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!d) throw notFound('Device not found');
  if (d.protocol !== 'http-pull' || !d.api_url) throw bad('This device is not in HTTP pull mode');
  const r = await pollDevice(d);
  res.json(r.error ? { ok: false, error: r.error } : { ok: true, inserted: r.inserted, duplicates: r.duplicates, unknownPins: r.unknownPins });
}));

module.exports = router;
