// App shell: session, navigation, notifications bell.
import { api, get, post, setAuthHandlers } from './api.js';
import { html, setHTML, $, $$, esc, icon, toast, modal, ago } from './ui.js';
import { pushState, enablePush, disablePush } from './push.js';

const app = $('#app');
export const state = { user: null, meta: null };

const MANAGER = ['admin', 'hr'];
const NAV = [
  { path: '/', label: 'Overview', icon: 'home', roles: ['admin', 'hr', 'staff'], staffLabel: 'Home' },
  { path: '/attendance', label: 'Attendance', icon: 'clock', roles: ['admin', 'hr', 'staff'] },
  { path: '/leave', label: 'Leave', icon: 'leave', roles: ['admin', 'hr', 'staff'] },
  { path: '/payroll', label: 'Payroll', icon: 'pay', roles: ['admin', 'hr', 'staff'], staffLabel: 'Payslips' },
  { path: '/reports', label: 'Reports', icon: 'report', roles: MANAGER },
  { path: '/employees', label: 'Employees', icon: 'people', roles: MANAGER },
  { path: '/devices', label: 'Devices', icon: 'device', roles: ['admin'] },
  { path: '/settings', label: 'Settings', icon: 'gear', roles: MANAGER },
];
const PAGES = {
  '/': () => import('./pages/dashboard.js'),
  '/attendance': () => import('./pages/attendance.js'),
  '/leave': () => import('./pages/leave.js'),
  '/payroll': () => import('./pages/payroll.js'),
  '/reports': () => import('./pages/reports.js'),
  '/employees': () => import('./pages/employees.js'),
  '/devices': () => import('./pages/devices.js'),
  '/settings': () => import('./pages/settings.js'),
};

let cleanup = null;
let pollTimer = null;

/* ---------- routing ---------- */
export function navigate(path, replace = false) {
  if (location.pathname === path) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

async function render() {
  if (!state.user) return showLogin();
  if (state.user.mustChangePassword) return showChangePassword(true);
  const nav = NAV.filter((n) => n.roles.includes(state.user.role));
  let path = location.pathname.replace(/\/$/, '') || '/';
  const item = nav.find((n) => n.path === path);
  if (!item) { path = '/'; history.replaceState({}, '', '/'); }

  if (!$('.shell')) buildShell(nav);
  $$('.nav a').forEach((a) => (a.getAttribute('href') === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const cur = nav.find((n) => n.path === path);
  $('#page-title').textContent = state.user.role === 'staff' && cur.staffLabel ? cur.staffLabel : cur.label;
  document.title = `${$('#page-title').textContent} · ${state.meta.company}`;

  const view = $('#view');
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  setHTML(view, html`<p class="muted">Loading…</p>`);
  try {
    const mod = await PAGES[path]();
    if ((location.pathname.replace(/\/$/, '') || '/') !== path) return; // navigated away while loading
    cleanup = (await mod.render(view, state)) || null;
  } catch (err) {
    setHTML(view, html`<div class="notice bad">${err.message || 'This page could not be loaded.'}</div>`);
  }
  view.focus?.({ preventScroll: true });
  window.scrollTo(0, 0);
}

function buildShell(nav) {
  const u = state.user;
  setHTML(app, html`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><img src="/icons/icon-192.png" alt=""><span>${state.meta.company}</span></div>
        <nav class="nav" aria-label="Main">
          ${nav.map((n) => html`<a href="${n.path}" data-link>${icon(n.icon)}<span>${u.role === 'staff' && n.staffLabel ? n.staffLabel : n.label}</span></a>`)}
        </nav>
        <div class="side-foot"><strong>${u.name}</strong>${u.role === 'hr' ? 'HR' : u.role === 'admin' ? 'Admin' : u.designation || 'Staff'}
          <div class="row" style="margin-top:8px"><button id="pw">Password</button><button id="logout">Sign out</button></div></div>
      </aside>
      <div class="main">
        <div class="topbar">
          <h1 id="page-title"></h1>
          <span class="date" id="today"></span>
          <button class="bell" id="bell" aria-label="Notifications" aria-haspopup="dialog">${icon('bell')}<span class="count" id="bell-count" hidden></span></button>
          <button class="btn sm" id="logout-m" style="display:none">Sign out</button>
        </div>
        <main class="view" id="view" tabindex="-1"></main>
      </div>
    </div>`);
  $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: state.meta.timezone });
  $('#logout').addEventListener('click', logout);
  $('#pw').addEventListener('click', () => showChangePassword(false));
  $('#bell').addEventListener('click', toggleNotifications);
  if (window.matchMedia('(max-width: 820px)').matches) { $('#logout-m').style.display = ''; $('#logout-m').addEventListener('click', logout); }
  startBellPolling();
}

/* ---------- auth screens ---------- */
function showLogin() {
  stopBellPolling();
  const m = state.meta;
  const demo = [['Admin', 'admin@company.test'], ['HR', 'hr@company.test'], ['Staff', 'staff@company.test']];
  setHTML(app, html`
    <div class="login">
      <div class="login-art">
        <div class="brand"><img src="/icons/icon-192.png" alt=""><span>${m.company}</span></div>
        <div>
          <h2>Know who is in, who is late, and what it costs.</h2>
          <div class="mini-ribbon" aria-hidden="true">
            <div><i style="left:18%;width:56%"></i></div><div><i class="l" style="left:30%;width:12%"></i><i style="left:42%;width:42%"></i></div>
            <div><i style="left:16%;width:52%"></i><i class="o" style="left:68%;width:14%"></i></div><div><i style="left:20%;width:50%"></i></div>
          </div>
          <p>Punches from the door reader flow into attendance, leave and payroll without re-entering anything.</p>
        </div>
        <span class="small" style="color:#7F91A3">Times shown in ${m.timezone}</span>
      </div>
      <div class="login-form">
        <form id="login" novalidate>
          <div><h1>Sign in</h1><p class="muted">Use the account your HR team created for you.</p></div>
          <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
          <div class="notice bad" id="login-error" hidden></div>
          <button class="btn primary" type="submit">Sign in</button>
          ${m.demo ? html`<div><p class="small muted" style="margin:10px 0 4px">Demo accounts (password <b>Demo@12345</b>)</p>
            <div class="demo-accounts">${demo.map(([l, e]) => html`<button type="button" class="btn sm" data-email="${e}">${l}</button>`)}</div></div>` : ''}
        </form>
      </div>
    </div>`);
  const form = $('#login');
  $$('[data-email]', form).forEach((b) => b.addEventListener('click', () => {
    form.email.value = b.dataset.email; form.password.value = 'Demo@12345'; form.requestSubmit();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error'); err.hidden = true;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const { user } = await post('/auth/login', { email: form.email.value.trim(), password: form.password.value });
      state.user = user;
      history.replaceState({}, '', '/');
      render();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
}

function showChangePassword(forced) {
  const m = modal({
    title: forced ? 'Set a new password to continue' : 'Change password', submitLabel: 'Update password', narrow: true,
    body: html`
      ${forced ? html`<p class="muted">Your password was set by an administrator. Choose your own before using the app.</p>` : ''}
      <label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></label>
      <label>Repeat new password<input type="password" name="again" autocomplete="new-password" required></label>`,
    onSubmit: async (f, close) => {
      if (f.newPassword.value !== f.again.value) throw new Error('The new passwords do not match');
      await post('/auth/change-password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
      state.user.mustChangePassword = false;
      close(); toast('Password updated'); render();
    },
  });
  if (forced) { $('[data-close]', m.form).hidden = true; $$('[data-close]', m.form).forEach((b) => (b.style.display = 'none')); }
}

async function logout() {
  await post('/auth/logout').catch(() => {});
  state.user = null; cleanupAll(); showLogin();
}
function cleanupAll() { if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; } stopBellPolling(); }

/* ---------- notifications ---------- */
async function refreshBell() {
  try {
    const { unread } = await get('/notifications');
    const c = $('#bell-count');
    if (!c) return;
    c.textContent = unread > 99 ? '99+' : unread; c.hidden = !unread;
  } catch { /* ignore transient errors */ }
}
function startBellPolling() { stopBellPolling(); refreshBell(); pollTimer = setInterval(refreshBell, 30_000); }
function stopBellPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function toggleNotifications() {
  const existing = $('#notif-pop');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'notif-pop'; pop.className = 'panel-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(pop);
  const close = (e) => { if (!pop.contains(e.target) && !e.target.closest('#bell')) { pop.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  await drawNotifications(pop);
}

async function drawNotifications(pop) {
  const { notifications } = await get('/notifications');
  const isMgr = MANAGER.includes(state.user.role);
  const ps = isMgr ? await pushState().catch(() => ({ ok: false, reason: '', enabled: false })) : null;
  setHTML(pop, html`
    <header><h2>Notifications</h2><button class="btn sm" id="read-all">Mark all read</button></header>
    ${isMgr ? html`<div class="notif" style="grid-template-columns:1fr;cursor:default">
      ${ps.enabled ? html`<div class="row between"><span>Phone alerts are on for this device.</span>
          <span class="row"><button class="btn sm" id="push-test">Send test</button><button class="btn sm" id="push-off">Turn off</button></span></div>`
        : ps.ok ? html`<div class="row between"><span>Get attendance exceptions on this device.</span><button class="btn sm primary" id="push-on">Turn on</button></div>`
        : html`<span class="small muted">${ps.reason}</span>`}
    </div>` : ''}
    ${notifications.length ? notifications.map((n) => html`
      <div class="notif ${n.severity} ${n.read_at ? 'read' : ''}" data-id="${n.id}" data-url="${n.url}" tabindex="0" role="button">
        <span class="dot"></span><div><b>${n.title}</b><span class="small">${n.body}</span><div class="small muted">${ago(n.created_at)}</div></div>
      </div>`) : html`<div class="empty">No notifications yet.</div>`}`);
  $('#read-all', pop)?.addEventListener('click', async () => { await post('/notifications/read-all'); refreshBell(); drawNotifications(pop); });
  $$('.notif[data-id]', pop).forEach((el) => {
    const go = async () => { await post(`/notifications/${el.dataset.id}/read`).catch(() => {}); refreshBell(); pop.remove(); navigate(el.dataset.url || '/'); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  const act = (sel, fn, ok) => $(sel, pop)?.addEventListener('click', async () => {
    try { await fn(); if (ok) toast(ok); drawNotifications(pop); } catch (e) { toast(e.message, 'bad'); }
  });
  act('#push-on', enablePush, 'Phone alerts turned on');
  act('#push-off', disablePush, 'Phone alerts turned off');
  act('#push-test', () => post('/notifications/push/test'), 'Test sent');
}

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setAuthHandlers(() => { if (state.user) { state.user = null; cleanupAll(); toast('Your session has expired. Please sign in again.', 'bad'); showLogin(); } }, () => { if (state.user) { state.user.mustChangePassword = true; render(); } });
  try { state.meta = await get('/meta'); } catch (e) {
    setHTML(app, html`<div class="view"><div class="notice bad">${e.message}</div></div>`); return;
  }
  try { state.user = (await get('/auth/me')).user; } catch { state.user = null; }
  render();
}
boot();
