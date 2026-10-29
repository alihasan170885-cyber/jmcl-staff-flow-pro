'use strict';
/**
 * ZKTeco ADMS ("push") endpoints. Mounted at /iclock (what the device is configured with) and /api/adms.
 *   GET  /iclock/cdata?SN=…            device handshake -> returns plain-text options
 *   POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…   attendance upload (tab-separated lines) -> "OK"
 *   GET  /iclock/getrequest?SN=…       command poll -> "OK" (no commands queued)
 *   POST /iclock/devicecmd?SN=…        command result -> "OK"
 * Devices cannot send credentials, so access is controlled by the registered serial number (and optionally the source IP).
 * Unknown serial numbers self-register as *unapproved* devices; their data is discarded until an Admin approves them.
 */
const express = require('express');
const { query } = require('../db');
const { parseAttLog, handshakeResponse, stripIp } = require('../logic/adms');
const { ingestPunches } = require('../services/attendance');
const { checkLate, unknownPunch } = require('../services/exceptions');
const { notifyManagers } = require('../services/notifications');

const router = express.Router();
router.use(express.text({ type: () => true, limit: '2mb' }));

const text = (res, body = 'OK', status = 200) => res.status(status).type('text/plain').send(body);

async function identify(req, res) {
  const sn = String(req.query.SN || req.query.sn || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,60}$/.test(sn)) { text(res, 'ERROR: missing or invalid SN', 400); return null; }
  const ip = stripIp(req.ip);

  let { rows: [d] } = await query('SELECT * FROM devices WHERE serial_number = $1', [sn]);
  if (!d) {
    ({ rows: [d] } = await query(
      `INSERT INTO devices (name, serial_number, approved, active, online, last_seen, last_ip)
       VALUES ($1,$1,false,true,true,now(),$2) ON CONFLICT (serial_number) DO UPDATE SET last_seen = now() RETURNING *`, [sn, ip]));
    await notifyManagers({
      type: 'new-device', severity: 'warning', title: 'New device is waiting for approval',
      body: `A device with serial number ${sn} contacted the server from ${ip}.`, url: '/devices', dedupe: `new-device:${sn}`,
    });
  }
  if (d.enforce_ip && d.ip_address && stripIp(d.ip_address) !== ip) {
    console.warn(`[adms] ${sn} rejected: source ${ip} does not match configured ${d.ip_address}`);
    text(res, 'ERROR: source not allowed', 403);
    return null;
  }
  await query('UPDATE devices SET last_seen = now(), last_ip = $2, online = true WHERE id = $1', [d.id, ip]);
  return d;
}
const usable = (d) => d.approved && d.active;

async function handleHandshake(req, res) {
  const d = await identify(req, res); if (!d) return;
  text(res, handshakeResponse(d.serial_number, d.attlog_stamp));
}

async function handleUpload(req, res) {
  const d = await identify(req, res); if (!d) return;
  const table = String(req.query.table || '').toUpperCase();
  if (table && table !== 'ATTLOG') return text(res); // OPERLOG / USERINFO etc. are acknowledged and ignored
  if (!usable(d)) return text(res); // acknowledged, but not stored until approved

  const { records, rejected } = parseAttLog(req.body);
  if (rejected) console.warn(`[adms] ${d.serial_number}: ${rejected} unparsable line(s) skipped`);
  const result = await ingestPunches({ device: d, records, source: 'device' });
  for (const t of result.touched) await checkLate(t.userId, t.date);
  if (result.unknownPins.length) await unknownPunch(d, result.unknownPins);
  if (req.query.Stamp) await query('UPDATE devices SET attlog_stamp = $2 WHERE id = $1', [d.id, String(req.query.Stamp).slice(0, 40)]);
  console.log(`[adms] ${d.serial_number}: +${result.inserted} punches (${result.duplicates} duplicate)`);
  text(res);
}

async function handleOk(req, res) { const d = await identify(req, res); if (d) text(res); }

const wrapAsync = (fn) => (req, res, next) => fn(req, res).catch(next);

for (const base of ['/cdata', '/cdata.aspx']) {
  router.get(base, wrapAsync(handleHandshake));
  router.post(base, wrapAsync(handleUpload));
}
router.post('/push', wrapAsync(handleUpload));           // friendly alias: POST /api/adms/push?SN=…
router.get('/getrequest', wrapAsync(handleOk));
router.post('/devicecmd', wrapAsync(handleOk));
router.get('/ping', wrapAsync(handleOk));

module.exports = router;
