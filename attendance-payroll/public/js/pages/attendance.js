import { get, post, qs } from '../api.js';
import { html, setHTML, $, $$, fmtDate, fmtHours, fmtMin, badge, toast, modal, formValues, addDays, esc } from '../ui.js';

export async function render(view, state) {
  const isMgr = ['admin', 'hr'].includes(state.user.role);
  const today = state.meta.today;
  const f = { from: addDays(today, -13), to: today, userId: '', department: '', status: '' };
  let tab = 'daily';
  let users = [], departments = [];
  if (isMgr) {
    [users, departments] = await Promise.all([get('/users?active=true').then((r) => r.users), get('/users/departments').then((r) => r.departments)]);
  }

  const shell = () => {
    setHTML(view, html`
      <div class="stack">
        ${isMgr ? html`<div class="tabs" role="tablist"><button role="tab" data-tab="daily" aria-selected="${tab === 'daily'}">Daily records</button>
          <button role="tab" data-tab="punches" aria-selected="${tab === 'punches'}">Raw punches</button></div>` : ''}
        <form class="filters" id="filters">
          <label>From<input type="date" name="from" value="${f.from}" max="${today}"></label>
          <label>To<input type="date" name="to" value="${f.to}" max="${today}"></label>
          ${isMgr ? html`
            <label>Employee<select name="userId"><option value="">Everyone</option>${users.map((u) => html`<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${u.name}</option>`)}</select></label>
            ${tab === 'daily' ? html`<label>Department<select name="department"><option value="">All</option>${departments.map((d) => html`<option ${d === f.department ? 'selected' : ''}>${d}</option>`)}</select></label>` : ''}` : ''}
          ${tab === 'daily' ? html`<label>Status<select name="status"><option value="">All</option>
            ${[['present', 'Present'], ['late', 'Late'], ['half_day', 'Half day'], ['absent', 'Absent'], ['leave', 'On leave'], ['unpaid_leave', 'Unpaid leave'], ['weekend', 'Weekly off'], ['holiday', 'Holiday']].map(([v, l]) => html`<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`)}</select></label>` : ''}
          <button class="btn primary" type="submit">Apply</button>
          ${isMgr && tab === 'daily' ? html`<button class="btn" type="button" id="recalc" title="Recompute attendance from the raw punches for this date range">Recalculate</button>` : ''}
        </form>
        <section class="panel"><div class="body flush table-wrap" id="results"><p class="empty">Loading…</p></div></section>
      </div>`);
    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; shell(); load(); }));
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); Object.assign(f, formValues(e.target)); for (const k of ['userId', 'department', 'status']) f[k] = f[k] || ''; shell(); load(); });
    $('#recalc')?.addEventListener('click', async () => {
      try { const r = await post('/attendance/recalculate', { from: $('#filters').from.value, to: $('#filters').to.value }); toast(`Recalculated ${r.rows} day records`); load(); } catch (e) { toast(e.message, 'bad'); }
    });
  };

  const load = async () => {
    const box = $('#results');
    try {
      if (tab === 'punches') {
        const { rows } = await get(`/attendance/punches${qs({ from: f.from, to: f.to, userId: f.userId })}`);
        setHTML(box, rows.length ? html`<table><thead><tr><th>Time</th><th>Employee</th><th>PIN</th><th>Device</th><th>Source</th><th>Type</th></tr></thead><tbody>
          ${rows.map((r) => html`<tr><td class="time">${r.at}</td><td>${r.name || html`<span class="badge absent">Unknown PIN</span>`}</td><td class="num">${r.pin}</td><td>${r.device || '—'}</td><td>${r.source}</td>
            <td>${r.state === 0 ? 'Check-in' : r.state === 1 ? 'Check-out' : r.state ?? '—'}</td></tr>`)}</tbody></table>` : html`<p class="empty">No punches in this range.</p>`);
        return;
      }
      const { rows } = await get(`/attendance${qs({ from: f.from, to: f.to, userId: isMgr ? f.userId : '', department: f.department, status: f.status })}`);
      if (!rows.length) return setHTML(box, html`<p class="empty">No attendance records for these filters.</p>`);
      setHTML(box, html`<table><thead><tr><th>Date</th>${isMgr ? html`<th>Employee</th>` : ''}<th>Shift</th><th>In</th><th>Out</th><th class="r">Worked</th><th class="r">Late</th><th class="r">Early out</th><th class="r">Overtime</th><th>Status</th>${isMgr ? html`<th></th>` : ''}</tr></thead><tbody>
        ${rows.map((r) => html`<tr>
          <td>${fmtDate(r.work_date)}</td>
          ${isMgr ? html`<td class="nameCell"><b>${r.name}</b><span>${r.department}</span></td>` : ''}
          <td class="muted">${r.shift_name || '—'}</td>
          <td class="time">${r.check_in_local || '—'}</td>
          <td class="time">${r.check_out_local || (r.missing_checkout ? html`<span class="badge late">Missing</span>` : '—')}</td>
          <td class="r time">${fmtHours(r.worked_minutes)}</td><td class="r">${fmtMin(r.late_minutes)}</td><td class="r">${fmtMin(r.early_out_minutes)}</td>
          <td class="r">${r.overtime_minutes ? html`${fmtMin(r.overtime_minutes)}${r.off_day_work ? html` <span class="small muted">off day</span>` : ''}` : '—'}</td>
          <td>${badge(r.status)}</td>
          ${isMgr ? html`<td><button class="btn sm" data-fix data-uid="${r.user_id}" data-date="${r.work_date}" data-name="${r.name}" data-in="${r.check_in_local || ''}" data-out="${r.check_out_local || ''}">Correct</button></td>` : ''}
        </tr>`)}</tbody></table>`);
      $$('[data-fix]', box).forEach((b) => b.addEventListener('click', () => correct([b.dataset.uid, b.dataset.date, b.dataset.name, b.dataset.in, b.dataset.out])));
    } catch (e) { setHTML(box, html`<div class="notice bad" style="margin:16px">${e.message}</div>`); }
  };

  const correct = ([userId, date, name, inn, out]) => modal({
    title: `Correct attendance — ${name}`, submitLabel: 'Save correction',
    body: html`<p class="muted">${fmtDate(date)}. This replaces all punches recorded for the day and is written to the audit log.</p>
      <div class="form-grid"><label>Check-in<input type="time" name="checkIn" value="${inn}" required></label>
        <label>Check-out <span class="hint">(leave empty if still at work)</span><input type="time" name="checkOut" value="${out}"></label></div>
      <label>Reason<input type="text" name="reason" required minlength="3" placeholder="e.g. Forgot to punch, approved by manager"></label>`,
    onSubmit: async (form, close) => {
      const v = formValues(form);
      await post('/attendance/manual', { userId: Number(userId), date, checkIn: v.checkIn, checkOut: v.checkOut || null, reason: v.reason });
      close(); toast('Attendance corrected'); load();
    },
  });

  shell(); await load();
}
