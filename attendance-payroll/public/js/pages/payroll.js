import { get, post, del, download } from '../api.js';
import { html, setHTML, $, $$, fmtMoney, fmtMonth, fmtDateLong, badge, toast, modal, formValues, confirmDialog } from '../ui.js';

const prevMonthOf = (today) => { const [y, m] = today.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export async function render(view, state) {
  return ['admin', 'hr'].includes(state.user.role) ? manager(view, state) : staff(view, state);
}

/* ---------- Staff: own finalised payslips ---------- */
async function staff(view, state) {
  const { payslips } = await get('/payroll/my-payslips');
  setHTML(view, html`<section class="panel"><header><h2>My payslips</h2></header><div class="body flush table-wrap">
    ${payslips.length ? html`<table><thead><tr><th>Month</th><th class="r">Gross</th><th class="r">Deductions</th><th class="r">Net pay</th><th></th></tr></thead><tbody>
      ${payslips.map((p) => html`<tr><td><b>${fmtMonth(p.month)}</b></td><td class="r">${fmtMoney(p.gross)}</td><td class="r">${fmtMoney(p.total_deductions)}</td><td class="r"><b>${fmtMoney(p.net_pay)}</b></td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-view="${p.id}">Details</button><button class="btn sm" data-pdf="${p.id}">PDF</button></td></tr>`)}</tbody></table>`
      : html`<p class="empty">No payslips yet. They appear here once payroll for a month is finalised.</p>`}</div></section>`);
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => showSlip(b.dataset.view, state)));
  $$('[data-pdf]', view).forEach((b) => b.addEventListener('click', () => download(`/payroll/payslips/${b.dataset.pdf}/pdf`).catch((e) => toast(e.message, 'bad'))));
}

async function showSlip(id, state) {
  const { payslip: p } = await get(`/payroll/payslips/${id}`);
  const b = p.breakdown || {};
  const cur = state.meta.currency;
  modal({
    title: `${p.name} — ${fmtMonth(p.month)}`, cancelLabel: 'Close',
    body: html`
      ${p.run_status !== 'finalized' ? html`<div class="notice">Draft: numbers can still change until payroll is finalised.</div>` : ''}
      <div class="cols-eq" style="gap:24px">
        <div><h3 style="margin-bottom:8px">Earnings</h3><dl class="kv"><dt>Base pay${b.workingDaysActual < b.workingDaysFull ? ` (${b.workingDaysActual}/${b.workingDaysFull} days)` : ''}</dt><dd>${fmtMoney(p.base_pay)}</dd>
          <dt>Allowances</dt><dd>${fmtMoney(p.allowances)}</dd>
          <dt>Overtime${b.overtimeMinutes || b.offDayOvertimeMinutes ? ` (${((b.overtimeMinutes + b.offDayOvertimeMinutes) / 60).toFixed(1)} h)` : ''}</dt><dd>${fmtMoney(p.overtime_pay)}</dd>
          <dt>Bonus${b.attendanceBonus ? ' (incl. attendance)' : ''}</dt><dd>${fmtMoney(p.bonus)}</dd><dt class="total">Gross</dt><dd class="total">${fmtMoney(p.gross)}</dd></dl></div>
        <div><h3 style="margin-bottom:8px">Deductions</h3><dl class="kv"><dt>Absence / unpaid (${(b.absentDays || 0) + (b.unpaidLeaveDays || 0) + (b.halfDays || 0) * 0.5} d)</dt><dd>${fmtMoney(p.absence_deduction)}</dd>
          <dt>Late (${b.lateCount || 0} late → ${b.lateDeductionDays || 0} d)</dt><dd>${fmtMoney(p.late_deduction)}</dd>
          <dt>Provident fund</dt><dd>${fmtMoney(p.pf_deduction)}</dd><dt>Income tax</dt><dd>${fmtMoney(p.tax_deduction)}</dd>
          <dt>Other</dt><dd>${fmtMoney(p.other_deduction)}</dd><dt class="total">Total</dt><dd class="total">${fmtMoney(p.total_deductions)}</dd></dl></div>
      </div>
      <p style="font-size:18px;margin:6px 0 0"><b>Net pay ${cur} ${fmtMoney(p.net_pay)}</b></p>
      ${b.negativeNetClamped ? html`<div class="notice">Deductions exceeded earnings; net pay is shown as zero.</div>` : ''}`,
  });
}

/* ---------- HR / Admin ---------- */
async function manager(view, state) {
  const isAdmin = state.user.role === 'admin';
  let month = prevMonthOf(state.meta.today);
  const users = (await get('/users?active=true')).users;

  const draw = async () => {
    const [{ runs }, run] = await Promise.all([get('/payroll/runs'), get(`/payroll/runs/${month}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)))]);
    const adj = (await get(`/payroll/adjustments?month=${month}`)).adjustments;
    const r = run?.run;
    const finalized = r?.status === 'finalized';
    setHTML(view, html`
      <div class="stack">
        <div class="row between">
          <form class="filters" id="mform" style="margin:0"><label>Payroll month<input type="month" name="month" value="${month}" max="${state.meta.today.slice(0, 7)}"></label></form>
          <div class="row">
            ${r ? html`<span>${badge(r.status)}${r.partial ? html` <span class="badge late">Partial month</span>` : ''}</span>` : ''}
            ${finalized ? '' : html`<button class="btn ${r ? '' : 'primary'}" id="gen">${r ? 'Regenerate' : 'Generate payroll'}</button>`}
            ${r && !finalized && isAdmin ? html`<button class="btn primary" id="fin">Finalise</button>` : ''}
            ${r ? html`<button class="btn" id="xl">Excel</button><button class="btn" id="pdf">PDF register</button>` : ''}
          </div>
        </div>
        ${r && !finalized && !isAdmin ? html`<div class="notice info">An Admin finalises payroll after HR has prepared it.</div>` : ''}
        ${r?.partial && !finalized ? html`<div class="notice">This month is not over yet, so the figures are provisional and it cannot be finalised until the month ends.</div>` : ''}
        ${run ? html`
          <section class="ledger four"><div><div class="n">${run.slips.length}</div><div class="l">Employees</div></div>
            <div><div class="n">${fmtMoney(run.totals.gross)}</div><div class="l">Gross</div></div><div><div class="n">${fmtMoney(run.totals.deductions)}</div><div class="l">Deductions</div></div>
            <div class="present"><div class="n">${fmtMoney(run.totals.net)}</div><div class="l">Net payable</div></div></section>
          <section class="panel"><div class="body flush table-wrap"><table><thead><tr><th>Employee</th><th class="r">Base</th><th class="r">Allow.</th><th class="r">Overtime</th><th class="r">Bonus</th><th class="r">Gross</th><th class="r">Absence</th><th class="r">Late</th><th class="r">PF</th><th class="r">Tax</th><th class="r">Other</th><th class="r">Net pay</th><th></th></tr></thead><tbody>
            ${run.slips.map((s) => html`<tr><td class="nameCell"><b>${s.name}</b><span>${s.employee_code} · ${s.department}</span></td>
              ${['base_pay', 'allowances', 'overtime_pay', 'bonus', 'gross', 'absence_deduction', 'late_deduction', 'pf_deduction', 'tax_deduction', 'other_deduction'].map((k) => html`<td class="r">${fmtMoney(s[k])}</td>`)}
              <td class="r"><b>${fmtMoney(s.net_pay)}</b></td><td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-view="${s.id}">Details</button><button class="btn sm" data-pdf="${s.id}">PDF</button></td></tr>`)}</tbody></table></div></section>`
        : html`<div class="empty panel">No payroll has been generated for ${fmtMonth(month)}. Generate it to calculate salary, overtime, bonuses and deductions from attendance.</div>`}

        <div class="cols-2">
          <section class="panel"><header><h2>Bonuses and manual deductions · ${fmtMonth(month)}</h2></header><div class="body flush table-wrap">
            ${adj.length ? html`<table><thead><tr><th>Employee</th><th>Type</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead><tbody>
              ${adj.map((a) => html`<tr><td>${a.name}</td><td>${badge(a.kind === 'bonus' ? 'approved' : 'rejected', a.kind === 'bonus' ? 'Bonus' : 'Deduction')}</td><td class="r">${fmtMoney(a.amount)}</td><td class="wrap small muted">${a.note}</td>
                <td>${finalized ? '' : html`<button class="btn sm danger" data-deladj="${a.id}">Remove</button>`}</td></tr>`)}</tbody></table>` : html`<p class="empty">None for this month.</p>`}</div></section>
          <section class="panel"><header><h2>Add adjustment</h2></header><div class="body">
            ${finalized ? html`<p class="muted">Payroll is finalised; adjustments are locked.</p>` : html`<form id="adj" class="stack" style="gap:12px">
              <label>Employee<select name="userId" required>${users.map((u) => html`<option value="${u.id}">${u.name}</option>`)}</select></label>
              <div class="form-grid"><label>Type<select name="kind"><option value="bonus">Bonus</option><option value="deduction">Deduction</option></select></label>
                <label>Amount<input type="number" name="amount" min="0.01" step="0.01" required></label></div>
              <label>Note<input type="text" name="note" required minlength="2" maxlength="200" placeholder="e.g. Project delivery bonus"></label>
              <button class="btn" type="submit">Add</button><p class="small muted">Regenerate the payroll afterwards to apply it.</p></form>`}</div></section>
        </div>

        <section class="panel"><header><h2>Payroll runs</h2></header><div class="body flush table-wrap">
          ${runs.length ? html`<table><thead><tr><th>Month</th><th>Status</th><th class="r">Employees</th><th class="r">Net payable</th><th>Generated</th><th></th></tr></thead><tbody>
            ${runs.map((x) => html`<tr><td><b>${fmtMonth(x.month)}</b></td><td>${badge(x.status)}${x.partial && x.status === 'draft' ? ' (partial)' : ''}</td><td class="r">${x.employees}</td><td class="r">${fmtMoney(x.net_total)}</td>
              <td class="muted">${fmtDateLong(x.generated_at)}</td><td><button class="btn sm" data-open="${x.month}">Open</button></td></tr>`)}</tbody></table>` : html`<p class="empty">No runs yet.</p>`}</div></section>
      </div>`);

    $('#mform').month.addEventListener('change', (e) => { if (e.target.value) { month = e.target.value; draw(); } });
    $('#gen')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const g = await post(`/payroll/runs/${month}/generate`); toast(`Payroll calculated for ${g.employees} employees`); } catch (ex) { toast(ex.message, 'bad'); }
      draw();
    });
    $('#fin')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Finalise ${fmtMonth(month)}?`, 'Employees will be able to see their payslips and the month is locked: no regeneration or adjustments afterwards.', { confirmLabel: 'Finalise payroll' }))) return;
      try { await post(`/payroll/runs/${month}/finalize`); toast('Payroll finalised'); } catch (ex) { toast(ex.message, 'bad'); }
      draw();
    });
    $('#xl')?.addEventListener('click', () => download(`/reports/payroll?format=xlsx&month=${month}`).catch((e) => toast(e.message, 'bad')));
    $('#pdf')?.addEventListener('click', () => download(`/reports/payroll?format=pdf&month=${month}`).catch((e) => toast(e.message, 'bad')));
    $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => showSlip(b.dataset.view, state)));
    $$('[data-pdf]', view).forEach((b) => b.addEventListener('click', () => download(`/payroll/payslips/${b.dataset.pdf}/pdf`).catch((e) => toast(e.message, 'bad'))));
    $$('[data-open]', view).forEach((b) => b.addEventListener('click', () => { month = b.dataset.open; draw(); window.scrollTo(0, 0); }));
    $$('[data-deladj]', view).forEach((b) => b.addEventListener('click', async () => { try { await del(`/payroll/adjustments/${b.dataset.deladj}`); toast('Removed'); draw(); } catch (e) { toast(e.message, 'bad'); } }));
    $('#adj')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      try { await post('/payroll/adjustments', { userId: Number(v.userId), month, kind: v.kind, amount: Number(v.amount), note: v.note }); toast('Adjustment added. Regenerate payroll to apply it.'); draw(); } catch (ex) { toast(ex.message, 'bad'); }
    });
  };
  await draw();
}
