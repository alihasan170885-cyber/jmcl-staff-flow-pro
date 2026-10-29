// Small UI toolkit: auto-escaping html`` templates, toasts, modals, formatting.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v === false || v === null || v === undefined ? '' : esc(v));

/** html`<b>${userText}</b>` — every interpolation is escaped unless it is itself html`` output. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? part(vals[i]) : ''); });
  return new Raw(out);
}
export const setHTML = (el, r) => { el.innerHTML = r instanceof Raw ? r.s : esc(r); return el; };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- formatting ---------- */
export const fmtMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtHours = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
export const fmtMin = (min) => (min ? `${min} min` : '—');
const D = (s) => new Date(`${s}T00:00:00Z`);
export const fmtDate = (s) => (s ? D(String(s).slice(0, 10)).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }) : '—');
export const fmtDateLong = (s) => (s ? D(String(s).slice(0, 10)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
export const fmtMonth = (m) => (m ? new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
export const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const STATUS_LABEL = {
  present: 'Present', late: 'Late', half_day: 'Half day', absent: 'Absent', leave: 'On leave', unpaid_leave: 'Unpaid leave',
  weekend: 'Weekly off', holiday: 'Holiday', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
  draft: 'Draft', finalized: 'Finalised', online: 'Online', offline: 'Offline', waiting: 'Not in yet',
};
export const badge = (status, label) => html`<span class="badge ${status}">${label || STATUS_LABEL[status] || status}</span>`;

/* ---------- toasts ---------- */
export function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'bad' ? 'bad' : ''}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6500 : 3500);
}

/* ---------- modal ---------- */
let lastFocus = null;
/**
 * modal({ title, body: html``, submitLabel, narrow, onSubmit(formData, close) })
 * Body is rendered inside a <form>; onSubmit may throw — the message is shown in the modal.
 */
export function modal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', narrow = false, onSubmit, onOpen, onClosed, danger = false }) {
  lastFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  setHTML(overlay, html`
    <form class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <header><h2>${title}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
      <div class="body">${body}<div class="notice bad" data-error hidden></div></div>
      <footer>
        <button type="button" class="btn" data-close>${cancelLabel}</button>
        ${onSubmit ? html`<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button>` : ''}
      </footer>
    </form>`);
  document.body.appendChild(overlay);
  const form = $('form', overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove(); document.removeEventListener('keydown', onKey); lastFocus?.focus?.(); onClosed?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $$('[data-close]', overlay).forEach((b) => b.addEventListener('click', close));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = $('button[type=submit]', form);
    const err = $('[data-error]', form);
    err.hidden = true; btn.disabled = true;
    try { await onSubmit(form, close); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  });
  (form.querySelector('input:not([type=hidden]), select, textarea') || form.querySelector('button'))?.focus();
  onOpen?.(form, close);
  return { close, form };
}

export const confirmDialog = (title, message, { confirmLabel = 'Confirm', danger = false } = {}) =>
  new Promise((resolve) => {
    let answer = false;
    modal({
      title, narrow: true, danger, submitLabel: confirmLabel, body: html`<p>${message}</p>`,
      onSubmit: async (f, close) => { answer = true; close(); },
      onClosed: () => resolve(answer),
    });
  });

/** Collect a form into a plain object (empty strings -> undefined; checkboxes -> booleans). */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value === '' ? undefined : el.value;
  }
  return out;
}

export const icon = (name) => raw({
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V10M12 21V4M19 21v-8"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.6 3.2 2.3 3.5 5.2"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M10 17h4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
}[name] || '');
