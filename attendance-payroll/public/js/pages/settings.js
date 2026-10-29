import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, toast, modal, formValues, confirmDialog, fmtDateLong, ago } from '../ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function render(view, state) {
  const isAdmin = state.user.role === 'admin';
  let tab = 'rules';
  let year = Number(state.meta.today.slice(0, 4));

  const frame = () => {
    setHTML(view, html`<div class="stack"><div class="tabs" role="tablist">
      ${[['rules', 'Company & rules'], ['shifts', 'Shifts'], ['holidays', 'Holidays'], ['leave', 'Leave types'], ...(isAdmin ? [['audit', 'Audit log']] : [])].map(([k, l]) => html`<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`)}
    </div><div id="tab"></div></div>`);
    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; frame(); }));
    ({ rules, shifts, holidays, leave, audit }[tab])();
  };

  /* ---- company & rules ---- */
  const rules = async () => {
    const { settings: s } = await get('/settings');
    const dis = isAdmin ? '' : 'disabled';
    const num = (grp, key, label, hint, step = 1) => html`<label>${label}${hint ? html`<span class="hint">${hint}</span>` : ''}<input type="number" step="${step}" name="${grp}.${key}" value="${s[grp][key]}" ${dis}></label>`;
    setHTML($('#tab'), html`<form id="rules" class="stack">
      ${isAdmin ? '' : html`<div class="notice info">Only an Admin can change these. You can view them.</div>`}
      <section class="panel"><header><h2>Company</h2></header><div class="body form-grid">
        <label>Company name<input type="text" name="company_name" value="${s.company_name}" ${dis}></label>
        <label>Currency code<input type="text" name="currency" value="${s.currency}" maxlength="8" ${dis}></label>
        <label>Timezone <span class="hint">IANA name. Device times are read in this zone.</span><input type="text" name="timezone" value="${s.timezone}" ${dis}></label></div></section>
      <section class="panel"><header><h2>Attendance rules</h2></header><div class="body form-grid">
        ${num('attendance', 'half_day_minutes', 'Half-day threshold (minutes)', 'Worked less than this → half day')}
        ${num('attendance', 'ot_max_minutes', 'Maximum overtime per day (minutes)', 'Extra time beyond this is not counted')}
        ${num('attendance', 'min_punch_gap_minutes', 'Duplicate punch window (minutes)', 'Punches closer than this are one tap')}
        ${num('attendance', 'not_checked_in_alert_after_minutes', '“Not checked in” alert after (minutes)', 'After shift start')}
        ${num('attendance', 'device_offline_after_minutes', 'Device offline alert after (minutes)')}</div>
        <div class="body small muted" style="border-top:1px solid var(--line-2)">Grace periods, break length and overtime start are set per shift.</div></section>
      <section class="panel"><header><h2>Payroll rules</h2></header><div class="body form-grid">
        ${num('payroll', 'ot_multiplier', 'Overtime multiplier', 'On normal working days', 0.05)}
        ${num('payroll', 'off_day_ot_multiplier', 'Off-day multiplier', 'Weekly off and holidays', 0.05)}
        ${num('payroll', 'late_count_per_day_deduction', 'Late arrivals per day deducted', 'Every N lates cost one day’s pay. 0 turns it off.')}
        ${num('payroll', 'perfect_attendance_bonus', 'Perfect attendance bonus', 'No absence, lateness or half days', 0.01)}
        ${num('payroll', 'pf_percent', 'Provident fund (% of base)', '', 0.1)}
        ${num('payroll', 'tax_free_amount', 'Tax-free amount per month', '', 1)}
        ${num('payroll', 'tax_rate_percent', 'Income tax rate (%)', 'Applied above the tax-free amount', 0.1)}</div></section>
      ${isAdmin ? html`<div class="row"><button class="btn primary" type="submit">Save settings</button><span class="small muted">Changes apply to new calculations. Use Recalculate on the Attendance page to refresh past days.</span></div>` : ''}
    </form>`);
    $('#rules').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      const body = { company_name: v.company_name, currency: v.currency, timezone: v.timezone, attendance: {}, payroll: {} };
      for (const [k, val] of Object.entries(v)) { const [g, key] = k.split('.'); if (key) body[g][key] = Number(val); }
      try { await put('/settings', body); state.meta.company = v.company_name; state.meta.timezone = v.timezone; state.meta.currency = v.currency; toast('Settings saved'); } catch (ex) { toast(ex.message, 'bad'); }
    });
  };

  /* ---- shifts ---- */
  const shifts = async () => {
    const { shifts: list } = await get('/org/shifts');
    setHTML($('#tab'), html`<div class="row end" style="margin-bottom:12px"><button class="btn primary" id="add">Add shift</button></div>
      <section class="panel"><div class="body flush table-wrap"><table><thead><tr><th>Shift</th><th>Hours</th><th class="r">Break</th><th class="r">Late after</th><th class="r">Early-out before</th><th class="r">Overtime after</th><th>Weekly off</th><th class="r">Employees</th><th></th></tr></thead><tbody>
        ${list.map((s) => html`<tr><td><b>${s.name}</b></td><td class="time">${s.start_time}–${s.end_time}</td><td class="r">${s.break_minutes} min</td><td class="r">+${s.grace_minutes} min</td><td class="r">−${s.early_out_grace_minutes} min</td><td class="r">+${s.overtime_after_minutes} min</td>
          <td>${s.weekly_off.map((d) => DAYS[d]).join(', ') || 'None'}</td><td class="r">${s.employees}</td>
          <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edit="${s.id}">Edit</button><button class="btn sm danger" data-del="${s.id}" data-name="${s.name}">Delete</button></td></tr>`)}</tbody></table></div></section>
      <p class="small muted">Late means arriving later than the start time plus the grace period; the late minutes are counted from the start time. Overtime counts from the end of the shift once the threshold is passed. After editing a shift, run Recalculate on the Attendance page to refresh past days.</p>`);
    $('#add').addEventListener('click', () => shiftForm(null));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => shiftForm(list.find((s) => String(s.id) === b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete ${b.dataset.name}?`, 'Only shifts with no employees can be deleted.', { confirmLabel: 'Delete', danger: true }))) return;
      try { await del(`/org/shifts/${b.dataset.del}`); toast('Shift deleted'); shifts(); } catch (e) { toast(e.message, 'bad'); }
    }));
  };
  const shiftForm = (s) => modal({
    title: s ? `Edit ${s.name}` : 'Add shift', submitLabel: s ? 'Save shift' : 'Add shift',
    body: html`<div class="form-grid"><label class="wide">Name<input type="text" name="name" required value="${s?.name || ''}"></label>
      <label>Start<input type="time" name="startTime" required value="${s?.start_time || '09:00'}"></label><label>End<input type="time" name="endTime" required value="${s?.end_time || '18:00'}"></label>
      <label>Unpaid break (min)<input type="number" name="breakMinutes" min="0" value="${s?.break_minutes ?? 60}"></label>
      <label>Late grace (min)<input type="number" name="graceMinutes" min="0" value="${s?.grace_minutes ?? 10}"></label>
      <label>Early-out grace (min)<input type="number" name="earlyOutGraceMinutes" min="0" value="${s?.early_out_grace_minutes ?? 10}"></label>
      <label>Overtime starts after (min)<input type="number" name="overtimeAfterMinutes" min="0" value="${s?.overtime_after_minutes ?? 30}"></label>
      <div class="wide"><div class="small" style="font-weight:550;margin-bottom:6px">Weekly off days</div><div class="checks">${DAYS.map((d, i) => html`<label class="check"><input type="checkbox" name="off${i}" ${(s ? s.weekly_off : [5]).includes(i) ? 'checked' : ''}> ${d}</label>`)}</div></div></div>`,
    onSubmit: async (form, close) => {
      const v = formValues(form);
      const body = { name: v.name, startTime: v.startTime, endTime: v.endTime, breakMinutes: Number(v.breakMinutes), graceMinutes: Number(v.graceMinutes),
        earlyOutGraceMinutes: Number(v.earlyOutGraceMinutes), overtimeAfterMinutes: Number(v.overtimeAfterMinutes), weeklyOff: DAYS.map((_, i) => i).filter((i) => v[`off${i}`]) };
      if (s) await put(`/org/shifts/${s.id}`, body); else await post('/org/shifts', body);
      close(); toast('Shift saved'); shifts();
    },
  });

  /* ---- holidays ---- */
  const holidays = async () => {
    const { holidays: list } = await get(`/org/holidays?year=${year}`);
    setHTML($('#tab'), html`<div class="row between" style="margin-bottom:12px"><div class="row"><button class="btn sm" id="prev">←</button><b>${year}</b><button class="btn sm" id="next">→</button></div>
      <form class="row" id="add"><input type="date" name="date" required style="width:auto"><input type="text" name="name" placeholder="Holiday name" required style="width:220px"><button class="btn primary" type="submit">Add holiday</button></form></div>
      <section class="panel"><div class="body flush list-lines">${list.length ? list.map((h) => html`<div><span><b>${h.name}</b> <span class="muted">${fmtDateLong(h.date)}</span></span><button class="btn sm danger" data-del="${h.date}">Remove</button></div>`) : html`<div class="empty">No holidays for ${year}.</div>`}</div></section>
      <p class="small muted">Holidays are not counted as working days for attendance, leave or payroll.</p>`);
    $('#prev').addEventListener('click', () => { year--; holidays(); });
    $('#next').addEventListener('click', () => { year++; holidays(); });
    $('#add').addEventListener('submit', async (e) => { e.preventDefault(); const v = formValues(e.target); try { await post('/org/holidays', v); toast('Holiday added'); holidays(); } catch (ex) { toast(ex.message, 'bad'); } });
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => { try { await del(`/org/holidays/${b.dataset.del}`); toast('Holiday removed'); holidays(); } catch (e) { toast(e.message, 'bad'); } }));
  };

  /* ---- leave types ---- */
  const leave = async () => {
    const { leaveTypes } = await get('/org/leave-types');
    setHTML($('#tab'), html`${isAdmin ? html`<div class="row end" style="margin-bottom:12px"><button class="btn primary" id="add">Add leave type</button></div>` : ''}
      <section class="panel"><div class="body flush table-wrap"><table><thead><tr><th>Leave type</th><th class="r">Days per year</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>
        ${leaveTypes.map((t) => html`<tr><td><b>${t.name}</b></td><td class="r">${t.annual_quota ?? 'No balance'}</td><td>${t.paid ? 'Paid' : 'Unpaid (deducted from salary)'}</td><td>${t.active ? 'Active' : 'Inactive'}</td>
          <td>${isAdmin ? html`<button class="btn sm" data-edit="${t.id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div></section>`);
    $('#add')?.addEventListener('click', () => typeForm(null));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => typeForm(leaveTypes.find((t) => String(t.id) === b.dataset.edit))));
  };
  const typeForm = (t) => modal({
    title: t ? `Edit ${t.name}` : 'Add leave type',
    body: html`<div class="form-grid"><label class="wide">Name<input type="text" name="name" required value="${t?.name || ''}"></label>
      <label>Days per year <span class="hint">Empty = no balance (unpaid leave)</span><input type="number" name="annualQuota" min="0" step="0.5" value="${t?.annual_quota ?? ''}"></label>
      <div class="checks" style="align-self:end"><label class="check"><input type="checkbox" name="paid" ${t?.paid !== false ? 'checked' : ''}> Paid</label><label class="check"><input type="checkbox" name="active" ${t?.active !== false ? 'checked' : ''}> Active</label></div></div>`,
    onSubmit: async (form, close) => {
      const v = formValues(form);
      const body = { name: v.name, annualQuota: v.annualQuota === undefined ? null : Number(v.annualQuota), paid: !!v.paid, active: !!v.active };
      if (t) await put(`/org/leave-types/${t.id}`, body); else await post('/org/leave-types', body);
      close(); toast('Leave type saved'); leave();
    },
  });

  /* ---- audit ---- */
  const audit = async () => {
    const { entries } = await get('/settings/audit');
    setHTML($('#tab'), html`<section class="panel"><div class="body flush table-wrap">${entries.length ? html`<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>
      ${entries.map((e) => html`<tr><td class="muted">${ago(e.at)}</td><td>${e.actor || 'System'}</td><td>${e.action}</td><td>${e.entity} ${e.entity_id || ''}</td><td class="wrap small muted">${Object.keys(e.detail || {}).length ? JSON.stringify(e.detail) : ''}</td></tr>`)}</tbody></table>` : html`<p class="empty">No audit entries yet.</p>`}</div></section>`);
  };

  frame();
}
