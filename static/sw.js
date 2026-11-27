// App shell: cache-first (versioned). API: network-first, falling back to the
// last good response so the app still opens without signal (e.g. in a garage).
const VERSION = 'car-v11';
const SHELL = ['/', '/index.html', '/style.css?v=11', '/app.js?v=11',
  '/manifest.webmanifest', '/icons/icon-192-v4.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' so a stale HTTP-cached copy can't end up in the new shell
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'car-api').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear-api') caches.delete('car-api');
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open('car-api').then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || new Response(
      JSON.stringify({ error: 'You’re offline and this page hasn’t been loaded before.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }

  // Navigations always get the shell (hash routing lives client-side).
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(url.pathname + url.search, { cache: 'no-cache', credentials: 'same-origin' })
      .catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

// Notifications: show what the server sent; a tap opens (or focuses) the app on that screen.
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Car', {
    body: msg.body || '', tag: msg.tag, icon: '/icons/icon-192-v4.png', badge: '/icons/icon-192-v4.png',
    data: { url: msg.url || '/#/car' } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#/car', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus());
    return self.clients.openWindow(url);
  }));
});
