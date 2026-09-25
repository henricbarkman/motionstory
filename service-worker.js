// Bump CACHE whenever audio or app files change, otherwise an installed PWA
// keeps serving the old files forever.
const CACHE = 'motionstory-v10';

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
  './glimt/chapter2.js',
  './glimt/audio.js',
  './glimt/world.js',
  './glimt/lab.js',
  './glimt/synth.js',
  './glimt/memory.js',
  './stories/glimt/kapitel-1.json',
  './stories/glimt/kapitel-2.json',
  './stories/glimt/labb.json',
  './audio/glimt/bed/steep-dm.opus',
  './audio/glimt/fx/riser-sunbeams.opus',
];
const CHAPTER_FILES = ['./stories/glimt/kapitel-1.json', './stories/glimt/kapitel-2.json', './stories/glimt/labb.json'];

// Vega's lines come from the chapter files so the list cannot drift from them.
async function chapterAssets(file) {
  try {
    const res = await fetch(file, { cache: 'reload' });
    const chapter = await res.json();
    return Object.keys(chapter.lines).map(id => `./audio/glimt/vega/${chapter.id}/${id}.mp3`);
  } catch (err) {
    console.warn('SW could not read chapter file:', file, err);
    return [];
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const voices = await Promise.all(CHAPTER_FILES.map(chapterAssets));
    const urls = ASSETS.concat(...voices);
    // cache: 'reload' bypasses the HTTP cache so a new worker never precaches
    // a file the browser still had from the previous build.
    await Promise.all(urls.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('SW skip', u, err.message))
    ));
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

// Audio is cache first: it is large, it does not change without a CACHE bump,
// and it must work with no signal. App files are network first with the cache
// as fallback, so an edit reaches the phone on the next load instead of
// waiting for a bump (a cached app.js hid two fixes during local testing).
// Third-party calls (weather, map) are left alone: caching a weather answer
// would make Vega describe an old day.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (/\.(mp3|opus)$/.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
