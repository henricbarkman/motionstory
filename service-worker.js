const CACHE = 'motionstory-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/styles.css',
  '/manifest.json',
  '/audio/pilgrimsvagen/scene-1.mp3',
  '/audio/pilgrimsvagen/scene-2.mp3',
  '/audio/pilgrimsvagen/scene-3.mp3',
  '/audio/pilgrimsvagen/scene-4.mp3'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
