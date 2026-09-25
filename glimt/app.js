// Glimt: wires GPS, clock, audio and the chapter script together.
// ?sim in the URL replaces GPS with a speed slider for testing at a desk.
// ?kapitel=2 preselects a chapter, ?kapitel=labb1 the lab; the start screen
// has the same choice. ?bana=<id> runs a single lab station (ids in lab.js).

import { Walk, Waiter, simulatedMagnitude } from './engine.js';
import { runChapter1 } from './chapter1.js';
import { runChapter2 } from './chapter2.js';
import { runLab, labHelpers, LABS, TITLES } from './lab.js';
import { Synth, SilentSynth } from './synth.js';
import { Mixer, Library } from './audio.js';
import { chooseWorld, defaultWorld } from './world.js';
import { Memory, drawWorld, KEY_NAMES } from './memory.js';

const params = new URLSearchParams(location.search);
const SIM = params.has('sim');
const ONLY_STATION = TITLES[params.get('bana')] ? params.get('bana') : null;

const LAB_FILES = { url: '../stories/glimt/labb.json', voices: '../audio/glimt/vega/glimt-labb' };

const CHAPTERS = {
  labb1: {
    ...LAB_FILES, lab: 1, first: 'labb-intro-1',
    subtitle: 'Labb 1. Åtta korta banor, en sak i taget, ungefär tjugo minuter. Efteråt säger du vilka du vill göra igen.',
  },
  labb2: {
    ...LAB_FILES, lab: 2, first: 'labb-intro-2',
    subtitle: 'Labb 2. Sju korta banor om riktning, vändningar, knackningar och steg. Ungefär tjugo minuter. Efteråt säger du vilka du vill göra igen.',
  },
  1: {
    url: '../stories/glimt/kapitel-1.json',
    voices: '../audio/glimt/vega/glimt-1',
    first: 's0',
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
    first: 's0',
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
// 'doppler' is whatever the phone reports as speed. On a six-second fix it is
// not necessarily satellite Doppler, so the log does not claim it is.
const SPEED_SOURCE = { doppler: 'telefonens fart', distance: 'räknat ur avstånd' };

const $ = id => document.getElementById(id);

// ---------- state ----------
let chapterNo = '1';          // a key of CHAPTERS
let mixer, lib, chapter;
let sfx = null;
let labResults = [];
let lastDoubleSeen = -Infinity, doublesLogged = 0;
let bedBuf = null, riserBuf = null;
let walk, waiter, world;
let memory = null;
// A walk shorter than this is not remembered: opening the app and pressing
// Avsluta should not make her say you were just here.
const MEMORY_MIN_WALK = 60;     // s
const MEMORY_MAX_ACCURACY = 30; // m; a vaguer fix does not say which square
let t0 = 0;
let watchId = null, tickId = null, simId = null, motionSimId = null;
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

    const first = def.lab && ONLY_STATION ? 'labb-intro-en' : def.first;
    const [bedRaw, riserRaw, firstRaw] = await Promise.all([
      bedBuf ? null : mixer.fetchBuffer(BED_URL).catch(() => null),
      riserBuf ? null : mixer.fetchBuffer(RISER_URL).catch(() => null),
      lib.load(first),
    ]);
    if (!firstRaw) throw new Error(`första repliken saknas (${first}.mp3)`);
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
    if (def.lab) {
      note += ONLY_STATION
        ? ` Bara banan ${TITLES[ONLY_STATION]} den här gången.`
        : ' Telefonen i fickan, skärmen olåst. Knacka på fickan när hon ber om det.';
    }
    if (chapterNo === '2') {
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

  // iOS asks before it hands out the accelerometer, and only inside the tap.
  // Android does not ask. Either way GPS carries on if the answer is no.
  const motionAsk = !SIM && typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function'
    ? DeviceMotionEvent.requestPermission().catch(() => 'denied') : Promise.resolve('granted');

  await mixer.resume();
  t0 = performance.now();
  walk = new Walk();
  waiter = new Waiter();
  world = defaultWorld();
  // A simulated walk does not go into her world: its squares are made up.
  memory = new Memory(SIM ? null : localStorage);

  const what = def.lab
    ? `labb ${def.lab}${ONLY_STATION ? `, bara ${TITLES[ONLY_STATION]}` : ''}`
    : `kapitel ${chapterNo}, variant ${variant.toUpperCase()}`;
  log(`start, ${what}${SIM ? ', simulerad' : ''}`);
  window.glimt = { mixer, walk, world, lib };   // for debugging from the console

  if (bedBuf) mixer.startBed(bedBuf);
  if (riserBuf) {
    const at = mixer.playFx(riserBuf);
    pendingVoiceAt = at + riserBuf.duration * RISER_VOICE_AT;
  }

  acquireWakeLock();
  if (SIM) startSim(); else startGps();
  if (!SIM) motionAsk.then(answer => {
    if (answer === 'granted') startMotion();
    else log('rörelsesensor: nekad, gps avgör gång och stilla');
  });
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
      // The lab shows the station instead, and Vega is always clear there:
      // contact is not what is being tried.
      if (!def.lab) $('scene').textContent = def.scenes[id.slice(0, 2)] || id;
      log(`▶ ${id}`);
      const why = await mixer.playVoice(buf, { clear: clear || !!def.lab, at });
      if (why === 'timeout') log(`ljud: ${id} nådde aldrig slutet, går vidare`);
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => mixer.fadeOut(s),
    async playQuiet(id) {
      const buf = await lib.buffer(id);
      if (buf) await mixer.playQuiet(buf);
    },
  };

  if (def.lab) {
    try { sfx = new Synth(mixer); } catch (err) { sfx = new SilentSynth(); log('ljudeffekter: ' + err.message); }
    labResults = [];
    Object.assign(ctx, labHelpers(walk, {
      now,
      vibrateImpl: p => !finished && typeof navigator.vibrate === 'function' && navigator.vibrate(p),
    }), {
      sfx,
      memo: {},
      station(id, k, n) { $('scene').textContent = id ? `${TITLES[id]} ${k}/${n}` : 'Slut'; },
      result(id, r) {
        labResults.push({ id, ...r });
        if (!finished) log(`${TITLES[id]}: ${r.outcome}. ${r.detail}`);
      },
    });
  }

  try {
    if (def.lab) {
      // A single station is a try-out, not a walk with her: no memory lines.
      const opening = ONLY_STATION ? [] : memory.opening(Date.now());
      const closing = () => ONLY_STATION ? [] : memory.closing(world, new Date());
      await runLab(ctx, def.lab, { only: ONLY_STATION, opening, closing });
    }
    else await def.run(ctx);
  } catch (err) {
    log('fel: ' + err.message);
  }
  finish();
}

// Runs once the first position is known. Chapter 1 asks the map and
// remembers the landmark; chapter 2 reuses it and walks towards it.
// The lab looks up a landmark near where it starts, for Hitta, and leaves
// the chapters' saved one alone.
function onFirstPosition(lat, lon) {
  const lab = !!CHAPTERS[chapterNo].lab;
  const opts = { lat, lon, log };
  if (chapterNo === '2') opts.landmark = savedLandmark();
  chooseWorld(world, opts).then(() => {
    if (chapterNo === '1') saveLandmark(world);
    if (world.landmarkCoord && !lab) {
      walk.setTarget({ latitude: world.landmarkCoord.lat, longitude: world.landmarkCoord.lon });
    }
  }).catch(err => log('omvärld: ' + err.message));
}

function tick() {
  const s = walk.tick(now());
  waiter.check(s);
  mixer.setContact(s.contact);
  render(s);
  logSteps(s);
  if (CHAPTERS[chapterNo].lab) logKnocks();
  if (s.t - lastGpsLog >= GPS_LOG_EVERY) {
    lastGpsLog = s.t;
    logGps(s);
  }
}

// Worth one line each: the feet took over or GPS took it back, the sensor
// never answered, or it answered but no rhythm came out of it.
let stepsNoted = { trusted: false, silent: false, deaf: false };
function logSteps(s) {
  const st = walk.steps;
  if (st.trusted !== stepsNoted.trusted) {
    stepsNoted.trusted = st.trusted;
    log(st.trusted
      ? `steg: rytm hittad, ${Math.round(st.trustedCadence)} per minut. Stegen avgör nu gång och stilla`
      : 'steg: tysta medan gps säger rörelse, gps avgör igen');
  }
  if (SIM) return;
  if (s.t >= 5 && st.samples === 0 && !stepsNoted.silent) {
    stepsNoted.silent = true;
    log('rörelsesensor: inga värden, gps avgör gång och stilla');
  }
  if (s.t >= 90 && st.samples > 0 && st.trustCount === 0 && !stepsNoted.deaf) {
    stepsNoted.deaf = true;
    log('steg: ingen rytm efter 1,5 minut, gps avgör gång och stilla');
  }
}

// Every double knock the detector hears, asked for or not, so a walk shows
// what the thresholds make of a real pocket. Capped in case it hears plenty.
function logKnocks() {
  const d = walk.knocks.lastDoubleAt();
  if (d <= lastDoubleSeen) return;
  lastDoubleSeen = d;
  doublesLogged++;
  if (doublesLogged <= 40) log('knack: dubbelknack hörd');
  else if (doublesLogged === 41) log('knack: fler än 40 dubbelknack, slutar skriva ut dem');
}

// One line per half minute: how often the phone reported, how well, and what
// the engine made of it. Enough to tell sparse fixes from a walker who stood.
function logGps(s) {
  fixTimes = fixTimes.filter(x => x >= s.t - GPS_LOG_EVERY);
  const n = fixTimes.length;
  const acc = s.accuracy === null ? '' : `, ±${Math.round(s.accuracy)} m`;
  const src = SPEED_SOURCE[walk.gps.source] ? ` (${SPEED_SOURCE[walk.gps.source]})` : '';
  const steps = s.paceSource === 'steps' ? `, ${Math.round(s.cadence)} steg/min` : '';
  log(`gps: ${n} ${n === 1 ? 'position' : 'positioner'} på ${GPS_LOG_EVERY} s${acc}, ${kmh(s.speed)}${src}${steps}, ${BAND_WORDS[s.band]}`);
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
  $('band').textContent = BAND_WORDS[s.band] +
    (s.paceSource === 'steps' ? ` · ${Math.round(s.cadence)} steg/min` : '');
  $('speed').textContent = kmh(s.speed);
  $('elapsed').textContent = fmt(s.t);
  let dist = s.distToStart === null ? 'start' :
    `${Math.round(s.distToStart)} m från start${s.approaching ? ', på väg tillbaka' : ''}`;
  if (s.distToTarget !== null) {
    dist += `, ${Math.round(s.distToTarget)} m till ${CHAPTERS[chapterNo].lab ? 'målet' : world.landmark}`;
  }
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
    if (c.accuracy <= MEMORY_MAX_ACCURACY) memory.visit(c.latitude, c.longitude);
    if (first) {
      first = false;
      log(`gps: första fix ±${Math.round(c.accuracy)} m`);
      onFirstPosition(c.latitude, c.longitude);
    }
  }, err => {
    log('gps-fel: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

// ---------- accelerometer ----------
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  walk.motion(now(), Math.hypot(a.x, a.y, a.z));
}

function startMotion() {
  if (typeof DeviceMotionEvent === 'undefined') { log('rörelsesensor: stöds inte, gps avgör gång och stilla'); return; }
  window.addEventListener('devicemotion', onMotion);
}

// ---------- simulator ----------
function startSim() {
  // The slider's speed as footsteps too, so ?sim exercises the step path.
  motionSimId = setInterval(() => {
    const t = now();
    walk.motion(t, simulatedMagnitude(t, parseFloat($('sim-speed').value)));
  }, 20);
  let lat = 59.38, lon = 13.5, heading = 0;
  const speedEl = $('sim-speed');
  const out = $('sim-out');
  speedEl.addEventListener('input', () => { out.textContent = kmh(parseFloat(speedEl.value)); });
  $('sim-turn').addEventListener('click', () => { heading += Math.PI; log('sim: vänder'); });
  $('sim-left').addEventListener('click', () => { heading -= Math.PI / 2; log('sim: vänster'); });
  $('sim-right').addEventListener('click', () => { heading += Math.PI / 2; log('sim: höger'); });
  // One sharp sample between the simulated steps. Click twice for a double.
  $('sim-knock').addEventListener('click', () => { walk.motion(now(), 9.81 + 9); });
  let first = true;
  simId = setInterval(() => {
    const v = parseFloat(speedEl.value);
    const accuracy = $('sim-fog').checked ? 80 : 8;
    lat += (v * Math.cos(heading)) / 111320;
    lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
    fixTimes.push(now());
    walk.fix(now(), { latitude: lat, longitude: lon, accuracy, speed: v });
    if (accuracy <= MEMORY_MAX_ACCURACY) memory.visit(lat, lon);
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
  clearInterval(motionSimId);
  window.removeEventListener('devicemotion', onMotion);
  if (waiter) waiter.abort();
  if (mixer) mixer.stopVoice();
  if (sfx) sfx.close();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('walking').hidden = true;
  $('done').hidden = false;
  if (memory) {
    if (now() >= MEMORY_MIN_WALK) {
      memory.endWalk(Date.now(), chapterNo);
      log(`minne: ${memory.fresh.size} nya rutor, ${memory.known.size} totalt`);
      showWorld('world-end', memory, memory.fresh, 'end');
    } else {
      // Too short to count: her world as it was, no new squares claimed.
      showWorld('world-end', new Memory(SIM ? null : localStorage), new Set(), 'short');
    }
  }
  if (CHAPTERS[chapterNo].lab) showLabResults();
  $('final-log').textContent = logLines.join('\n');
}

// ---------- her world ----------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const andList = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} och ${xs[xs.length - 1]}`;

function worldLine(m, when) {
  const sum = m.summary();
  const short = when === 'short' ? 'Promenaden var under en minut och räknas inte. ' : '';
  if (!sum.cells) return `${short}Hennes värld är tom än. Den växer där du går.`;
  const keys = sum.keys.map(k => KEY_NAMES[k]);
  const walked = keys.length ? ` Hon har gått med dig i ${andList(keys)}.` : '';
  if (when === 'end') {
    const fresh = m.fresh.size;
    return (fresh ? `${plural(fresh, 'ny ruta', 'nya rutor')} den här gången.` : 'Inga nya rutor den här gången.') +
      ` Hennes värld är ${plural(sum.cells, 'ruta', 'rutor')}.${walked}`;
  }
  if (short) return `${short}Hennes värld är ${plural(sum.cells, 'ruta', 'rutor')}.${walked}`;
  return `${plural(sum.cells, 'ruta', 'rutor')} från ${plural(sum.walks, 'promenad', 'promenader')}.${walked}`;
}

// The squares as points of light, the newest brightest, and one sentence.
function showWorld(id, m, recent, when) {
  const box = $(id);
  if (!box) return;
  box.hidden = false;
  const canvas = box.querySelector('canvas');
  canvas.hidden = m.known.size === 0;
  box.querySelector('.world-line').textContent = worldLine(m, when);
  if (!canvas.hidden) requestAnimationFrame(() => drawWorld(canvas, m, recent));
}

// ---------- lab: the walker's verdict ----------
const RATINGS_KEY = 'glimt-lab-ratings';
const OUTCOME_WORDS = { klarade: 'klarade', missade: 'missade', hoppade: 'hoppades över' };

function saveRating(entry) {
  try {
    const all = JSON.parse(localStorage.getItem(RATINGS_KEY) || '[]');
    all.push(entry);
    localStorage.setItem(RATINGS_KEY, JSON.stringify(all.slice(-500)));
  } catch (_) {}
}

function showLabResults() {
  const box = $('lab-results');
  const list = $('lab-list');
  list.textContent = '';
  if (!labResults.length) { box.hidden = true; return; }
  box.hidden = false;
  $('end-word').textContent = 'Vilka banor vill du göra igen?';
  for (const r of labResults) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'lab-head';
    const name = document.createElement('strong');
    name.textContent = TITLES[r.id];
    const outcome = document.createElement('span');
    outcome.className = `lab-outcome lab-${r.outcome}`;
    outcome.textContent = OUTCOME_WORDS[r.outcome] || r.outcome;
    head.append(name, outcome);
    const detail = document.createElement('p');
    detail.className = 'lab-detail';
    detail.textContent = r.detail;
    const rate = document.createElement('div');
    rate.className = 'lab-rate';
    let chosen = null;
    for (const [value, label] of [['igen', 'Igen!'], ['nej', 'Nej']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        if (chosen === value) return;
        const changed = chosen !== null;
        chosen = value;
        rate.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        log(`betyg: ${TITLES[r.id]} ${value}${changed ? ' (ändrat)' : ''}`);
        saveRating({ at: new Date().toISOString(), station: r.id, rating: value, outcome: r.outcome });
        $('final-log').textContent = logLines.join('\n');
      });
      rate.appendChild(b);
    }
    li.append(head, detail, rate);
    list.appendChild(li);
  }
}

let stopping = false;
$('stop-btn').addEventListener('click', async () => {
  if (stopping) return;
  stopping = true;
  $('stop-btn').disabled = true;
  log('avslutat av vandraren');
  // The lab's sounds go past the faded buses, straight to master: stop them
  // now, or a beat plays on at full level while Vega fades (seen in Chrome).
  if (sfx) sfx.close();
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
  chapterNo = CHAPTERS[n] ? String(n) : '1';
  // A hidden choice (?kapitel=labb2 before its radio exists) still runs,
  // it just has no radio to tick.
  const radio = document.querySelector(`input[name="chapter"][value="${chapterNo}"]`);
  if (radio) radio.checked = true;
  else document.querySelectorAll('input[name="chapter"]').forEach(el => { el.checked = false; });
  try { if (radio) localStorage.setItem('glimt-chapter', chapterNo); } catch (_) {}
  const def = CHAPTERS[chapterNo];
  $('subtitle').textContent = def.subtitle;
  $('variant-box').hidden = !!def.lab;
  document.title = def.lab ? `Glimt, labb ${def.lab}` : `Glimt, kapitel ${chapterNo}`;
  preload();
}

(function initStartScreen() {
  let variant = 'a';
  try { variant = localStorage.getItem('glimt-variant') || 'a'; } catch (_) {}
  if (params.get('variant') === 'a' || params.get('variant') === 'b') variant = params.get('variant');
  if (variant !== 'a' && variant !== 'b') variant = 'a';
  document.querySelector(`input[name="variant"][value="${variant}"]`).checked = true;

  let ch = '1';
  try { ch = localStorage.getItem('glimt-chapter') || '1'; } catch (_) {}
  if (params.has('kapitel')) ch = params.get('kapitel');
  // A single station belongs to whichever lab has it.
  if (ONLY_STATION) ch = LABS[2].includes(ONLY_STATION) ? 'labb2' : 'labb1';
  document.querySelectorAll('input[name="chapter"]').forEach(el => {
    el.addEventListener('change', () => selectChapter(el.value));
  });

  try {
    const last = localStorage.getItem('glimt-last-log');
    if (last) { $('last-log').textContent = last; $('last-log-box').hidden = false; }
  } catch (_) {}

  try {
    const m = new Memory(localStorage);
    showWorld('world-start', m, m.lastWalkCells(), 'start');
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
