'use strict';
const net = require('net');

/** TCP reachability check (ZKTeco devices listen on 4370 for the native protocol). */
function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => { socket.destroy(); resolve({ ok, ms: Date.now() - started, error }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'Timed out'));
    socket.once('error', (e) => done(false, e.code || e.message));
  });
}

/** HTTP reachability check. Only the status code and latency are reported, never the response body. */
async function httpProbe(url, timeoutMs = 4000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.name === 'AbortError' ? 'Timed out' : (e.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}

async function probeDevice(d) {
  const result = {};
  if (d.ip_address) result.tcp = await tcpProbe(d.ip_address, d.port || 4370);
  if (d.api_url) result.http = await httpProbe(d.api_url);
  if (!d.ip_address && !d.api_url) result.error = 'Set an IP address or API URL first';
  return result;
}

module.exports = { tcpProbe, httpProbe, probeDevice };
