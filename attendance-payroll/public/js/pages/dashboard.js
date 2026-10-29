import { get } from '../api.js';
import { html, setHTML, $, fmtHours, fmtDate, fmtMoney, fmtMonth, badge, ago } from '../ui.js';
import { navigate } from '../main.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export async function render(view, state) {
  return state.user.role === 'staff' ? renderStaff(view, state) : renderManager(view, state);
}

/* ======================= Admin / HR ======================= */
async function renderManager(view, state) {
  let charts = [];
  let timer;

  const draw = (d) => {
    charts.forEach((c) => c.destroy()); charts = [];
    const t = d.today;
    const k = t.kpi;
    setHTML(view, html`
      <div class="stack">
        ${t.holiday ? html`<div class="notice info">Today is a company holiday: ${t.holiday}.</div>` : ''}
        <section class="ledger" aria-label="Today at a glance">
          <div><div class="n">${k.expected}</div><div class="l">Expected today</div></div>
          <div class="present"><div class="n">${k.present}</div><div class="l">Checked in</div></div>
          <div class="late"><div class="n ${k.late ? 'has' : ''}">${k.late}</div><div class="l">Late</div></div>
          <div class="absent"><div class="n ${k.absent ? 'has' : ''}">${k.absent}</div><div class="l">Absent</div></div>
          <div class="leave"><div class="n">${k.onLeave}</div><div class="l">On leave</div></div>
          <div class="ot"><div class="n">${(k.overtimeMinutes / 60).toFixed(1)}</div><div class="l">Overtime hours</div></div>
        </section>

        <section class="panel">
          <header><div><h2>Today’s shifts</h2><span class="small muted">Each row is one employee’s day against their shift. The blue line is now (${t.nowLocal}).</span></div></header>
          ${ribbon(t)}
        </section>

        <div class="cols-2">
          <section class="panel"><header><h2>Attendance, last ${d.trend.rows.length || 14} working days</h2></header>
            <div class="chart-box"><canvas id="trend" role="img" aria-label="Stacked bars of present, late, leave and absent employees per day"></canvas></div></section>
          <section class="panel"><header><h2>Latest punches</h2><span class="small muted">from the door reader</span></header>
            <div class="body flush list-lines">
              ${d.punches.length ? d.punches.map((p) => html`<div><span>${p.unknown ? html`<b style="color:var(--bad)">${p.name}</b>` : html`<b>${p.name}</b>`}<span class="small muted"> · ${p.device || p.source}</span></span><span class="time muted">${p.at.slice(5, 16)}</span></div>`)
                : html`<div class="empty">No punches yet. Run the simulator or connect a device.</div>`}
            </div></section>
        </div>

        <div class="cols-eq">
          <section class="panel"><header><h2>Attendance rate by department</h2><span class="small muted">this month</span></header>
            <div class="chart-box" style="height:${Math.max(180, d.departments.length * 44 + 40)}px"><canvas id="depts" role="img" aria-label="Attendance rate per department this month"></canvas></div></section>
          <section class="panel"><header><h2>Needs attention</h2></header>
            <div class="body flush list-lines">${attention(t)}</div></section>
        </div>

        <section class="panel"><header><h2>Devices</h2><a href="/devices" data-link class="small">Manage</a></header>
          <div class="body flush list-lines">
            ${d.devices.length ? d.devices.map((v) => html`<div><span><b>${v.name}</b> <span class="small muted">${v.serial_number}${v.location ? ' · ' + v.location : ''}</span></span>
              <span>${!v.approved ? badge('pending', 'Needs approval') : !v.active ? badge('inactive', 'Disabled') : badge(v.online ? 'online' : 'offline')}
              <span class="small muted">${v.last_seen ? ago(v.last_seen) : 'never seen'}</span></span></div>`)
              : html`<div class="empty">No devices yet.</div>`}
          </div></section>
      </div>`);

    // charts (Chart.js is loaded globally from /vendor/chart.js)
    if (window.Chart) {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.color = css('--muted');
      const anim = reduceMotion() ? false : { duration: 400 };
      if (d.trend.rows.length) {
        const labels = d.trend.rows.map((r) => r.d.slice(8) + '/' + r.d.slice(5, 7));
        const ds = (label, key, color) => ({ label, data: d.trend.rows.map((r) => r[key]), backgroundColor: color, borderWidth: 0, borderRadius: 2 });
        charts.push(new Chart($('#trend'), {
          type: 'bar',
          data: { labels, datasets: [ds('On time', 'present', css('--ok')), ds('Late', 'late', '#D98A00'), ds('Half day', 'half_day', '#8F9BA8'), ds('Leave', 'leave', css('--leave')), ds('Absent', 'absent', css('--bad'))] },
          options: { maintainAspectRatio: false, animation: anim, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } } },
        }));
      }
      if (d.departments.length) {
        charts.push(new Chart($('#depts'), {
          type: 'bar',
          data: { labels: d.departments.map((x) => x.department), datasets: [{ label: 'Attendance rate (%)', data: d.departments.map((x) => x.rate), backgroundColor: css('--primary'), borderRadius: 3 }] },
          options: { indexAxis: 'y', maintainAspectRatio: false, animation: anim, scales: { x: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } }, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw}% attended (${d.departments[c.dataIndex].late} late days)` } } } },
        }));
      }
    }
  };

  const load = async () => { try { draw(await get('/dashboard/overview')); } catch (e) { setHTML(view, html`<div class="notice bad">${e.message}</div>`); } };
  await load();
  timer = setInterval(load, 30_000);
  return () => { clearInterval(timer); charts.forEach((c) => c.destroy()); };
}

/** The shift ribbon: one row per expected employee on a shared time axis. */
function ribbon(t) {
  if (!t.ribbon.length) return html`<div class="empty">${t.holiday ? 'Holiday: nobody is expected today.' : 'Nobody is scheduled today (weekly off).'}</div>`;
  const startH = Math.max(0, Math.floor(Math.min(...t.ribbon.map((r) => toMin(r.shiftStart))) / 60) - 1);
  const endH = Math.min(24, Math.ceil((Math.max(...t.ribbon.map((r) => toMin(r.shiftEnd))) + 150) / 60));
  const hours = endH - startH;
  const pos = (min) => `${(((min - startH * 60) / (hours * 60)) * 100).toFixed(2)}%`;
  const w = (a, b) => `${((Math.max(0, b - a) / (hours * 60)) * 100).toFixed(2)}%`;
  const now = toMin(t.nowLocal);
  const order = { absent: 0, late: 1, waiting: 2, leave: 3, half_day: 4, present: 5 };
  const rows = [...t.ribbon].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || (a.checkIn || '').localeCompare(b.checkIn || '') || a.name.localeCompare(b.name));
  const ticks = Array.from({ length: hours + 1 }, (_, i) => startH + i).filter((h, i) => hours <= 14 || i % 2 === 0);

  return html`<div class="ribbon" style="--hours:${hours}">
    <div class="ribbon-axis"><span></span><div class="ticks">${ticks.map((h) => html`<span style="left:${pos(h * 60)}">${String(h).padStart(2, '0')}:00</span>`)}</div><span></span></div>
    ${rows.map((r) => {
      const s = toMin(r.shiftStart), e = toMin(r.shiftEnd);
      const inn = r.checkIn ? toMin(r.checkIn) : null, out = r.checkOut ? toMin(r.checkOut) : null;
      const end = out ?? Math.max(inn ?? 0, Math.min(now, 24 * 60));
      let right;
      if (r.state === 'absent') right = badge('absent');
      else if (r.state === 'leave') right = badge('leave');
      else if (r.state === 'waiting') right = badge('waiting');
      else right = html`<span class="time">${r.checkIn || '—'} → ${r.checkOut || '…'}</span>`;
      return html`<div class="ribbon-row">
        <div class="who"><b>${r.name}</b><span>${r.department} · ${r.shiftStart}–${r.shiftEnd}</span></div>
        <div class="track" role="img" aria-label="${r.name}: ${r.state === 'waiting' ? 'not in yet' : r.state}${r.checkIn ? ', in ' + r.checkIn : ''}${r.checkOut ? ', out ' + r.checkOut : ''}">
          <div class="shift" style="left:${pos(s)};width:${w(s, e)}"></div>
          ${inn !== null && r.lateMinutes > 0 ? html`<div class="gap-late" style="left:${pos(s)};width:${w(s, inn)}" title="${r.lateMinutes} min late"></div>` : ''}
          ${inn !== null ? html`<div class="in ${out === null ? 'open' : ''}" style="left:${pos(inn)};width:${w(inn, end)}"></div>` : ''}
          ${out !== null && r.overtimeMinutes > 0 ? html`<div class="ot" style="left:${pos(e)};width:${w(e, out)}" title="${r.overtimeMinutes} min overtime"></div>` : ''}
          ${out !== null && r.earlyOutMinutes > 0 ? html`<div class="early" style="left:${pos(out)}" title="Left ${r.earlyOutMinutes} min early"></div>` : ''}
          ${now >= startH * 60 && now <= endH * 60 ? html`<div class="now" style="left:${pos(now)}"></div>` : ''}
        </div>
        <div class="state">${right}</div>
      </div>`;
    })}
  </div>
  <div class="ribbon-legend" aria-hidden="true">
    <span><i style="background:#E4E9EE"></i>Scheduled shift</span><span><i style="background:var(--ok)"></i>At work</span>
    <span><i style="background:#E8A317"></i>Late by</span><span><i style="background:var(--ot)"></i>Overtime</span><span><i style="background:var(--bad)"></i>Left early</span>
  </div>`;
}

function attention(t) {
  const items = [];
  for (const r of t.ribbon) {
    if (r.state === 'absent') items.push({ w: 0, n: r.name, text: badge('absent'), sub: `${r.department}, shift ${r.shiftStart}` });
    else if (r.lateMinutes > 0) items.push({ w: 1, n: r.name, text: badge('late', `${r.lateMinutes} min late`), sub: `in at ${r.checkIn}` });
    else if (r.state === 'waiting' && toMin(t.nowLocal) > toMin(r.shiftStart) + 15) items.push({ w: 2, n: r.name, text: badge('waiting'), sub: `shift started ${r.shiftStart}` });
  }
  items.sort((a, b) => a.w - b.w || a.n.localeCompare(b.n));
  if (!items.length) return html`<div class="empty">Nothing needs attention right now.</div>`;
  return items.slice(0, 10).map((i) => html`<div><span><b>${i.n}</b><br><span class="small muted">${i.sub}</span></span><span>${i.text}</span></div>`);
}

/* ======================= Staff ======================= */
async function renderStaff(view, state) {
  const [mine, bal, slips] = await Promise.all([get('/dashboard/mine'), get('/leave/balances'), get('/payroll/my-payslips')]);
  const t = mine.today;
  const m = mine.month;
  const status = !t ? html`<p style="font-size:20px;margin:0"><b>Not checked in yet</b></p><p class="muted">Your check-in appears here a few seconds after you use the door reader.</p>`
    : html`<p style="font-size:20px;margin:0 0 6px"><b>${t.cin ? 'Checked in at ' + t.cin : 'No punches today'}</b> ${badge(t.status)}</p>
      <p class="muted">${t.cout ? `Checked out at ${t.cout} · worked ${fmtHours(t.worked_minutes)}` : t.cin ? 'You have not checked out yet.' : ''}
      ${t.late_minutes ? html`<br>${t.late_minutes} minutes after your shift start.` : ''}${t.overtime_minutes ? html`<br>Overtime: ${t.overtime_minutes} minutes.` : ''}</p>`;
  setHTML(view, html`
    <div class="stack">
      <section class="panel"><header><h2>Today</h2><span class="small muted">${fmtDate(mine.date)}</span></header><div class="body">${status}</div></section>
      <section class="ledger five" aria-label="This month">
        <div class="present"><div class="n">${m.present}</div><div class="l">Days present</div></div>
        <div class="late"><div class="n ${m.late ? 'has' : ''}">${m.late}</div><div class="l">Late arrivals</div></div>
        <div class="absent"><div class="n ${m.absent ? 'has' : ''}">${m.absent}</div><div class="l">Absent days</div></div>
        <div class="leave"><div class="n">${m.leave}</div><div class="l">Leave days</div></div>
        <div class="ot"><div class="n">${(m.overtime / 60).toFixed(1)}</div><div class="l">Overtime hours</div></div>
      </section>
      <div class="cols-eq">
        <section class="panel"><header><h2>Leave balance</h2><a href="/leave" data-link class="small">Request leave</a></header>
          <div class="body flush list-lines">${bal.balances.length ? bal.balances.map((b) => html`<div style="display:grid;grid-template-columns:1fr 110px 90px;align-items:center">
            <span>${b.name}</span><div class="bar"><i style="width:${b.allocated ? Math.min(100, (b.used / b.allocated) * 100) : 0}%"></i></div>
            <span class="num r small">${b.remaining} of ${b.allocated} left</span></div>`) : html`<div class="empty">No leave balances yet.</div>`}</div></section>
        <section class="panel"><header><h2>Latest payslip</h2><a href="/payroll" data-link class="small">All payslips</a></header>
          <div class="body">${slips.payslips.length ? html`<p style="margin:0" class="muted">${fmtMonth(slips.payslips[0].month)}</p><p style="font-size:20px;margin:2px 0 0"><b>${state.meta.currency} ${fmtMoney(slips.payslips[0].net_pay)}</b> <span class="muted small">net pay</span></p>` : html`<p class="muted">Your first payslip appears here once payroll is finalised for a month.</p>`}</div></section>
      </div>
    </div>`);
}
