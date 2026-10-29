'use strict';
/**
 * ZKTeco ADMS ("push SDK") helpers. Devices POST tab-separated attendance lines to /iclock/cdata?SN=…&table=ATTLOG:
 *   PIN <TAB> YYYY-MM-DD HH:MM:SS <TAB> status <TAB> verify <TAB> workcode <TAB> …
 * status: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 OT-in, 5 OT-out (firmware dependent)
 * verify: 0 password, 1 fingerprint, 3 card, 15 face (firmware dependent; the uFace800 reports face as 15)
 */
const { isDate } = require('../utils/time');

const LINE_RE = /^(\S+)[\t ]+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(.*)$/;

function parseAttLog(body) {
  const records = [];
  let rejected = 0;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) { rejected++; continue; }
    const [, pin, date, time, rest] = m;
    const [h, mi, s] = time.split(':').map(Number);
    if (!isDate(date) || h > 23 || mi > 59 || s > 59 || pin.length > 32) { rejected++; continue; }
    const extra = rest.trim().split(/\s+/).filter(Boolean);
    const num = (v) => (v !== undefined && /^-?\d+$/.test(v) ? parseInt(v, 10) : null);
    records.push({ pin, local: `${date} ${time}`, state: num(extra[0]), verify: num(extra[1]), workcode: extra[2] || null });
  }
  return { records, rejected };
}

/** Plain-text handshake body returned for GET /iclock/cdata (device options). */
function handshakeResponse(serial, attlogStamp) {
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGSTAMP=${attlogStamp || 'None'}`,
    'OPERLOGSTAMP=9999',
    'ATTPHOTOSTAMP=None',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog\tOpLog',
    'Realtime=1',
    'Encrypt=None',
    '',
  ].join('\n');
}

const stripIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

module.exports = { parseAttLog, handshakeResponse, stripIp };
