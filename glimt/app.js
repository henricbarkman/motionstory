// Glimt: wires GPS, clock, audio and the chapter script together.
// ?sim in the URL replaces GPS with a speed slider for testing at a desk.
// ?kapitel=2 preselects a chapter; the start screen has the same choice.

import { Walk, Waiter } from './engine.js';
import { runChapter1 } from './chapter1.js';
import { runChapter2 } from './chapter2.js';
import { Mixer, Library } from './audio.js';
import { chooseWorld, defaultWorld } from './world.js';

const params = new URLSearchParams(location.search);
const SIM = params.has('sim');

const CHAPTERS = {
  1: {
    url: '../stories/glimt/kapitel-1.json',
    voices: '../audio/glimt/vega/glimt-1',
    run: runChapter1,
    subtitle: 'Kapitel 1. Ungefär tio minuter. Gå eller spring, stanna när du vill.',
    scenes: {
      s0: 'Start', s1: 'Kontakt', s2: 'Stillhet', s3: 'Glimt',
      s4: 'Fortare', s5: 'Korsningen', s6: 'Landmärket', s7: 'Tillbaka',
    },
  },
  2: {
    url: '../stories/glimt/kapitel-2.json',
    voices: '../audio/glimt/vega/glimt-2',
    run: runChapter2,
    subtitle: 'Kapitel 2. Ungefär tolv minuter. Hon ställer frågor. Stanna kort för ja, gå vidare för nej.',
    scenes: {
      s0: 'Start', s1: 'Koden', s2: 'Kontrollfrågan', s3: 'Ensam',
      s4: 'Dit', s5: 'På väg', s6: 'Framme', s7: 'Spring', s8: 'Det hon inte sa', s9: 'Tillbaka',
    },
  },
};
const BED_URL = '../audio/glimt/bed/steep-dm.opus';
const RISER_URL = '../audio/glimt/fx/riser-sunbeams.opus';
const RISER_VOICE_AT = 0.7;   // Vega enters at 70 % of the riser
const LANDMARK_KEY = 'glimt-landmark';

const BAND_WORDS = { still: 'stilla', walk: 'gång', run: 'löpning' };
const SPEED_SOURCE = { doppler: 'satellitfart', distance: 'räknat ur avstånd' };

const $ = id => document.getElementById(id);

// ---------- state ----------
let chapterNo = 1;
let mixer, lib, chapter;
let bedBuf = null, riserBuf = null;
let walk, waiter, world;
let t0 = 0;
let watchId = null, tickId = null, simId = null;
let wakeLock = null;
let pendingVoiceAt = null;
const logLines = [];
let finished = false;
// Every GPS fix time, for the half-minute line in the log. The first field
// test read a walker as still and the log could not say why.
let fixTimes = [];
let lastGpsLog = 0;
const GPS_LOG_EVERY = 30;

const now = () => (performance.now() - t0) / 1000;
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const kmh = v => (v * 3.6).toFixed(1).replace('.', ',') + ' km/h';

function log(msg) {
  const line = `${fmt(Math.max(0, now()))}  ${msg}`;
  logLines.push(line);
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = line.slice(0, line.indexOf('  '));
  li.appendChild(time);
  li.appendChild(document.createTextNode(msg));
  const ol = $('log');
  ol.appendChild(li);
  ol.scrollTop = ol.scrollHeight;
  try { localStorage.setItem('glimt-last-log', logLines.join('\n')); } catch (_) {}
}

// ---------- landmark memory between chapters ----------
function savedLandmark() {
  try {
    const raw = localStorage.getItem(LANDMARK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v.name === 'string' ? v : null;
  } catch (_) { return null; }
}

function saveLandmark(w) {
  if (!w.landmark) return;
  const c = w.landmarkCoord;
  const v = { name: w.landmark, lat: c ? c.lat : null, lon: c ? c.lon : null, at: Date.now() };
  try { localStorage.setItem(LANDMARK_KEY, JSON.stringify(v)); } catch (_) {}
}

// ---------- preload ----------
async function preload() {
  const def = CHAPTERS[chapterNo];
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Laddar…';
  try {
    if (!mixer) mixer = new Mixer();
    chapter = await (await fetch(def.url)).json();
    lib = new Library(mixer, def.voices);

    const [bedRaw, riserRaw, s0Raw] = await Promise.all([
      bedBuf ? null : mixer.fetchBuffer(BED_URL).catch(() => null),
      riserBuf ? null : mixer.fetchBuffer(RISER_URL).catch(() => null),
      lib.load('s0'),
    ]);
    if (!s0Raw) throw new Error('första repliken saknas (s0.mp3)');
    if (bedRaw) bedBuf = await mixer.decode(bedRaw);
    if (riserRaw) riserBuf = await mixer.decode(riserRaw);

    // The rest streams in behind the start button.
    lib.loadAll(Object.keys(chapter.lines));

    const notes = [];
    if (!bedBuf) notes.push('ingen bädd');
    if (!riserBuf) notes.push('ingen riser');
    let note = notes.length
      ? `Ljudet saknar ${notes.join(' och ')} på den här adressen. Rösten fungerar ändå.`
      : 'Sätt på lurarna. Tryck när du står där du vill börja.';
    if (chapterNo === 2) {
      const lm = savedLandmark();
      note += lm
        ? ' Hon minns platsen från kapitel 1.'
        : ' Inget landmärke sparat från kapitel 1 på den här telefonen, hon får be dig välja själv.';
    }
    $('load-note').textContent = note;
    $('start-btn').textContent = 'Börja gå';
    $('start-btn').disabled = false;
  } catch (err) {
    $('load-note').textContent = 'Kunde inte ladda kapitlet: ' + err.message;
  }
}

// ---------- start ----------
async function start() {
  const def = CHAPTERS[chapterNo];
  const variant = document.querySelector('input[name="variant"]:checked').value;
  try { localStorage.setItem('glimt-variant', variant); } catch (_) {}

  $('start-screen').hidden = true;
  $('walking').hidden = false;
  if (SIM) $('sim').hidden = false;

  await mixer.resume();
  t0 = performance.now();
  walk = new Walk();
  waiter = new Waiter();
  world = defaultWorld();

  log(`start, kapitel ${chapterNo}, variant ${variant.toUpperCase()}${SIM ? ', simulerad' : ''}`);
  window.glimt = { mixer, walk, world, lib };   // for debugging from the console

  if (bedBuf) mixer.startBed(bedBuf);
  if (riserBuf) {
    const at = mixer.playFx(riserBuf);
    pendingVoiceAt = at + riserBuf.duration * RISER_VOICE_AT;
  }

  acquireWakeLock();
  if (SIM) startSim(); else startGps();
  tickId = setInterval(tick, 250);

  const ctx = {
    variant,
    world,
    state: () => walk.state(),
    // After stop the aborted waits let the script run on to its end; its
    // scene marks must not land in the log after "avslutat".
    log: msg => { if (!finished) log(msg); },
    hold: on => { walk.contact.hold = on; },
    async play(id, { clear = false } = {}) {
      if (finished) return;
      const buf = await lib.buffer(id);
      if (!buf) { log(`replik saknas: ${id}`); return; }
      if (mixer.ctx.state === 'suspended') {
        try { await mixer.resume(); } catch (_) {}
        log(`ljud: kontexten var pausad (${mixer.ctx.state})`);
      }
      const at = pendingVoiceAt; pendingVoiceAt = null;
      $('scene').textContent = def.scenes[id.slice(0, 2)] || id;
      log(`▶ ${id}`);
      const why = await mixer.playVoice(buf, { clear, at });
      if (why === 'timeout') log(`ljud: ${id} nådde aldrig slutet, går vidare`);
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => mixer.fadeOut(s),
    async playQuiet(id) {
      const buf = await lib.buffer(id);
      if (buf) await mixer.playQuiet(buf);
    },
  };

  try {
    await def.run(ctx);
  } catch (err) {
    log('fel: ' + err.message);
  }
  finish();
}

// Runs once the first position is known. Chapter 1 asks the map and
// remembers the landmark; chapter 2 reuses it and walks towards it.
function onFirstPosition(lat, lon) {
  const opts = { lat, lon, log };
  if (chapterNo === 2) opts.landmark = savedLandmark();
  chooseWorld(world, opts).then(() => {
    if (chapterNo === 1) saveLandmark(world);
    if (world.landmarkCoord) {
      walk.setTarget({ latitude: world.landmarkCoord.lat, longitude: world.landmarkCoord.lon });
    }
  }).catch(err => log('omvärld: ' + err.message));
}

function tick() {
  const s = walk.tick(now());
  waiter.check(s);
  mixer.setContact(s.contact);
  render(s);
  if (s.t - lastGpsLog >= GPS_LOG_EVERY) {
    lastGpsLog = s.t;
    logGps(s);
  }
}

// One line per half minute: how often the phone reported, how well, and what
// the engine made of it. Enough to tell sparse fixes from a walker who stood.
function logGps(s) {
  fixTimes = fixTimes.filter(x => x >= s.t - GPS_LOG_EVERY);
  const n = fixTimes.length;
  const acc = s.accuracy === null ? '' : `, ±${Math.round(s.accuracy)} m`;
  const src = SPEED_SOURCE[walk.gps.source] ? ` (${SPEED_SOURCE[walk.gps.source]})` : '';
  log(`gps: ${n} ${n === 1 ? 'position' : 'positioner'} på ${GPS_LOG_EVERY} s${acc}, ${kmh(s.speed)}${src}, ${BAND_WORDS[s.band]}`);
}

function render(s) {
  const fill = $('contact-fill');
  fill.style.width = `${Math.round(s.contact * 100)}%`;
  fill.style.opacity = String(0.35 + 0.65 * s.contact);
  fill.style.boxShadow = `0 0 ${Math.round(2 + 10 * s.contact)}px rgba(200,210,255,${(0.15 + 0.4 * s.contact).toFixed(2)})`;
  $('contact-word').textContent =
    s.hold ? 'håller' :
    s.contact > 0.8 ? 'nära' :
    s.contact > 0.5 ? 'hör dig' :
    s.contact > 0.2 ? 'svagt' : 'borta';
  $('band').textContent = BAND_WORDS[s.band];
  $('speed').textContent = kmh(s.speed);
  $('elapsed').textContent = fmt(s.t);
  let dist = s.distToStart === null ? 'start' :
    `${Math.round(s.distToStart)} m från start${s.approaching ? ', på väg tillbaka' : ''}`;
  if (s.distToTarget !== null) dist += `, ${Math.round(s.distToTarget)} m till ${world.landmark}`;
  $('dist').textContent = dist;
  $('gps').textContent = !s.gpsSeen ? 'väntar på gps' :
    s.accuracy === null ? 'gps' : `gps ±${Math.round(s.accuracy)} m`;
}

// ---------- GPS ----------
function startGps() {
  if (!navigator.geolocation) { log('gps stöds inte'); return; }
  let first = true;
  watchId = navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    fixTimes.push(now());
    walk.fix(now(), c);
    if (first) {
      first = false;
      log(`gps: första fix ±${Math.round(c.accuracy)} m`);
      onFirstPosition(c.latitude, c.longitude);
    }
  }, err => {
    log('gps-fel: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

// ---------- simulator ----------
function startSim() {
  let lat = 59.38, lon = 13.5, heading = 0;
  const speedEl = $('sim-speed');
  const out = $('sim-out');
  speedEl.addEventListener('input', () => { out.textContent = kmh(parseFloat(speedEl.value)); });
  $('sim-turn').addEventListener('click', () => { heading += Math.PI; log('sim: vänder'); });
  let first = true;
  simId = setInterval(() => {
    const v = parseFloat(speedEl.value);
    const accuracy = $('sim-fog').checked ? 80 : 8;
    lat += (v * Math.cos(heading)) / 111320;
    lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
    fixTimes.push(now());
    walk.fix(now(), { latitude: lat, longitude: lon, accuracy, speed: v });
    if (first) {
      first = false;
      onFirstPosition(lat, lon);
    }
  }, 1000);
}

// ---------- end ----------
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(tickId);
  clearInterval(simId);
  if (waiter) waiter.abort();
  if (mixer) mixer.stopVoice();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('walking').hidden = true;
  $('done').hidden = false;
  $('final-log').textContent = logLines.join('\n');
}

let stopping = false;
$('stop-btn').addEventListener('click', async () => {
  if (stopping) return;
  stopping = true;
  $('stop-btn').disabled = true;
  log('avslutat av vandraren');
  await mixer.fadeOut(2);
  finish();
});

$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    $('copy-btn').textContent = 'Kopierad';
  } catch (_) {
    $('copy-btn').textContent = 'Markera texten och kopiera själv';
  }
});

// ---------- wake lock ----------
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    log('wake lock: ' + err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tickId !== null && !finished) {
    if (!wakeLock) acquireWakeLock();
    if (mixer && mixer.ctx.state === 'suspended') mixer.resume();
  }
});

// ---------- start screen ----------
function selectChapter(n) {
  chapterNo = CHAPTERS[n] ? n : 1;
  try { localStorage.setItem('glimt-chapter', String(chapterNo)); } catch (_) {}
  document.querySelector(`input[name="chapter"][value="${chapterNo}"]`).checked = true;
  $('subtitle').textContent = CHAPTERS[chapterNo].subtitle;
  document.title = `Glimt, kapitel ${chapterNo}`;
  preload();
}

(function initStartScreen() {
  let variant = 'a';
  try { variant = localStorage.getItem('glimt-variant') || 'a'; } catch (_) {}
  if (params.get('variant') === 'a' || params.get('variant') === 'b') variant = params.get('variant');
  if (variant !== 'a' && variant !== 'b') variant = 'a';
  document.querySelector(`input[name="variant"][value="${variant}"]`).checked = true;

  let ch = 1;
  try { ch = parseInt(localStorage.getItem('glimt-chapter') || '1', 10); } catch (_) {}
  if (params.has('kapitel')) ch = parseInt(params.get('kapitel'), 10);
  document.querySelectorAll('input[name="chapter"]').forEach(el => {
    el.addEventListener('change', () => selectChapter(parseInt(el.value, 10)));
  });

  try {
    const last = localStorage.getItem('glimt-last-log');
    if (last) { $('last-log').textContent = last; $('last-log-box').hidden = false; }
  } catch (_) {}

  $('start-btn').addEventListener('click', start);
  selectChapter(ch);
})();

// ---------- build stamp (same scheme as the root page) ----------
let buildAnswered = false;
function setBuild(text) { $('build').textContent = text; }
function askBuild() {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctrl) { setBuild('ingen (körs direkt från nätet)'); return; }
  ctrl.postMessage('version');
  setTimeout(() => { if (!buildAnswered) setBuild('äldre version (svarar inte)'); }, 2000);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.version) { buildAnswered = true; setBuild(e.data.version); }
  });
  navigator.serviceWorker.register('../service-worker.js').catch(err => console.warn('SW registration failed:', err));
  navigator.serviceWorker.ready.then(askBuild).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', askBuild);
} else {
  setBuild('service worker stöds inte');
}
