#!/usr/bin/env node
'use strict';
/**
 * Fake ZKTeco punch simulator. Speaks the same ADMS push protocol a real uFace800 uses, so you can test the full
 * pipeline (ingest -> attendance rules -> exception alerts -> push notifications) without any hardware.
 * No dependencies; needs Node 18+.
 *
 * Examples
 *   node scripts/simulate-punch.js --handshake                       # device "hello" (also registers an unknown serial)
 *   node scripts/simulate-punch.js --pin 1004                        # punch employee PIN 1004 right now
 *   node scripts/simulate-punch.js --pin 1004 --at 09:35             # punch at 09:35 today (a late arrival)
 *   node scripts/simulate-punch.js --pin 1004 --time "2026-10-28 18:45:00" --status 1
 *   node scripts/simulate-punch.js --random 5                        # 5 punches from random demo employees, now
 *   node scripts/simulate-punch.js --watch --interval 8              # keep punching random employees every 8 s
 *   node scripts/simulate-punch.js --pin 9999                        # unknown PIN -> "unregistered PIN" alert
 *   node scripts/simulate-punch.js --sn NEW-DEVICE-42 --handshake    # unknown device -> "waiting for approval" alert
 *
 * Options (env in brackets)
 *   --url   server base URL           [ADMS_URL, default http://localhost:3000]
 *   --sn    device serial number      [ADMS_SN,  default DEMO-UFACE800-001]
 *   --tz    company timezone          [TZ_DEFAULT, default Asia/Dhaka]
 *   --verify  verification type 15 = face (default, uFace800), 1 = fingerprint, 3 = card, 0 = password
 *   --pins  comma list used by --random / --watch   (default 1004..1019, the demo staff)
 */
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const all = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const URL_BASE = String(opt('url', process.env.ADMS_URL || 'http://localhost:3000')).replace(/\/$/, '');
const SN = opt('sn', process.env.ADMS_SN || 'DEMO-UFACE800-001');
const TZ = opt('tz', process.env.TZ_DEFAULT || 'Asia/Dhaka');
const VERIFY = Number(opt('verify', 15));
const DEMO_PINS = String(opt('pins', Array.from({ length: 16 }, (_, i) => 1004 + i).join(','))).split(',');

function nowLocal(tz = TZ, date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}:${g('second')}` };
}

function resolveTime() {
  const full = opt('time');
  if (typeof full === 'string') {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(full)) throw new Error('--time must look like "2026-10-28 09:15:00"');
    return full;
  }
  const at = opt('at');
  const n = nowLocal();
  if (typeof at === 'string') {
    if (!/^\d{1,2}:\d{2}$/.test(at)) throw new Error('--at must look like 09:35');
    return `${n.date} ${at.padStart(5, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
  }
  return `${n.date} ${n.time}`;
}

async function call(method, path, body) {
  const res = await fetch(`${URL_BASE}${path}`, { method, body, headers: body ? { 'Content-Type': 'text/plain' } : undefined });
  return { status: res.status, text: (await res.text()).trim() };
}

async function handshake() {
  const r = await call('GET', `/iclock/cdata?SN=${encodeURIComponent(SN)}&options=all&pushver=2.4.1&language=69`);
  console.log(`handshake  -> HTTP ${r.status}\n${r.text.split('\n').map((l) => '    ' + l).join('\n')}`);
}

/** One ATTLOG line, exactly as the device formats it: PIN \t time \t status \t verify \t workcode \t … */
const line = (pin, time, status, verify = 15) => `${pin}\t${time}\t${status}\t${verify}\t0\t0\t0\t0\t0\t0`;

async function push(punches) {
  const body = punches.map((p) => line(p.pin, p.time, p.status, p.verify ?? VERIFY)).join('\r\n') + '\r\n';
  const stamp = Math.floor(Date.now() / 1000);
  const r = await call('POST', `/iclock/cdata?SN=${encodeURIComponent(SN)}&table=ATTLOG&Stamp=${stamp}`, body);
  for (const p of punches) console.log(`punch      ${p.pin.padEnd(6)} ${p.time}  status=${p.status}`);
  console.log(`upload     -> HTTP ${r.status} ${r.text}`);
  return r;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  if (opt('help') || opt('h')) { console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 28).join('\n')); return; }
  console.log(`target ${URL_BASE}   device ${SN}   timezone ${TZ}`);

  if (opt('handshake') && !opt('pin') && !opt('random') && !opt('watch')) return handshake();
  if (opt('handshake')) await handshake();

  const status = Number(opt('status', 0));
  if (opt('watch')) {
    const every = Number(opt('interval', 10)) * 1000;
    console.log(`watching: random punch every ${every / 1000}s — Ctrl+C to stop`);
    for (;;) {
      const n = nowLocal();
      await push([{ pin: pick(DEMO_PINS), time: `${n.date} ${n.time}`, status: Math.random() < 0.5 ? 0 : 1, verify: VERIFY }]);
      await new Promise((r) => setTimeout(r, every));
    }
  }
  if (opt('random')) {
    const count = Math.max(1, Number(opt('random', 3)) || 3);
    const n = nowLocal();
    const punches = Array.from({ length: count }, (_, i) => ({ pin: pick(DEMO_PINS), time: `${n.date} ${n.time.slice(0, 6)}${String(i).padStart(2, '0')}`, status, verify: VERIFY }));
    return push(punches);
  }
  const pins = [...all('pin'), ...(typeof opt('pins') === 'string' && !opt('random') && !opt('watch') ? [] : [])];
  if (!pins.length) { console.log('Nothing to send. Use --pin <PIN>, --random <n>, --watch or --handshake (see --help).'); return; }
  const time = resolveTime();
  return push(pins.map((pin) => ({ pin, time, status, verify: VERIFY })));
}

main().catch((e) => { console.error(`error: ${e.cause?.code || e.message}`); process.exit(1); });
