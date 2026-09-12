// Glimt, chapter 1: wires GPS, clock, audio and the chapter script together.
// ?sim in the URL replaces GPS with a speed slider for testing at a desk.

import { Walk, Waiter } from './engine.js';
import { runChapter1 } from './chapter1.js';
import { Mixer, Library } from './audio.js';
import { chooseWorld, defaultWorld } from './world.js';

const params = new URLSearchParams(location.search);
const SIM = params.has('sim');

const CHAPTER_URL = '../stories/glimt/kapitel-1.json';
const VOICE_BASE = '../audio/glimt/vega/glimt-1';
const BED_URL = '../audio/glimt/bed/steep-dm.opus';
const RISER_URL = '../audio/glimt/fx/riser-sunbeams.opus';
const RISER_VOICE_AT = 0.7;   // Vega enters at 70 % of the riser

const SCENE_NAMES = {
  s0: 'Start', s1: 'Kontakt', s2: 'Stillhet', s3: 'Glimt',
  s4: 'Fortare', s5: 'Korsningen', s6: 'Landmärket', s7: 'Tillbaka',
};
const BAND_WORDS = { still: 'stilla', walk: 'gång', run: 'löpning' };

const $ = id => document.getElementById(id);

// ---------- state ----------
let mixer, lib, chapter;
let bedBuf = null, riserBuf = null;
let walk, waiter, world;
let t0 = 0;
let watchId = null, tickId = null, simId = null;
let wakeLock = null;
let pendingVoiceAt = null;
const logLines = [];
let finished = false;

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

// ---------- preload ----------
async function preload() {
  try {
    mixer = new Mixer();
    chapter = await (await fetch(CHAPTER_URL)).json();
    lib = new Library(mixer, VOICE_BASE);

    const [bedRaw, riserRaw, s0Raw] = await Promise.all([
      mixer.fetchBuffer(BED_URL).catch(() => null),
      mixer.fetchBuffer(RISER_URL).catch(() => null),
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
    $('load-note').textContent = notes.length
      ? `Ljudet saknar ${notes.join(' och ')} på den här adressen. Rösten fungerar ändå.`
      : 'Sätt på lurarna. Tryck när du står där du vill börja.';
    $('start-btn').textContent = 'Börja gå';
    $('start-btn').disabled = false;
  } catch (err) {
    $('load-note').textContent = 'Kunde inte ladda kapitlet: ' + err.message;
  }
}

// ---------- start ----------
async function start() {
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

  log(`start, variant ${variant.toUpperCase()}${SIM ? ', simulerad' : ''}`);
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
      $('scene').textContent = SCENE_NAMES[id.slice(0, 2)] || id;
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
    await runChapter1(ctx);
  } catch (err) {
    log('fel: ' + err.message);
  }
  finish();
}

function tick() {
  const s = walk.tick(now());
  waiter.check(s);
  mixer.setContact(s.contact);
  render(s);
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
  $('dist').textContent = s.distToStart === null ? 'start' :
    `${Math.round(s.distToStart)} m från start${s.approaching ? ', på väg tillbaka' : ''}`;
  $('gps').textContent = !s.gpsSeen ? 'väntar på gps' :
    s.accuracy === null ? 'gps' : `gps ±${Math.round(s.accuracy)} m`;
}

// ---------- GPS ----------
function startGps() {
  if (!navigator.geolocation) { log('gps stöds inte'); return; }
  let worldChosen = false;
  watchId = navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    walk.fix(now(), c);
    if (!worldChosen) {
      worldChosen = true;
      log(`gps: första fix ±${Math.round(c.accuracy)} m`);
      chooseWorld(world, { lat: c.latitude, lon: c.longitude, log }).catch(err => log('omvärld: ' + err.message));
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
  let worldChosen = false;
  simId = setInterval(() => {
    const v = parseFloat(speedEl.value);
    const accuracy = $('sim-fog').checked ? 80 : 8;
    lat += (v * Math.cos(heading)) / 111320;
    lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
    walk.fix(now(), { latitude: lat, longitude: lon, accuracy, speed: v });
    if (!worldChosen) {
      worldChosen = true;
      chooseWorld(world, { lat, lon, log }).catch(err => log('omvärld: ' + err.message));
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
(function initStartScreen() {
  let variant = 'a';
  try { variant = localStorage.getItem('glimt-variant') || 'a'; } catch (_) {}
  if (params.get('variant') === 'a' || params.get('variant') === 'b') variant = params.get('variant');
  if (variant !== 'a' && variant !== 'b') variant = 'a';
  document.querySelector(`input[name="variant"][value="${variant}"]`).checked = true;

  try {
    const last = localStorage.getItem('glimt-last-log');
    if (last) { $('last-log').textContent = last; $('last-log-box').hidden = false; }
  } catch (_) {}

  $('start-btn').addEventListener('click', start);
  preload();
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
