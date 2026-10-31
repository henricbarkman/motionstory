// Bump CACHE whenever audio or app files change, otherwise an installed PWA
// keeps serving the old files forever.
const CACHE = 'motionstory-v59';
// The private copies sit side by side on one origin (the portal) and share
// its CacheStorage. Each worker keeps its files under its own scope and
// clears only its own older caches, so opening one copy never empties
// another (or the portal's). A cache named the old way, without a scope, is
// this copy's when what it holds lies under this scope (a private copy's,
// motionstory-vNN-privat-<hash>), or when it is the public site's own
// (motionstory-vNN on Pages); another copy's old cache is left alone.
//
// Every lookup goes to STORE only. caches.match() searches every cache on
// the origin, oldest first, so an older cache left beside the new one would
// answer first, and a line re-rendered under its old name would play as it was.
// Their files are not moved over either, for the same reason.
const STORE = `${CACHE} ${self.registration.scope}`;
async function mine(k) {
  if (k.endsWith(` ${self.registration.scope}`) || /^motionstory-v\d+$/.test(k)) return true;
  if (!/^motionstory-v\d+-privat-[0-9a-f]+$/.test(k)) return false;
  // Someone else's cache that cannot be read is not this copy's to clear,
  // and must not stop the worker from taking the page.
  try {
    const held = await (await caches.open(k)).keys();
    return held.some(r => r.url.startsWith(self.registration.scope));
  } catch (err) {
    return false;
  }
}
// A page is the same page whatever its query (?kapitel=..., ?sim): the app
// reads the query itself, so offline the cached page answers for any of them.
const cached = req => caches.open(STORE)
  .then(c => c.match(req).then(r => r || (req.mode === 'navigate' ? c.match(req, { ignoreSearch: true }) : undefined)))
  .catch(() => undefined);

// Relative to the service worker scope. Absolute paths ('/audio/...') broke on
// GitHub Pages where the app lives under /motionstory/, so addAll failed and
// nothing was ever cached.
const ASSETS = [
  './',
  './index.html',
  './main.js',
  './styles.css',
  './design/glimt.css',
  './design/fonts/literata-normal.woff2',
  './design/fonts/literata-italic.woff2',
  './design/fonts/atkinson-next-normal.woff2',
  './design/fonts/atkinson-next-italic.woff2',
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
  './glimt/episod1.js',
  './glimt/episode2.js',
  './glimt/herside.js',
  './glimt/audio.js',
  './glimt/world.js',
  './glimt/lab.js',
  './glimt/synth.js',
  './glimt/memory.js',
  './glimt/listen.js',
  './glimt/bag.js',
  './stories/glimt/kapitel-1.json',
  './stories/glimt/kapitel-2.json',
  './stories/glimt/episod-1.json',
  './stories/glimt/episode-1.json',
  './stories/glimt/episode-2.json',
  './glimt/pauser.json',
  './stories/glimt/labb.json',
  './glimt/ljud.json',
];
// The English episodes (episode-1.json, episode-2.json) are left out, though
// they are the standard page since v54: the English page fetches all of an
// episode's lines when it opens, and the fetch handler keeps them then, so
// precaching their voices too would only download them twice.
const CHAPTER_FILES = ['./stories/glimt/kapitel-1.json', './stories/glimt/kapitel-2.json',
  './stories/glimt/episod-1.json', './stories/glimt/labb.json'];

// Vega's lines come from the chapter files so the list cannot drift from them.
// An episode's file also names the sounds of her side and its credits.
async function chapterAssets(file) {
  try {
    const res = await fetch(file, { cache: 'reload' });
    const chapter = await res.json();
    return Object.keys(chapter.lines).map(id => `./audio/glimt/vega/${chapter.id}/${id}.mp3`)
      .concat(Object.values(chapter.sfx || {}).map(sound => `./audio/glimt/side/${sound.file}`));
  } catch (err) {
    console.warn('SW could not read chapter file:', file, err);
    return [];
  }
}

// The bed, the riser and the credits' songs, where this copy has them
// (glimt/ljud.json: none in the public build, paths from the root).
async function extraAssets() {
  try {
    const res = await fetch('./glimt/ljud.json', { cache: 'reload' });
    const extra = await res.json();
    return [extra.bed, extra.riser, ...Object.values(extra.credits || {})].filter(Boolean).map(p => `./${p}`);
  } catch (err) {
    console.warn('SW could not read glimt/ljud.json:', err);
    return [];
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(STORE);
    const voices = await Promise.all(CHAPTER_FILES.map(chapterAssets));
    const urls = ASSETS.concat(...voices, await extraAssets());
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
        keys.filter(k => k !== STORE).map(async k => { if (await mine(k)) await caches.delete(k).catch(() => {}); })
      ))
      .catch(() => {})
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
    // A file not precached (the English episode's) is kept once fetched
    // whole, so the walk after works without signal too.
    e.respondWith(cached(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.status === 200) {
        const copy = res.clone();
        caches.open(STORE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    })));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(STORE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached(e.request))
  );
});
