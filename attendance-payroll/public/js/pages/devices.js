import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, badge, ago, toast, modal, formValues, confirmDialog } from '../ui.js';

export async function render(view, state) {
  let timer;

  const load = async () => {
    const { devices } = await get('/devices');
    const host = location.hostname;
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    setHTML(view, html`
      <div class="stack">
        <div class="row between"><p class="muted" style="margin:0;max-width:60em">Connect each ZKTeco device in <b>push (ADMS)</b> mode, or let the server poll an HTTP API. Change an IP address or API URL here at any time; it is stored in the database and used immediately.</p>
          <button class="btn primary" id="add">Add device</button></div>
        ${devices.some((d) => !d.approved) ? html`<div class="notice">A device that contacted the server is waiting for approval. Its punches are ignored until you approve it.</div>` : ''}
        <section class="panel"><div class="body flush table-wrap">
          ${devices.length ? html`<table><thead><tr><th>Device</th><th>Mode</th><th>IP address / API URL</th><th>Status</th><th class="r">Punches (24 h)</th><th></th></tr></thead><tbody>
            ${devices.map((d) => html`<tr><td class="nameCell"><b>${d.name}</b><span>${d.serial_number}${d.location ? ' · ' + d.location : ''}</span></td>
              <td>${d.protocol === 'adms' ? 'ADMS push' : 'HTTP pull'}</td>
              <td class="wrap small"><span class="num">${d.ip_address ? d.ip_address + (d.port ? ':' + d.port : '') : ''}</span>${d.ip_address && d.api_url ? html`<br>` : ''}${d.api_url ? html`<span class="muted">${d.api_url}</span>` : ''}${!d.ip_address && !d.api_url ? html`<span class="muted">Not set</span>` : ''}
                ${d.enforce_ip ? html`<br><span class="badge present">Source IP enforced</span>` : ''}</td>
              <td>${!d.approved ? badge('pending', 'Needs approval') : !d.active ? badge('inactive', 'Disabled') : badge(d.online ? 'online' : 'offline')}
                <div class="small muted">${d.last_seen ? 'seen ' + ago(d.last_seen) : 'never seen'}${d.last_ip ? ' from ' + d.last_ip : ''}</div>
                ${d.last_poll_error ? html`<div class="small" style="color:var(--bad)">Poll error: ${d.last_poll_error}</div>` : ''}</td>
              <td class="r">${d.punches_24h}</td>
              <td><div class="row" style="flex-wrap:wrap;max-width:250px;gap:6px">${!d.approved ? html`<button class="btn sm primary" data-approve="${d.id}">Approve</button>` : ''}
                <button class="btn sm" data-edit="${d.id}">Edit</button><button class="btn sm" data-test="${d.id}">Test</button>
                ${d.protocol === 'http-pull' && d.approved ? html`<button class="btn sm" data-poll="${d.id}">Poll now</button>` : ''}
                <button class="btn sm danger" data-del="${d.id}" data-name="${d.name}">Remove</button></div></td></tr>`)}</tbody></table>`
            : html`<p class="empty">No devices yet. Add one, or point a device at this server and approve it when it appears.</p>`}</div></section>
        <section class="panel"><header><h2>Pointing a ZKTeco uFace800 at this server</h2></header><div class="body">
          <ol style="margin:0;padding-left:20px;display:grid;gap:6px">
            <li>On the device open <b>Menu → Comm. → Cloud Server Setting</b> (labelled <i>ADMS</i> on some firmware).</li>
            <li>Set <b>Server address</b> to <span class="num"><b>${host}</b></span> and <b>Server port</b> to <span class="num"><b>${port}</b></span>. Leave HTTPS off — the device speaks plain HTTP to this port.</li>
            <li>Enable <b>Proxy / Domain name</b> only if you used a hostname rather than an IP address.</li>
            <li>Enrol each person on the device using the <b>Device PIN</b> shown on the Employees page.</li>
            <li>Save. The device appears here within a minute; approve it and punches start flowing.</li>
          </ol>
          <p class="small muted" style="margin:12px 0 0">Endpoint used by the device: <span class="num">POST ${location.origin}/iclock/cdata?SN=&lt;serial&gt;&amp;table=ATTLOG</span> (also available as <span class="num">/api/adms/push</span>). Test without hardware: <span class="num">npm run simulate -- --pin 1004</span>.</p>
        </div></section>
      </div>`);

    $('#add').addEventListener('click', () => edit(null));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(devices.find((d) => String(d.id) === b.dataset.edit))));
    $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => { try { await post(`/devices/${b.dataset.approve}/approve`); toast('Device approved'); load(); } catch (e) { toast(e.message, 'bad'); } }));
    $$('[data-test]').forEach((b) => b.addEventListener('click', () => test(b.dataset.test)));
    $$('[data-poll]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await post(`/devices/${b.dataset.poll}/poll`); toast(r.ok ? `Polled: ${r.inserted} new punch(es)` : `Poll failed: ${r.error}`, r.ok ? 'ok' : 'bad'); load(); } catch (e) { toast(e.message, 'bad'); }
    }));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove ${b.dataset.name}?`, 'Past punches are kept. If the device still points at this server it will reappear as a new, unapproved device.', { confirmLabel: 'Remove', danger: true }))) return;
      try { await del(`/devices/${b.dataset.del}`); toast('Device removed'); load(); } catch (e) { toast(e.message, 'bad'); }
    }));
  };

  const test = async (id) => {
    toast('Testing connection…');
    try {
      const r = await post(`/devices/${id}/test`);
      const lines = [];
      if (r.error) lines.push(r.error);
      if (r.tcp) lines.push(r.tcp.ok ? `Device port reachable (${r.tcp.ms} ms)` : `Device port not reachable: ${r.tcp.error}`);
      if (r.http) lines.push(r.http.ok ? `API responded HTTP ${r.http.status} (${r.http.ms} ms)` : `API not reachable: ${r.http.error || 'HTTP ' + r.http.status}`);
      const ok = (r.tcp ? r.tcp.ok : true) && (r.http ? r.http.ok : true) && !r.error;
      modal({ title: ok ? 'Connection OK' : 'Connection problem', cancelLabel: 'Close', narrow: true,
        body: html`${lines.map((l) => html`<p>${l}</p>`)}${!ok ? html`<p class="small muted">An ADMS device that pushes to the server does not need to be reachable from here — this test only checks the address stored in the dashboard.</p>` : ''}` });
    } catch (e) { toast(e.message, 'bad'); }
  };

  const edit = (d) => {
    const isNew = !d;
    modal({
      title: isNew ? 'Add device' : `Edit ${d.name}`, submitLabel: isNew ? 'Add device' : 'Save changes',
      body: html`<div class="form-grid">
        <label>Name<input type="text" name="name" required maxlength="80" value="${d?.name || ''}" placeholder="Main entrance"></label>
        <label>Serial number <span class="hint">Printed on the device, shown in its menu under Device Info.</span><input type="text" name="serialNumber" required value="${d?.serial_number || ''}"></label>
        <label>Model<input type="text" name="model" value="${d?.model || 'ZKTeco uFace800'}"></label>
        <label>Location<input type="text" name="location" value="${d?.location || ''}"></label>
        <label class="wide">Connection mode<select name="protocol"><option value="adms" ${d?.protocol !== 'http-pull' ? 'selected' : ''}>ADMS push — the device sends punches to this server (recommended)</option>
          <option value="http-pull" ${d?.protocol === 'http-pull' ? 'selected' : ''}>HTTP pull — this server fetches punches from an API URL</option></select></label>
        <label>IP address <span class="hint">Device address on your network</span><input type="text" name="ipAddress" value="${d?.ip_address || ''}" placeholder="192.168.1.201"></label>
        <label>Port<input type="number" name="port" min="1" max="65535" value="${d?.port || ''}" placeholder="4370"></label>
        <label class="wide">API URL <span class="hint">Required for HTTP pull. Must return JSON punches (see README).</span><input type="text" name="apiUrl" value="${d?.api_url || ''}" placeholder="http://192.168.1.201/api/punches"></label>
        <label>Poll every (seconds)<input type="number" name="pollIntervalSec" min="10" value="${d?.poll_interval_sec || 60}"></label>
        <div class="checks" style="align-self:end"><label class="check"><input type="checkbox" name="enforceIp" ${d?.enforce_ip ? 'checked' : ''}> Only accept pushes from this IP</label>
          <label class="check"><input type="checkbox" name="active" ${d?.active !== false ? 'checked' : ''}> Enabled</label></div>
      </div>`,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const body = {
          name: v.name, serialNumber: v.serialNumber, model: v.model || 'ZKTeco uFace800', location: v.location || '', protocol: v.protocol,
          ipAddress: v.ipAddress || null, port: v.port ? Number(v.port) : null, apiUrl: v.apiUrl || null, enforceIp: !!v.enforceIp,
          pollIntervalSec: Number(v.pollIntervalSec || 60), active: !!v.active,
        };
        if (isNew) await post('/devices', body); else await put(`/devices/${d.id}`, { ...body, approved: d.approved });
        close(); toast(isNew ? 'Device added' : 'Device settings saved'); load();
      },
    });
  };

  await load();
  timer = setInterval(load, 20_000);
  return () => clearInterval(timer);
}
