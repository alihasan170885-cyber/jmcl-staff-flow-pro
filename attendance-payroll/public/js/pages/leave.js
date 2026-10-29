import { get, post } from '../api.js';
import { html, setHTML, $, $$, fmtDateLong, badge, toast, modal, formValues, confirmDialog } from '../ui.js';

export async function render(view, state) {
  const isMgr = ['admin', 'hr'].includes(state.user.role);
  let tab = 'mine';

  const frame = async () => {
    const [bal, types] = await Promise.all([get('/leave/balances'), get('/org/leave-types')]);
    const pending = isMgr ? (await get('/leave/requests?scope=pending')).requests.length : 0;
    setHTML(view, html`
      <div class="stack">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="mine" aria-selected="${tab === 'mine'}">My leave</button>
          ${isMgr ? html`<button role="tab" data-tab="approvals" aria-selected="${tab === 'approvals'}">Approvals${pending ? ` (${pending})` : ''}</button>
            <button role="tab" data-tab="all" aria-selected="${tab === 'all'}">All requests</button>` : ''}
        </div>
        <div id="tab"></div>
      </div>`);
    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; frame(); }));
    if (tab === 'mine') await mine(bal, types.leaveTypes); else await queue(tab);
  };

  const mine = async (bal, types) => {
    const { requests } = await get('/leave/requests?scope=mine');
    setHTML($('#tab'), html`
      <div class="cols-2">
        <section class="panel"><header><h2>My requests</h2></header><div class="body flush table-wrap">
          ${requests.length ? html`<table><thead><tr><th>Type</th><th>Dates</th><th class="r">Days</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>
            ${requests.map((r) => html`<tr><td>${r.type}</td><td>${fmtDateLong(r.start_date)}${r.start_date !== r.end_date ? ' → ' + fmtDateLong(r.end_date) : ''}${r.half_day ? ' (half day)' : ''}</td>
              <td class="r">${r.days}</td><td>${badge(r.status)}</td><td class="wrap small muted">${r.review_note || r.reason || ''}${r.reviewer ? html`<br>by ${r.reviewer}` : ''}</td>
              <td>${r.status === 'pending' ? html`<button class="btn sm" data-cancel="${r.id}">Cancel</button>` : ''}</td></tr>`)}</tbody></table>`
            : html`<p class="empty">You have not requested any leave yet.</p>`}</div></section>
        <div class="stack">
          <section class="panel"><header><h2>Balance ${bal.year}</h2></header><div class="body flush list-lines">
            ${bal.balances.map((b) => html`<div style="display:grid;grid-template-columns:1fr 90px auto;gap:12px;align-items:center"><span>${b.name}</span>
              <div class="bar ${b.available <= 1 ? 'warn' : ''}"><i style="width:${b.allocated ? Math.min(100, ((b.used + b.pending) / b.allocated) * 100) : 0}%"></i></div>
              <span class="num small"><b>${b.available}</b> of ${b.allocated}${b.pending ? html` <span class="muted">(${b.pending} pending)</span>` : ''}</span></div>`)}
            <div class="small muted" style="display:block">Unpaid leave has no balance; it is deducted from salary.</div></div></section>
          <section class="panel"><header><h2>Request leave</h2></header><div class="body"><form id="req" class="stack" style="gap:12px">
            <label>Type<select name="leaveTypeId" required>${types.filter((t) => t.active).map((t) => html`<option value="${t.id}">${t.name}${t.annual_quota === null ? ' (unpaid)' : ''}</option>`)}</select></label>
            <div class="form-grid"><label>From<input type="date" name="startDate" required value="${state.meta.today}"></label><label>To<input type="date" name="endDate" required value="${state.meta.today}"></label></div>
            <label class="check"><input type="checkbox" name="halfDay"> Half day <span class="hint">(single day only)</span></label>
            <label>Reason<textarea name="reason" maxlength="500" placeholder="Optional"></textarea></label>
            <button class="btn primary" type="submit">Submit request</button></form></div></section>
        </div>
      </div>`);
    const form = $('#req');
    form.startDate.addEventListener('change', () => { if (form.endDate.value < form.startDate.value) form.endDate.value = form.startDate.value; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try {
        const r = await post('/leave/requests', { leaveTypeId: Number(v.leaveTypeId), startDate: v.startDate, endDate: v.endDate, halfDay: !!v.halfDay, reason: v.reason || '' });
        toast(`Request submitted for ${r.days} day${r.days === 1 ? '' : 's'}`); frame();
      } catch (ex) { toast(ex.message, 'bad'); }
    });
    $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Cancel this request?', 'The request will be withdrawn.', { confirmLabel: 'Cancel request', danger: true }))) return;
      try { await post(`/leave/requests/${b.dataset.cancel}/cancel`); toast('Request cancelled'); frame(); } catch (ex) { toast(ex.message, 'bad'); }
    }));
  };

  const queue = async (which) => {
    const { requests } = await get(which === 'approvals' ? '/leave/requests?scope=pending' : '/leave/requests?scope=all');
    setHTML($('#tab'), html`<section class="panel"><div class="body flush table-wrap">
      ${requests.length ? html`<table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th class="r">Days</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>
        ${requests.map((r) => html`<tr><td class="nameCell"><b>${r.name}</b><span>${r.department}</span></td><td>${r.type}${r.paid ? '' : html` <span class="small muted">unpaid</span>`}</td>
          <td>${fmtDateLong(r.start_date)}${r.start_date !== r.end_date ? ' → ' + fmtDateLong(r.end_date) : ''}${r.half_day ? ' (half)' : ''}</td><td class="r">${r.days}</td><td>${badge(r.status)}</td>
          <td class="wrap small muted">${r.reason || ''}${r.review_note ? html`<br><i>${r.review_note}</i>` : ''}</td>
          <td>${r.status === 'pending' && r.user_id !== state.user.id ? html`<span class="row" style="flex-wrap:nowrap"><button class="btn sm primary" data-act="approve" data-id="${r.id}">Approve</button><button class="btn sm danger" data-act="reject" data-id="${r.id}">Reject</button></span>`
            : r.status === 'approved' ? html`<button class="btn sm" data-act="cancel" data-id="${r.id}">Cancel leave</button>` : ''}</td></tr>`)}</tbody></table>`
        : html`<p class="empty">${which === 'approvals' ? 'No requests are waiting for approval.' : 'No leave requests yet.'}</p>`}</div></section>`);
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.act, b.dataset.id)));
  };

  const decide = (act, id) => {
    if (act === 'cancel') {
      return confirmDialog('Cancel approved leave?', 'The days are returned to the employee’s balance and attendance is recalculated.', { confirmLabel: 'Cancel leave', danger: true })
        .then(async (ok) => { if (!ok) return; try { await post(`/leave/requests/${id}/cancel`); toast('Leave cancelled'); frame(); } catch (e) { toast(e.message, 'bad'); } });
    }
    modal({
      title: act === 'approve' ? 'Approve leave' : 'Reject leave', submitLabel: act === 'approve' ? 'Approve' : 'Reject', danger: act === 'reject', narrow: true,
      body: html`<label>Note to the employee <span class="hint">(optional)</span><input type="text" name="note" maxlength="300"></label>`,
      onSubmit: async (form, close) => { await post(`/leave/requests/${id}/${act}`, { note: formValues(form).note }); close(); toast(act === 'approve' ? 'Leave approved' : 'Leave rejected'); frame(); },
    });
  };

  await frame();
}
