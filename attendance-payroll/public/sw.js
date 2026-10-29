/* Service worker: offline app shell + Web Push for attendance exceptions. */
const VERSION = 'v1';
const SHELL = `ap-shell-${VERSION}`;
const ASSETS = ['/', '/css/app.css', '/js/main.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/favicon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ap-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Never cache API data or device endpoints: attendance and payroll must always be live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/iclock/')) return;

  if (req.mode === 'navigate') {
    // Network first so a new deployment shows immediately; fall back to the cached shell when offline.
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  // Static assets: serve from cache, refresh in the background.
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Attendance alert', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Attendance alert';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.type ? `${data.type}-${data.id || ''}` : undefined,
    data: { url: data.url || '/' },
    requireInteraction: data.severity === 'critical',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(target);
    }),
  );
});
