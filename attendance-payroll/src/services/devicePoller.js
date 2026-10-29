'use strict';
/**
 * Optional "http-pull" mode: for a device (or middleware) that exposes punches over an HTTP API, the server polls the
 * `api_url` stored in the dashboard. Expected JSON: an array, or { data | records | logs: [...] }, of objects with
 *   pin (or userId / id / employeeId)  and  timestamp (or time / punchTime / datetime)  [+ optional status, verify].
 * Timestamps without a zone are read as company-local time; ISO timestamps with a zone are converted.
 */
const { query } = require('../db');
const { getSettings } = require('./settings');
const { ingestPunches } = require('./attendance');
const { checkLate, unknownPunch } = require('./exceptions');
const { toLocalString, isDate } = require('../utils/time');

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;

function normalise(payload, tz) {
  const arr = Array.isArray(payload) ? payload : payload?.data || payload?.records || payload?.logs || [];
  const out = [];
  let rejected = 0;
  for (const item of arr) {
    const pin = String(item.pin ?? item.userId ?? item.id ?? item.employeeId ?? '').trim();
    const ts = item.timestamp ?? item.time ?? item.punchTime ?? item.datetime;
    let local = null;
    if (typeof ts === 'string' && LOCAL_RE.test(ts)) { const m = LOCAL_RE.exec(ts); local = `${m[1]} ${m[2]}`; }
    else if (ts) local = toLocalString(ts, tz);
    if (!pin || !local || !isDate(local.slice(0, 10))) { rejected++; continue; }
    out.push({ pin, local, state: Number.isInteger(item.status) ? item.status : null, verify: Number.isInteger(item.verify) ? item.verify : null, workcode: null });
  }
  return { records: out, rejected };
}

async function pollDevice(device) {
  const { timezone } = await getSettings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(device.api_url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { records } = normalise(await res.json(), timezone);
    const r = await ingestPunches({ device, records, source: 'poll' });
    for (const t of r.touched) await checkLate(t.userId, t.date);
    if (r.unknownPins.length) await unknownPunch(device, r.unknownPins);
    await query('UPDATE devices SET online = true, last_seen = now(), last_poll_at = now(), last_poll_error = NULL WHERE id = $1', [device.id]);
    return r;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timed out' : (e.cause?.code || e.message);
    await query('UPDATE devices SET last_poll_at = now(), last_poll_error = $2 WHERE id = $1', [device.id, String(msg).slice(0, 200)]);
    return { error: msg };
  } finally { clearTimeout(timer); }
}

/** Poll every approved http-pull device whose interval has elapsed. */
async function pollDue() {
  const { rows } = await query(
    `SELECT * FROM devices WHERE approved AND active AND protocol = 'http-pull' AND api_url IS NOT NULL
        AND (last_poll_at IS NULL OR last_poll_at < now() - make_interval(secs => poll_interval_sec))`);
  for (const d of rows) await pollDevice(d);
}

module.exports = { pollDevice, pollDue, normalise };
