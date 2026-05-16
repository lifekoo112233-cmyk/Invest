const CACHE = 'grid-trader-v1';
self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(['/','index.html']).catch(()=>{}))
));
self.addEventListener('fetch', e => e.respondWith(
  caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('/index.html')))
));
