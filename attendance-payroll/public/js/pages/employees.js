import { get, post, patch, qs } from '../api.js';
import { html, setHTML, $, $$, fmtMoney, fmtDateLong, badge, toast, modal, formValues, confirmDialog } from '../ui.js';

export async function render(view, state) {
  const isAdmin = state.user.role === 'admin';
  const f = { q: '', department: '', active: 'true' };
  const shifts = (await get('/org/shifts')).shifts;
  let departments = [];

  const secretDialog = (title, who, pw) => modal({
    title, cancelLabel: 'Done', narrow: true,
    body: html`<p>Share this temporary password with <b>${who}</b> securely. It is shown only once, and they must change it at first sign-in.</p><div class="secret">${pw}</div>`,
  });

  const load = async () => {
    const [{ users }, d] = await Promise.all([get(`/users${qs(f)}`), get('/users/departments')]);
    departments = d.departments;
    setHTML($('#list'), html`${users.length ? html`<table><thead><tr><th>Employee</th><th>Role</th><th>Device PIN</th><th>Shift</th><th class="r">Base salary</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td class="nameCell"><b>${u.name}</b><span>${u.employee_code} · ${u.department}${u.designation ? ', ' + u.designation : ''}</span></td>
        <td>${u.role === 'admin' ? 'Admin' : u.role === 'hr' ? 'HR' : 'Staff'}</td><td class="num">${u.device_pin}</td><td class="muted">${u.shift_name || html`<span class="badge late">No shift</span>`}</td>
        <td class="r">${fmtMoney(u.base_salary)}</td><td class="muted">${fmtDateLong(u.join_date)}</td><td>${badge(u.active ? 'active' : 'inactive', u.active ? 'Active' : 'Inactive')}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edit="${u.id}">Edit</button>
          ${isAdmin || u.role === 'staff' ? html`<button class="btn sm" data-reset="${u.id}" data-name="${u.name}">Reset password</button>` : ''}</td></tr>`)}</tbody></table>`
      : html`<p class="empty">No employees match.</p>`}`);
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(users.find((u) => String(u.id) === b.dataset.edit))));
    $$('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Reset password?', `${b.dataset.name} will be signed out of nothing until they next sign in, but their old password stops working immediately.`, { confirmLabel: 'Reset password', danger: true }))) return;
      try { const r = await post(`/users/${b.dataset.reset}/reset-password`); secretDialog('Temporary password', b.dataset.name, r.temporaryPassword); } catch (e) { toast(e.message, 'bad'); }
    }));
  };

  const edit = (u) => {
    const isNew = !u;
    const canRole = isAdmin;
    modal({
      title: isNew ? 'Add employee' : `Edit ${u.name}`, submitLabel: isNew ? 'Add employee' : 'Save changes',
      body: html`<div class="form-grid">
        <label>Full name<input type="text" name="name" required maxlength="120" value="${u?.name || ''}"></label>
        <label>Work email<input type="email" name="email" required value="${u?.email || ''}"></label>
        <label>Employee code<input type="text" name="employeeCode" required maxlength="32" value="${u?.employee_code || ''}"></label>
        <label>Device PIN <span class="hint">The user ID enrolled on the ZKTeco device. Digits only.</span><input type="text" name="devicePin" inputmode="numeric" pattern="[0-9]{1,9}" value="${u?.device_pin || ''}" placeholder="same as code if numeric"></label>
        <label>Department<input type="text" name="department" required list="depts" value="${u?.department || ''}"><datalist id="depts">${departments.map((d) => html`<option value="${d}">`)}</datalist></label>
        <label>Designation<input type="text" name="designation" value="${u?.designation || ''}"></label>
        <label>Role<select name="role" ${canRole ? '' : 'disabled'}>${[['staff', 'Staff'], ['hr', 'HR'], ['admin', 'Admin']].map(([v, l]) => html`<option value="${v}" ${(u?.role || 'staff') === v ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label>Shift<select name="shiftId"><option value="">No shift (not tracked)</option>${shifts.map((s) => html`<option value="${s.id}" ${u?.shift_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label>Base salary (monthly)<input type="number" name="baseSalary" min="0" step="0.01" value="${u?.base_salary ?? 0}"></label>
        <label>Allowances (monthly)<input type="number" name="allowances" min="0" step="0.01" value="${u?.allowances ?? 0}"></label>
        <label>Joining date<input type="date" name="joinDate" value="${u?.join_date || state.meta.today}"></label>
        ${isNew ? html`<label>Initial password <span class="hint">Leave empty to generate one</span><input type="text" name="password" minlength="8" autocomplete="off"></label>` : html`<label class="check" style="align-self:end"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>`}
      </div>`,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const body = {
          name: v.name, email: v.email, employeeCode: v.employeeCode, devicePin: v.devicePin, department: v.department, designation: v.designation || '',
          shiftId: v.shiftId ? Number(v.shiftId) : null, baseSalary: Number(v.baseSalary || 0), allowances: Number(v.allowances || 0), joinDate: v.joinDate,
          ...(canRole ? { role: v.role } : {}),
        };
        if (isNew) {
          const r = await post('/users', { ...body, password: v.password });
          close(); toast('Employee added'); await load();
          if (r.temporaryPassword) secretDialog('Employee added', v.name, r.temporaryPassword);
          if (r.matchedPunches) toast(`${r.matchedPunches} earlier punch(es) were matched to this PIN`);
        } else {
          await patch(`/users/${u.id}`, { ...body, active: v.active });
          close(); toast('Saved'); load();
        }
      },
    });
  };

  setHTML(view, html`<div class="stack">
    <form class="filters" id="filters">
      <label style="min-width:220px">Search<input type="text" name="q" placeholder="Name, code or email"></label>
      <label>Department<select name="department"><option value="">All</option></select></label>
      <label>Status<select name="active"><option value="true">Active</option><option value="false">Inactive</option><option value="">All</option></select></label>
      <button class="btn primary" type="submit">Search</button><span class="grow"></span><button class="btn primary" type="button" id="add">Add employee</button>
    </form>
    <section class="panel"><div class="body flush table-wrap" id="list"><p class="empty">Loading…</p></div></section></div>`);
  await load();
  const sel = $('#filters [name=department]');
  sel.innerHTML += departments.map((d) => `<option>${d.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</option>`).join('');
  $('#filters').addEventListener('submit', (e) => { e.preventDefault(); Object.assign(f, { q: e.target.q.value, department: e.target.department.value, active: e.target.active.value }); load(); });
  $('#add').addEventListener('click', () => edit(null));
}
