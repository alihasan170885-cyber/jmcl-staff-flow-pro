// Mobile push: subscribe this browser/device to attendance exception alerts (Admin / HR).
import { get, post } from './api.js';

const b64ToBytes = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export function pushSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'Phone notifications need HTTPS. Open the app through your HTTPS address (see the README), or use localhost on this computer.' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'This browser does not support push notifications. On iPhone, add the app to the Home Screen first (iOS 16.4+).' };
  }
  return { ok: true };
}

export async function pushState() {
  const s = pushSupport();
  if (!s.ok) return { ...s, enabled: false };
  if (Notification.permission === 'denied') return { ok: false, reason: 'Notifications are blocked for this site. Allow them in the browser settings.', enabled: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { ok: true, enabled: !!sub };
}

export async function enablePush() {
  const s = pushSupport();
  if (!s.ok) throw new Error(s.reason);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted.');
  const { publicKey } = await get('/notifications/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await post('/notifications/push/subscribe', sub.toJSON());
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await post('/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}
