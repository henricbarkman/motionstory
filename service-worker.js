// Bump CACHE whenever audio or app files change, otherwise an installed PWA
// keeps serving the old files forever.
const CACHE = 'motionstory-v2';

// Relative to the service worker scope. Absolute paths ('/audio/...') broke on
// GitHub Pages where the app lives under /motionstory/, so addAll failed and
// nothing was ever cached.
const ASSETS = [
  './',
  './index.html',
  './main.js',
  './styles.css',
  './manifest.json',
  './audio/pilgrimsvagen/scene-1.mp3',
  './audio/pilgrimsvagen/scene-2.mp3',
  './audio/pilgrimsvagen/scene-3.mp3',
  './audio/pilgrimsvagen/scene-4.mp3'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(err => console.warn('SW precache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// The page asks the controlling worker which build it is. Answering from here
// rather than listing caches in the page avoids reporting a half-finished
// update: only one worker controls the page, and it knows its own version.
self.addEventListener('message', e => {
  if (e.data === 'version' && e.source) {
    e.source.postMessage({ version: CACHE });
  }
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
