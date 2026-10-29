'use strict';
/**
 * End-to-end smoke test against a RUNNING server seeded with demo data (SEED_DEMO=true).
 *   docker compose up -d --build   &&   npm run test:smoke
 * BASE_URL defaults to http://localhost:3000. Safe to re-run: it cleans up what it creates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = 'Demo@12345';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, extra = {}) {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  async login(email) { const r = await this.req('POST', '/api/auth/login', { email, password: PASSWORD }); assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`); return r.data.user; }
}
const adms = (method, path, body) => fetch(BASE + path, { method, body, headers: body ? { 'Content-Type': 'text/plain' } : {} }).then(async (r) => ({ status: r.status, text: (await r.text()).trim() }));
const localNow = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_DEFAULT || 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
};

const admin = new Client(), hr = new Client(), staff = new Client();

test('health and public meta', async () => {
  const h = await new Client().req('GET', '/api/health');
  assert.equal(h.status, 200);
  const m = await new Client().req('GET', '/api/meta');
  assert.ok(m.data.company && m.data.timezone);
});

test('authentication and role-based access control', async () => {
  assert.equal((await new Client().req('GET', '/api/users')).status, 401);
  assert.equal((await new Client().req('POST', '/api/auth/login', { email: 'admin@company.test', password: 'wrong' })).status, 401);
  assert.equal((await admin.login('admin@company.test')).role, 'admin');
  assert.equal((await hr.login('hr@company.test')).role, 'hr');
  assert.equal((await staff.login('staff@company.test')).role, 'staff');

  assert.equal((await staff.req('GET', '/api/users')).status, 403);
  assert.equal((await staff.req('GET', '/api/devices')).status, 403);
  assert.equal((await staff.req('GET', '/api/reports/attendance')).status, 403);
  assert.equal((await hr.req('GET', '/api/devices')).status, 403, 'HR must not manage devices');
  assert.equal((await hr.req('GET', '/api/users')).status, 200);
  assert.equal((await admin.req('GET', '/api/devices')).status, 200);
  // cookie sessions must send the CSRF header on writes
  const noHeader = await fetch(BASE + '/api/leave/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('ZKTeco ADMS: handshake, punch upload, idempotency, unknown PIN, unknown device', async () => {
  const sn = 'DEMO-UFACE800-001';
  const hs = await adms('GET', `/iclock/cdata?SN=${sn}&options=all`);
  assert.equal(hs.status, 200);
  assert.match(hs.text, /^GET OPTION FROM: DEMO-UFACE800-001/);

  const stamp = localNow();
  const line = `1004\t${stamp}\t0\t1\t0\t0\r\n`;
  assert.deepEqual(await adms('POST', `/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=1`, line), { status: 200, text: 'OK' });
  assert.deepEqual(await adms('POST', `/api/adms/push?SN=${sn}&table=ATTLOG`, line), { status: 200, text: 'OK' }); // duplicate via alias

  const day = stamp.slice(0, 10);
  const punches = await admin.req('GET', `/api/attendance/punches?from=${day}&to=${day}`);
  assert.equal(punches.data.rows.filter((r) => r.pin === '1004' && r.at === stamp).length, 1, 'punch stored exactly once');

  await adms('POST', `/iclock/cdata?SN=${sn}&table=ATTLOG`, `9999\t${stamp}\t0\t1\r\n`);
  const after = await admin.req('GET', `/api/attendance/punches?from=${day}&to=${day}`);
  assert.ok(after.data.rows.some((r) => r.pin === '9999' && !r.name), 'unknown PIN is kept but unlinked');

  assert.equal((await adms('POST', '/iclock/cdata?table=ATTLOG', line)).status, 400, 'missing SN rejected');
  await adms('GET', '/iclock/cdata?SN=SMOKE-UNKNOWN-1');
  const devs = await admin.req('GET', '/api/devices');
  const pending = devs.data.devices.find((d) => d.serial_number === 'SMOKE-UNKNOWN-1');
  assert.ok(pending && pending.approved === false, 'unknown device self-registers as unapproved');
  await adms('POST', '/iclock/cdata?SN=SMOKE-UNKNOWN-1&table=ATTLOG', `1004\t${stamp.slice(0, 10)} 03:00:00\t0\t1\r\n`);
  const d2 = await admin.req('GET', `/api/attendance/punches?from=${day}&to=${day}`);
  assert.ok(!d2.data.rows.some((r) => r.at.endsWith('03:00:00') && r.device === 'SMOKE-UNKNOWN-1'), 'unapproved device data is discarded');
  await admin.req('DELETE', `/api/devices/${pending.id}`);
});

test('device configuration: change IP / API URL and persist', async () => {
  const list = (await admin.req('GET', '/api/devices')).data.devices;
  const d = list.find((x) => x.serial_number === 'DEMO-UFACE800-001');
  const body = (ip, url) => ({ name: d.name, serialNumber: d.serial_number, model: d.model, location: d.location, protocol: 'adms', ipAddress: ip, port: 4370, apiUrl: url, enforceIp: false, pollIntervalSec: 60, active: true, approved: true });
  assert.equal((await admin.req('PUT', `/api/devices/${d.id}`, body('10.20.30.40', 'http://10.20.30.40/api/punches'))).status, 200);
  const changed = (await admin.req('GET', '/api/devices')).data.devices.find((x) => x.id === d.id);
  assert.equal(changed.ip_address, '10.20.30.40');
  assert.equal(changed.api_url, 'http://10.20.30.40/api/punches');
  assert.equal((await admin.req('PUT', `/api/devices/${d.id}`, body('not an ip!', null))).status, 400, 'invalid address rejected');
  await admin.req('PUT', `/api/devices/${d.id}`, body(d.ip_address, d.api_url)); // restore
});

test('leave: request, approve, balance update, cancel restores balance', async () => {
  const types = (await staff.req('GET', '/api/org/leave-types')).data.leaveTypes;
  const annual = types.find((t) => t.name === 'Annual leave');
  const before = (await staff.req('GET', '/api/leave/balances?year=2027')).data.balances.find((b) => b.leave_type_id === annual.id);
  const r = await staff.req('POST', '/api/leave/requests', { leaveTypeId: annual.id, startDate: '2027-06-07', endDate: '2027-06-07', reason: 'smoke test' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await staff.req('POST', `/api/leave/requests/${r.data.id}/approve`, {})).status, 403, 'staff cannot approve');
  assert.equal((await staff.req('POST', '/api/leave/requests', { leaveTypeId: annual.id, startDate: '2027-06-07', endDate: '2027-06-07' })).status, 409, 'overlap rejected');
  assert.equal((await hr.req('POST', `/api/leave/requests/${r.data.id}/approve`, { note: 'ok' })).status, 200);
  const mid = (await staff.req('GET', '/api/leave/balances?year=2027')).data.balances.find((b) => b.leave_type_id === annual.id);
  assert.equal(mid.used, before.used + 1);
  assert.equal((await hr.req('POST', `/api/leave/requests/${r.data.id}/cancel`)).status, 200);
  const end = (await staff.req('GET', '/api/leave/balances?year=2027')).data.balances.find((b) => b.leave_type_id === annual.id);
  assert.equal(end.used, before.used, 'balance restored');
});

test('payroll: generated run, staff only sees finalised payslips', async () => {
  const runs = (await hr.req('GET', '/api/payroll/runs')).data.runs;
  assert.ok(runs.length >= 2, 'demo payroll history exists');
  const finalized = runs.find((r) => r.status === 'finalized');
  const draft = runs.find((r) => r.status === 'draft' && !r.partial);
  assert.ok(finalized && draft);
  const mine = (await staff.req('GET', '/api/payroll/my-payslips')).data.payslips;
  assert.ok(mine.some((p) => p.month === finalized.month) && !mine.some((p) => p.month === draft.month));
  const run = (await hr.req('GET', `/api/payroll/runs/${draft.month}`)).data;
  const someoneElse = run.slips.find((s) => s.user_id !== 4);
  assert.equal((await staff.req('GET', `/api/payroll/payslips/${someoneElse.id}`)).status, 404, 'cannot read another employee payslip');
  assert.equal((await hr.req('POST', `/api/payroll/runs/${finalized.month}/generate`)).status, 409, 'finalised month is locked');
  assert.equal((await hr.req('POST', `/api/payroll/runs/${draft.month}/finalize`)).status, 403, 'only Admin finalises');
});

test('reports: PDF and Excel downloads', async () => {
  const x = await admin.req('GET', '/api/reports/summary?format=xlsx');
  assert.equal(x.status, 200); assert.equal(x.data.subarray(0, 2).toString(), 'PK');
  const p = await admin.req('GET', '/api/reports/attendance?format=pdf');
  assert.equal(p.status, 200); assert.equal(p.data.subarray(0, 4).toString(), '%PDF');
  const j = await admin.req('GET', '/api/reports/attendance?columns=name,late_minutes');
  assert.deepEqual(j.data.columns.map((c) => c.key), ['name', 'late_minutes']);
});

test('dashboard and notifications', async () => {
  const o = await hr.req('GET', '/api/dashboard/overview');
  assert.equal(o.status, 200);
  assert.ok(o.data.today.kpi && Array.isArray(o.data.trend.rows));
  assert.equal((await staff.req('GET', '/api/dashboard/overview')).status, 403);
  const n = await admin.req('GET', '/api/notifications');
  assert.equal(n.status, 200);
  assert.ok(n.data.notifications.some((x) => x.type === 'unknown-pin' || x.type === 'new-device' || x.type === 'late' || x.type === 'absent'), 'attendance exceptions raised notifications');
  assert.ok((await admin.req('GET', '/api/notifications/push/key')).data.publicKey.length > 20, 'VAPID public key available');
});
