import { get, qs, download } from '../api.js';
import { html, setHTML, $, $$, toast, addDays, fmtMoney } from '../ui.js';

const KIND = (c) => (c.type === 'money' ? 'r' : c.type === 'int' || c.type === 'hours' ? 'r' : '');
const cell = (c, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return fmtMoney(v);
  if (c.type === 'hours') return (Math.round(((Number(v) || 0) / 60) * 100) / 100).toFixed(2);
  return v;
};

export async function render(view, state) {
  const [{ types }, deptRes, userRes] = await Promise.all([get('/reports/types'), get('/users/departments'), get('/users?active=true')]);
  const today = state.meta.today;
  const f = { type: 'attendance', from: addDays(today, -29), to: today, month: today.slice(0, 7), department: '', userId: '', status: '' };
  let report = null;
  let chosen = null; // selected column keys

  const params = (format) => qs({
    format, from: f.type === 'payroll' ? undefined : f.from, to: f.type === 'payroll' ? undefined : f.to, month: f.type === 'payroll' ? f.month : undefined,
    department: f.type === 'payroll' ? undefined : f.department, userId: f.type === 'payroll' ? undefined : f.userId,
    status: ['attendance', 'leave'].includes(f.type) ? f.status : undefined, columns: chosen && report && chosen.length !== report.columns.length ? chosen.join(',') : undefined,
  });

  const shell = () => {
    const isPay = f.type === 'payroll';
    setHTML(view, html`
      <div class="stack">
        <form class="filters panel" id="form" style="padding:16px;margin:0">
          <label>Report<select name="type">${types.map((t) => html`<option value="${t.key}" ${t.key === f.type ? 'selected' : ''}>${t.title}</option>`)}</select></label>
          ${isPay ? html`<label>Month<input type="month" name="month" value="${f.month}"></label>` : html`
            <label>From<input type="date" name="from" value="${f.from}"></label><label>To<input type="date" name="to" value="${f.to}"></label>
            <label>Department<select name="department"><option value="">All</option>${deptRes.departments.map((d) => html`<option ${d === f.department ? 'selected' : ''}>${d}</option>`)}</select></label>
            <label>Employee<select name="userId"><option value="">Everyone</option>${userRes.users.map((u) => html`<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${u.name}</option>`)}</select></label>`}
          ${f.type === 'attendance' ? html`<label>Status<select name="status"><option value="">All working days</option>${['present', 'late', 'half_day', 'absent', 'leave', 'unpaid_leave'].map((s) => html`<option value="${s}" ${s === f.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`)}</select></label>` : ''}
          ${f.type === 'leave' ? html`<label>Status<select name="status"><option value="">All</option>${['pending', 'approved', 'rejected', 'cancelled'].map((s) => html`<option ${s === f.status ? 'selected' : ''}>${s}</option>`)}</select></label>` : ''}
          <button class="btn primary" type="submit">Preview</button>
        </form>
        <div id="out"></div>
      </div>`);
    $('#form').addEventListener('submit', (e) => {
      e.preventDefault();
      const prevType = f.type;
      for (const el of e.target.elements) if (el.name) f[el.name] = el.value;
      if (prevType !== f.type) { report = null; chosen = null; shell(); return; }
      preview();
    });
    $('#form [name=type]').addEventListener('change', (e) => { f.type = e.target.value; f.status = ''; report = null; chosen = null; shell(); });
  };

  const preview = async () => {
    const out = $('#out');
    setHTML(out, html`<p class="muted">Building report…</p>`);
    try {
      report = await get(`/reports/${f.type}${params('json').replace(/&?columns=[^&]*/, '')}`);
      if (!chosen || chosen.some((k) => !report.columns.find((c) => c.key === k))) chosen = report.columns.map((c) => c.key);
      draw();
    } catch (e) { setHTML(out, html`<div class="notice bad">${e.message}</div>`); }
  };

  const draw = () => {
    const cols = report.columns.filter((c) => chosen.includes(c.key));
    setHTML($('#out'), html`
      <section class="panel">
        <header><div><h2>${report.title}</h2><span class="small muted">${report.subtitle || `${report.params.from} to ${report.params.to}`} · ${report.rows.length} rows</span></div>
          <div class="row"><button class="btn" id="xlsx">Download Excel</button><button class="btn primary" id="pdf">Download PDF</button></div></header>
        <div class="body" style="border-bottom:1px solid var(--line-2)"><div class="small muted" style="margin-bottom:6px">Columns to include</div>
          <div class="checks">${report.columns.map((c) => html`<label class="check"><input type="checkbox" data-col="${c.key}" ${chosen.includes(c.key) ? 'checked' : ''}> ${c.header}</label>`)}</div></div>
        <div class="body flush table-wrap" style="max-height:60vh">${report.rows.length ? html`<table><thead><tr>${cols.map((c) => html`<th class="${KIND(c)}">${c.header}</th>`)}</tr></thead>
          <tbody>${report.rows.slice(0, 200).map((r) => html`<tr>${cols.map((c) => html`<td class="${KIND(c)}">${cell(c, r[c.key])}</td>`)}</tr>`)}</tbody>
          <tfoot><tr>${cols.map((c, i) => html`<td class="${KIND(c)}">${i === 0 ? 'Total' : c.sum ? cell(c, report.totals[c.key]) : ''}</td>`)}</tr></tfoot></table>
          ${report.rows.length > 200 ? html`<p class="small muted" style="padding:10px 16px">Showing the first 200 rows. The downloaded file contains all ${report.rows.length}.</p>` : ''}`
          : html`<p class="empty">No records match these filters.</p>`}</div>
      </section>`);
    $$('[data-col]').forEach((cb) => cb.addEventListener('change', () => {
      chosen = report.columns.map((c) => c.key).filter((k) => $$('[data-col]').find((x) => x.dataset.col === k)?.checked);
      if (!chosen.length) { chosen = [report.columns[0].key]; }
      draw();
    }));
    const dl = (format) => download(`/reports/${f.type}${params(format)}`).catch((e) => toast(e.message, 'bad'));
    $('#xlsx').addEventListener('click', () => dl('xlsx'));
    $('#pdf').addEventListener('click', () => dl('pdf'));
  };

  shell();
  preview();
}
