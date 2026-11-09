// Keeps the page itself available when the phone has no internet.
// Church data is stored separately on the device and in Netlify.
const C = 'gc-shell-v3';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c => c.add('/')).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r)
      .then(res => { const cp = res.clone(); caches.open(C).then(c => c.put('/', cp)); return res; })
      .catch(() => caches.match('/'))
  );
});
