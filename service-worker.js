// Bump CACHE whenever audio or app files change, otherwise an installed PWA
// keeps serving the old files forever.
const CACHE = 'motionstory-v3';

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
  './audio/pilgrimsvagen/scene-4.mp3',
  './glimt/',
  './glimt/index.html',
  './glimt/glimt.css',
  './glimt/app.js',
  './glimt/engine.js',
  './glimt/chapter1.js',
  './glimt/audio.js',
  './glimt/world.js',
  './stories/glimt/kapitel-1.json',
  // Present only where the Splice files are hosted; a miss must not fail the
  // rest of the precache, so assets are added one by one below.
  './audio/glimt/bed/steep-dm.opus',
  './audio/glimt/fx/riser-sunbeams.opus',
];

// Vega's lines come from the chapter file so the list cannot drift from it.
async function chapterAssets() {
  try {
    const res = await fetch('./stories/glimt/kapitel-1.json');
    const chapter = await res.json();
    return Object.keys(chapter.lines).map(id => `./audio/glimt/vega/${chapter.id}/${id}.mp3`);
  } catch (err) {
    console.warn('SW could not read chapter file:', err);
    return [];
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = ASSETS.concat(await chapterAssets());
    await Promise.all(urls.map(u => cache.add(u).catch(err => console.warn('SW skip', u, err.message))));
  })());
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

// Cache first for our own files. Third-party calls (weather, map) go straight
// to the network: caching a weather answer would make Vega describe an old day.
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
