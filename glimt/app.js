// Glimt: wires GPS, clock, audio and the chapter script together.
// ?sim in the URL replaces GPS with a speed slider for testing at a desk.
// ?kapitel=2 preselects a chapter, ?kapitel=episod1 the episode,
// ?kapitel=labb1 the lab; the start screen
// has the same choice. ?bana=<id> runs a single lab station (ids in lab.js),
// ?banor=<id>,<id> some of one lab's stations as a walk of the lab, and
// ?prov=<id> one of the short test walks (PROV in lab.js).

import { Walk, Waiter, simulatedMagnitude, buzzReading } from './engine.js';
import { runChapter1 } from './chapter1.js';
import { runChapter2 } from './chapter2.js';
import { runEpisode1 } from './episod1.js';
import { HerSide, SilentSide } from './herside.js';
import { runLab, labHelpers, LABS, TITLES, PROV, ratedThisRound, RESUMABLE, chosenStations, knockPattern, buzzWords, realTarget } from './lab.js';
import { Synth, SilentSynth } from './synth.js';
import { Mixer, Library } from './audio.js';
import { chooseWorld, defaultWorld, fetchLandmarks, nearestByName } from './world.js';
import { Memory, drawWorld, KEY_NAMES } from './memory.js';

// The version the start screen shows, the same number as the service
// worker's cache. Bump both together.
const APP_VERSION = 27;

const params = new URLSearchParams(location.search);
const SIM = params.has('sim');
// A test walk wins over everything else the link says.
const PROV_ID = Object.hasOwn(PROV, params.get('prov') || '') ? params.get('prov') : null;
const TEST = PROV_ID ? PROV[PROV_ID] : null;
// A ?prov= the app could not read says so, and offers the lab instead.
const BAD_PROV = !PROV_ID && params.has('prov') ? params.get('prov') : null;
const ONLY_STATION = !TEST && TITLES[params.get('bana')] ? params.get('bana') : null;
const CHOSEN = ONLY_STATION || TEST ? null : chosenStations(params.get('banor'));
// A ?banor= the app could not read says so, instead of walking everything.
const BAD_CHOICE = !TEST && !ONLY_STATION && !CHOSEN && params.has('banor') ? params.get('banor') : null;
// The stations the link chose, when the chapter on screen is their lab.
const chosenFor = def => def.lab && CHOSEN && CHOSEN.lab === def.lab ? CHOSEN.stations : null;
// The stations a walk of the chapter on screen can have: the test walk's,
// the one ?bana= names, the ones a link chose, or the whole lab. None in a
// chapter.
const labStations = def => !def.lab ? [] : def.prov ? def.prov.stations : ONLY_STATION ? [ONLY_STATION] : chosenFor(def) || LABS[def.lab];

// Which browser ran the walk, for the log. Labb 2 on 2026-10-01 ran in
// Firefox, and only Firefox's own wording of the GPS error said so. Firefox
// on Android has vibration turned off: navigator.vibrate may say yes and
// nothing moves (MDN), so Hon knackar would wait for knocks to a buzz the
// walker never felt. Any Firefox, not only one that says Android: its
// "desktop site" mode sends a Linux desktop agent, and no Firefox vibrates.
const UA = navigator.userAgent;
const BROWSER = (() => {
  const known = [['Firefox', /(?:Firefox|FxiOS)\/(\d+)/], ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Edge', /Edg(?:A|iOS)?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari/]];
  const hit = known.find(([, re]) => re.test(UA));
  const name = hit ? `${hit[0]} ${UA.match(hit[1])[1]}` : 'okänd webbläsare';
  return `${name}, ${/Android/.test(UA) ? 'Android' : /iPhone|iPad/.test(UA) ? 'iOS' : 'dator'}`;
})();
const FIREFOX = /(?:Firefox|FxiOS)\//.test(UA);
const CAN_VIBRATE = typeof navigator.vibrate === 'function' && !FIREFOX;
// Links to Glimt open in Firefox on the field phone, and Firefox there hands
// out few fixes: one every 6.2 s at ±17-24 m (labb 2 on 2026-10-01 and
// 10-05), where Chrome gave two a second at ±3-6 m with the same
// watchPosition options (the knock walk on 09-28, labb 2 on 10-06). The
// browser was not logged before v15, and the 09-28 walk was first taken for
// Firefox too; its recording says Chrome three ways: a motion sample every
// 16-17 ms like Chrome's on 10-06 (Firefox: 9-20 ms, uneven), the fix rate,
// and her world's squares, which are kept per browser and add up only that
// way. So the start screen says it and offers a way out: an intent link that
// hands the same address to Chrome.
const ANDROID_FIREFOX = FIREFOX && /Android/.test(UA);
const chromeIntent = () =>
  `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;

const LAB_FILES = { url: '../stories/glimt/labb.json', voices: '../audio/glimt/vega/glimt-labb' };

const CHAPTERS = {
  // `side`: the episode has her side of the line (herside.js), and the folder
  // its sounds are in. Standing still dulls her voice at once there.
  episod1: {
    url: '../stories/glimt/episod-1.json',
    voices: '../audio/glimt/vega/glimt-e1',
    side: '../audio/glimt/side',
    first: 's0',
    run: runEpisode1,
    subtitle: 'Episod 1. Ungefär tolv minuter. Gå eller spring. Hon hörs när du går.',
    scenes: {
      s0: 'Start', s1: 'Slingan', s2: 'Frågan', s3: 'Trädet',
      s4: 'Himlen', s5: 'Någon kommer', s6: 'Klockan',
    },
  },
  // Only reached by a ?prov= link; there is no radio for it.
  ...(TEST ? {
    prov: {
      ...LAB_FILES, lab: 'prov', prov: TEST, first: 'prov-intro',
      subtitle: `Testpromenad: ${TEST.title}. Ungefär ${TEST.minutes} minuter.`,
    },
  } : {}),
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
// What episode 2 will want to know about episode 1. A simulated walk keeps
// its own, so a try at the desk does not rewrite the evening that was walked.
const EPISODE_KEY = SIM ? 'glimt-episod-1-sim' : 'glimt-episod-1';
// The contact her voice gets while the walker stands still in an episode:
// dull and far, at once, where the chapters let it sink over half a minute.
const VEIL = 0.2;
const BED_UNDER_SIDE = 0.35;  // the bed's share of itself while her side is forward

const BAND_WORDS = { still: 'stilla', walk: 'gång', run: 'löpning' };
// 'doppler' is whatever the phone reports as speed. On a six-second fix it is
// not necessarily satellite Doppler, so the log does not claim it is.
const SPEED_SOURCE = { doppler: 'telefonens fart', distance: 'räknat ur avstånd' };

const $ = id => document.getElementById(id);

// ---------- state ----------
let chapterNo = 'episod1';    // a key of CHAPTERS
let mixer, lib, chapter;
let sfx = null;
let side = null;                // her side of the line, in an episode
let sideSounds = null;          // its decoded sounds, loaded with the chapter
let veiled = false, ducked = false;
let cutSeq = 0;                 // bumped by ctx.cut(), so a line not yet started is dropped
let preloadTurn = 0;            // bumped by each preload, so an earlier one gives way
let labResults = [];
let labMemo = null;
let currentStation = null;      // the lab station running, so a stop mid-station can still be rated
let resumeStations = null;      // the lab's unrated stations, when some are rated (start screen)
let walkId = null;              // this walk's start, on its ratings, so a changed rating is the same one
let pickedWalk = false;         // the walk ran the stations a ?banor= link chose
let lastDoubleSeen = -Infinity, doublesLogged = 0;
// One voice at a time. The lab's sensor watcher can ask for a line while a
// station's line is playing; it waits its turn instead of talking over it.
let voiceChain = Promise.resolve();
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

// The raw walk, for tuning the detectors against a real pocket: every
// accelerometer sample, every fix (as metres from the first, so no place
// leaves the phone) and every log line, each at its exact time. Knacket's
// first two field walks showed heel strikes as sharp as knocks, and a log of
// half-minute summaries cannot say what would tell them apart (2026-09-28).
// Kept in memory only; the walker saves it from the end screen.
const REC_MAX = 200000;       // samples, about 55 minutes at 60 Hz
const rec = { t: [], m: [], fixes: [], log: [], origin: null };
const ms = s => Math.round(s * 1000);

const now = () => (performance.now() - t0) / 1000;
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const kmh = v => (v * 3.6).toFixed(1).replace('.', ',') + ' km/h';
const dec = x => x.toFixed(1).replace('.', ',');
const walking = () => tickId !== null && !finished;

function log(msg) {
  const line = `${fmt(Math.max(0, now()))}  ${msg}`;
  logLines.push(line);
  rec.log.push([ms(now()), msg]);
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
  // Another chapter chosen while this one loads: its preload takes over, and
  // this one must not hand its chapter or her sounds to the other.
  const turn = ++preloadTurn;
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Laddar…';
  try {
    if (!mixer) mixer = new Mixer();
    const loaded = await (await fetch(def.url)).json();
    if (turn !== preloadTurn) return;
    chapter = loaded;
    lib = new Library(mixer, def.voices);

    const first = def.lab && !def.prov && ONLY_STATION ? 'labb-intro-en' : def.first;
    const [bedRaw, riserRaw, firstRaw, sounds] = await Promise.all([
      bedBuf ? null : mixer.fetchBuffer(BED_URL).catch(() => null),
      riserBuf ? null : mixer.fetchBuffer(RISER_URL).catch(() => null),
      lib.load(first),
      def.side ? loadSide(def.side, chapter.sfx || {}) : null,
    ]);
    if (turn !== preloadTurn) return;
    sideSounds = sounds;
    if (!firstRaw) throw new Error(`första repliken saknas (${first}.mp3)`);
    if (bedRaw) bedBuf = await mixer.decode(bedRaw);
    if (riserRaw) riserBuf = await mixer.decode(riserRaw);
    if (turn !== preloadTurn) return;

    // The rest streams in behind the start button.
    lib.loadAll(Object.keys(chapter.lines));

    const notes = [];
    if (!bedBuf) notes.push('ingen bädd');
    if (!riserBuf) notes.push('ingen riser');
    if (def.side && Object.keys(sounds).length < Object.keys(chapter.sfx || {}).length) notes.push('några av hennes steg');
    let note = notes.length
      ? `Ljudet saknar ${notes.join(' och ')} på den här adressen. Rösten fungerar ändå.`
      : 'Sätt på lurarna. Tryck när du står där du vill börja.';
    if (def.prov) {
      note += ' Telefonen i fickan, skärmen olåst.';
    } else if (def.lab) {
      const chosen = chosenFor(def);
      note += ONLY_STATION
        ? ` Bara banan ${TITLES[ONLY_STATION]} den här gången.`
        : `${chosen ? ` Bara ${andList(chosen.map(id => TITLES[id]))} den här gången.` : ''}` +
          ' Telefonen i fickan, skärmen olåst. Knacka på fickan när hon ber om det.';
      if (BAD_CHOICE !== null) note += ` Länkens banor (${BAD_CHOICE}) gick inte att läsa, så det blir labbet som vanligt.`;
      if (BAD_PROV !== null) note += ` Länkens test (${BAD_PROV}) finns inte, så det blir labbet som vanligt.`;
      if (!CAN_VIBRATE && labStations(def).includes('vibration')) {
        note += FIREFOX
          ? ` Firefox vibrerar inte, så Hon knackar hoppas över.${ANDROID_FIREFOX ? '' : ' Öppna Glimt i Chrome.'}`
          : ' Den här webbläsaren vibrerar inte, så Hon knackar hoppas över.';
      }
    }
    if (ANDROID_FIREFOX) note += ' I Firefox kommer gps:en glest, så svängar och riktning hörs sent. Öppna Glimt i Chrome.';
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
    if (turn !== preloadTurn) return;
    $('load-note').textContent = 'Kunde inte ladda kapitlet: ' + err.message;
  }
}

// The sounds of her side: each a clip, some cut into single steps. One that
// does not load is left out; the episode runs without it.
async function loadSide(base, sfx) {
  const out = {};
  await Promise.all(Object.entries(sfx).map(async ([name, spec]) => {
    try {
      const raw = await mixer.fetchBuffer(`${base}/${spec.file}`);
      if (raw) out[name] = { buffer: await mixer.decode(raw), slices: spec.slices || null };
    } catch (_) {}
  }));
  return out;
}

// ---------- start ----------
async function start() {
  const def = CHAPTERS[chapterNo];
  const variant = document.querySelector('input[name="variant"]:checked').value;
  try { localStorage.setItem('glimt-variant', variant); } catch (_) {}
  stopVibra();

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
  walkId = new Date().toISOString();
  walk = new Walk();
  waiter = new Waiter();
  world = defaultWorld();
  // A simulated walk does not go into her world: its squares are made up.
  memory = new Memory(SIM ? null : localStorage);

  // A lab with stations already rated goes on from the first unrated one,
  // unless the walker chose all of them. A link that names stations wins.
  const chosen = ONLY_STATION ? null : chosenFor(def);
  pickedWalk = !!chosen;
  const resume = def.lab && !ONLY_STATION && !chosen && resumeStations &&
    document.querySelector('input[name="resume"]:checked')?.value === 'rest' ? resumeStations : null;
  if (def.prov) pickedWalk = true;
  const what = def.prov ? `prov ${PROV_ID} (${def.prov.title}), version ${APP_VERSION}` : def.lab
    ? `labb ${def.lab}${ONLY_STATION ? `, bara ${TITLES[ONLY_STATION]}` : ''}` +
      `${chosen ? `, bara ${andList(chosen.map(id => TITLES[id]))}` : ''}${resume ? `, från ${TITLES[resume[0]]}` : ''}`
    : def.side ? `${chapter.title} (${chapterNo}), version ${APP_VERSION}`
    : `kapitel ${chapterNo}, variant ${variant.toUpperCase()}`;
  log(`start, ${what}${SIM ? ', simulerad' : ''}`);
  log(`webbläsare: ${BROWSER}`);
  clearTimeout(gpsCheckTimer);
  gpsTrouble = null;
  if (!SIM) log(`gps före start: ${gpsStatus()}`);
  // What the test walk's start screen found, so its log says it without the
  // walker having to.
  if (def.prov && def.prov.sensor && !SIM) log(`sensor före start: ${sensorCheck.status}`);
  if (def.prov && def.prov.map && !SIM) log(`karta före start: ${mapCheck.status}`);
  // Only when this walk has Hon knackar, and the phone could have been tried.
  if (!SIM && CAN_VIBRATE && walkStations(def).includes('vibration')) log(`vibration före start: ${vibraStatus()}`);
  if (BAD_CHOICE !== null) log(`länkens banor gick inte att läsa: ${BAD_CHOICE}`);
  if (BAD_PROV !== null) log(`länkens test finns inte: ${BAD_PROV}`);
  // Her side starts with the walk: the hum is there from the first second.
  side = null;
  veiled = ducked = false;
  if (def.side) {
    try {
      side = new HerSide(mixer);
      for (const [name, snd] of Object.entries(sideSounds || {})) side.setSound(name, snd.buffer, snd.slices);
    } catch (err) {
      side = new SilentSide();
      log('hennes sida: ' + err.message);
    }
  }
  window.glimt = { mixer, walk, world, lib, side };   // for debugging from the console

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

  // `contact`: the line goes through the contact like a chapter's, inside
  // the lab too (Kontakten).
  // `seq`: the cut count when the line was asked for. A cut that came while
  // the line was still being decoded drops it, as it would have stopped it.
  async function speak(id, { clear = false, contact = false } = {}, seq = cutSeq) {
    if (finished) return;
    const buf = await lib.buffer(id);
    if (!buf) { log(`replik saknas: ${id}`); return; }
    if (seq !== cutSeq) return;
    if (mixer.ctx.state === 'suspended') {
      // Bounded: every line queues behind this one, so a resume that never
      // settles (a hidden page may not be allowed to start audio) would
      // silence the rest of the walk, her sensor warning included. After two
      // seconds the line goes ahead; playVoice's watchdog carries it from there.
      try { await Promise.race([mixer.resume(), new Promise(r => setTimeout(r, 2000))]); } catch (_) {}
      log(`ljud: kontexten var pausad (${mixer.ctx.state})`);
      if (seq !== cutSeq) return;     // cut while it waited for the audio
    }
    const at = pendingVoiceAt; pendingVoiceAt = null;
    // The lab shows the station instead, and Vega is clear there unless a
    // station asks for the contact: elsewhere it is not what is tried.
    // An episode has lines that belong to no scene (the reserve); they
    // leave the scene's name standing.
    if (!def.lab && (def.scenes[id.slice(0, 2)] || !def.side)) $('scene').textContent = def.scenes[id.slice(0, 2)] || id;
    log(`▶ ${id}`);
    const why = await mixer.playVoice(buf, { clear: contact ? false : clear || !!def.lab, at });
    if (why === 'timeout') log(`ljud: ${id} nådde aldrig slutet, går vidare`);
  }

  const ctx = {
    variant,
    world,
    state: () => walk.state(),
    // After stop the aborted waits let the script run on to its end; its
    // scene marks must not land in the log after "avslutat".
    log: msg => { if (!finished) log(msg); },
    hold: on => { walk.contact.hold = on; },
    play(id, opts = {}) {
      const seq = cutSeq;
      const turn = voiceChain.then(() => speak(id, opts, seq));
      voiceChain = turn.catch(() => {});
      return turn;
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => mixer.fadeOut(s),
    async playQuiet(id) {
      const buf = await lib.buffer(id);
      if (buf) await mixer.playQuiet(buf);
    },
  };

  if (def.side) {
    // A line on her side: the flat voice in her ear, the woman beside her,
    // the other voice. Without her side it comes down the line instead, so
    // the walker still hears what was said.
    const speakSide = async (id, kind) => {
      if (finished) return;
      if (side.silent) return speak(id);
      const buf = await lib.buffer(id);
      if (!buf) { log(`replik saknas: ${id}`); return; }
      if (finished) return;
      log(`▶ ${id} (hennes sida)`);
      const why = await side.say(buf, kind);
      if (why === 'timeout') log(`ljud: ${id} nådde aldrig slutet, går vidare`);
    };
    const her = side;
    Object.assign(ctx, {
      side: {
        walk: (surface, o) => her.walk(surface, o),
        other: (where, seconds) => her.other(where, seconds),
        hand: () => her.hand(),
        tone: on => her.tone(on),
        bell: () => her.bell(),
        lift: on => her.lift(on),
        pin: on => her.pin(on),
        fade: s => her.fade(s),
        say(id, kind) {
          const turn = voiceChain.then(() => speakSide(id, kind));
          voiceChain = turn.catch(() => {});
          return turn;
        },
      },
      cut() { cutSeq++; mixer.stopVoice(); },
      seconds: id => (chapter.seconds || {})[id] || 0,
      cue: (id, word) => ((chapter.cues || {})[id] || {})[word] || 0,
      remember(facts) {
        if (finished) return;
        // A walk broken off does not overwrite one that was walked to its end.
        try {
          const old = JSON.parse(localStorage.getItem(EPISODE_KEY) || 'null');
          if (old && old.klar && !facts.klar) return;
          localStorage.setItem(EPISODE_KEY, JSON.stringify({
            ...facts, landmark: world.landmark, at: Date.now(), version: APP_VERSION,
          }));
        } catch (_) {}
        if (facts.klar) {
          log(`minne till episod 2: ${facts.svarade ? 'stannade när hon bad om det' : 'stannade aldrig på begäran'}, ` +
            `${facts.misstanke ? 'lampan tändes när lojalisten kom' : 'ingen misstanke'}`);
        }
      },
    });
  }

  if (def.lab) {
    try { sfx = new Synth(mixer); } catch (err) { sfx = new SilentSynth(); log('ljudeffekter: ' + err.message); }
    labResults = [];
    labMemo = {};
    Object.assign(ctx, labHelpers(walk, {
      now,
      vibrateImpl: p => !finished && CAN_VIBRATE && navigator.vibrate(p),
    }), {
      sfx,
      memo: labMemo,
      noBuzz: !CAN_VIBRATE ? 'telefonen kan inte vibrera härifrån' : VIBRA_NO_BUZZ[vibra.answer] || null,
      station(id, k, n) {
        currentStation = id;
        $('scene').textContent = id ? `${TITLES[id]} ${k}/${n}` : 'Slut';
      },
      result(id, r) {
        currentStation = null;
        labResults.push({ id, ...r });
        if (!finished) log(`${TITLES[id]}: ${r.outcome}. ${r.detail}`);
      },
    });
  }

  try {
    if (def.lab) {
      // A single station is a try-out, not a walk with her: no memory lines.
      // Nor a test walk (runLab leaves them out).
      if (def.prov) await runLab(ctx, null, { prov: PROV_ID });
      else {
        const opening = ONLY_STATION ? [] : memory.opening(Date.now());
        const closing = () => ONLY_STATION ? [] : memory.closing(world, new Date());
        await runLab(ctx, def.lab, { only: ONLY_STATION, stations: chosen || resume, opening, closing });
      }
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
    // An episode asks for no direction: the landmark is only spoken of.
    if (world.landmarkCoord && !lab && !CHAPTERS[chapterNo].side) {
      walk.setTarget({ latitude: world.landmarkCoord.lat, longitude: world.landmarkCoord.lon });
    }
  }).catch(err => log('omvärld: ' + err.message));
}

function tick() {
  const s = walk.tick(now());
  waiter.check(s);
  if (side) {
    // The veil. Standing still, or a line on her side that must be heard
    // out: her voice goes dull and far at once, her side comes forward, and
    // the bed steps back to leave room for it.
    veiled = !s.moving || side.pinned;
    mixer.setContact(veiled ? Math.min(s.contact, VEIL) : s.contact);
    side.setPresence(s.moving ? 0 : 1);
    // Not in the bed's own fade-in, which a new level would cut short.
    const duck = veiled && s.t > 3;
    if (duck !== ducked) { ducked = duck; mixer.setBed(duck ? BED_UNDER_SIDE : 1); }
  } else {
    mixer.setContact(s.contact);
  }
  render(s);
  logSteps(s);
  if (CHAPTERS[chapterNo].lab) logKnocks(s);
  if (s.t - lastGpsLog >= GPS_LOG_EVERY) {
    lastGpsLog = s.t;
    logGps(s);
    if (CHAPTERS[chapterNo].lab) logSpikes(s);
  }
}

// Worth one line each: the feet took over or GPS took it back, the sensor
// never answered, or it answered but no rhythm came out of it, or it went
// quiet and came back.
let stepsNoted = { trusted: false, silent: false, deaf: false };
let sensorQuietFrom = null;
function logSteps(s) {
  const st = walk.steps;
  if (st.trusted !== stepsNoted.trusted) {
    stepsNoted.trusted = st.trusted;
    log(st.trusted
      ? `steg: rytm hittad, ${Math.round(st.trustedCadence)} per minut. Stegen avgör nu gång och stilla`
      : st.distrustReason === 'silent'
        ? 'steg: sensorn tyst, gps avgör tills stegen hittar en rytm igen'
        : 'steg: tysta medan gps säger rörelse, gps avgör igen');
  }
  // The phone stops the sensor with the screen, silently. The first field
  // lab lost it for six minutes and the log never said (2026-09-28). Before
  // the SIM return, so a silence faked in ?sim shows too.
  if (st.samples > 0) {
    if (!s.sensorLive && sensorQuietFrom === null) {
      sensorQuietFrom = st.lastT;
      log(`rörelsesensor: tyst sedan ${fmt(st.lastT)}, sidan ${document.visibilityState === 'visible' ? 'synlig' : 'dold'}`);
    } else if (s.sensorLive && sensorQuietFrom !== null) {
      log(`rörelsesensor: tillbaka efter ${Math.round(s.t - sensorQuietFrom)} s`);
      sensorQuietFrom = null;
    }
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
// what the thresholds make of a real pocket: how hard each knock was, and
// what the feet were doing. The first field lab heard nine doubles nobody
// asked for while walking, and the log could not say how far above the
// threshold they were (2026-09-28). Capped in case it hears plenty.
function logKnocks(s) {
  const d = walk.knocks.lastDoubleAt();
  if (d <= lastDoubleSeen) return;
  lastDoubleSeen = d;
  doublesLogged++;
  if (doublesLogged > 41) return;
  if (doublesLogged === 41) { log('knack: fler än 40 dubbelknack, slutar skriva ut dem'); return; }
  // A group is at most three knocks under a second apart, ending at d.
  const group = walk.knocks.spikes.filter(x => x.knock && x.t > d - 2 && x.t <= d);
  const peaks = group.map(x => dec(x.peak));
  const feet = s.paceSource === 'steps' ? `${BAND_WORDS[s.band]}, ${Math.round(s.cadence)} steg/min` : BAND_WORDS[s.band];
  const bar = group.length && group[0].walking ? `, gränsen ${dec(group[0].bar)}` : '';
  log(`knack: dubbelknack hörd (styrka ${peaks.join(' / ')}${bar}; ${feet})`);
}

// Half a minute of the knock detector's view in the lab: how many sharp
// spikes the pocket gave and how hard, so the knock threshold can be set
// from a walk instead of a guess. Only while the sensor answered.
function logSpikes(s) {
  if (walk.sensorShare(s.t - GPS_LOG_EVERY, s.t) < 0.5) return;
  const peaks = walk.knocks.spikes.filter(x => x.t > s.t - GPS_LOG_EVERY).map(x => x.peak).sort((a, b) => a - b);
  if (!peaks.length) { log(`utslag: inga på ${GPS_LOG_EVERY} s, ${BAND_WORDS[s.band]}`); return; }
  const q = p => peaks[Math.min(peaks.length - 1, Math.floor(p * peaks.length))];
  const over = walk.knocks.spikes.filter(x => x.t > s.t - GPS_LOG_EVERY && x.knock).length;
  // Walking, the bar follows the gait (2026-10-09): say where it stood.
  let bar = '';
  if (walk.knocks.walking(s.t)) {
    const b = walk.knocks.walkingBars(s.t);
    bar = b.level === null ? ` (gående ${dec(b.jump)}, gången inte läst än)` : ` (gående ${dec(b.jump)}, gången ${dec(b.level)})`;
  }
  log(`utslag: ${peaks.length} på ${GPS_LOG_EVERY} s, median ${dec(q(0.5))}, 9 av 10 under ${dec(q(0.9))}, högst ${dec(peaks[peaks.length - 1])}, ${over} över knackgränsen${bar}, ${BAND_WORDS[s.band]}`);
}

// One line per half minute: how often the phone reported, how well, and what
// the engine made of it. Enough to tell sparse fixes from a walker who stood.
function logGps(s) {
  fixTimes = fixTimes.filter(x => x >= s.t - GPS_LOG_EVERY);
  const n = fixTimes.length;
  const acc = s.accuracy === null ? '' : `, ±${Math.round(s.accuracy)} m`;
  const src = SPEED_SOURCE[walk.gps.source] ? ` (${SPEED_SOURCE[walk.gps.source]})` : '';
  // Why GPS decides, when it does and the phone has a sensor at all.
  const steps = s.paceSource === 'steps' ? `, ${Math.round(s.cadence)} steg/min`
    : !s.sensorSeen ? '' : !s.sensorLive ? ', sensorn tyst' : ', ingen stegrytm';
  log(`gps: ${n} ${n === 1 ? 'position' : 'positioner'} på ${GPS_LOG_EVERY} s${acc}, ${kmh(s.speed)}${src}${steps}, ${BAND_WORDS[s.band]}`);
}

function render(s) {
  const fill = $('contact-fill');
  fill.style.width = `${Math.round(s.contact * 100)}%`;
  fill.style.opacity = String(0.35 + 0.65 * s.contact);
  fill.style.boxShadow = `0 0 ${Math.round(2 + 10 * s.contact)}px rgba(200,210,255,${(0.15 + 0.4 * s.contact).toFixed(2)})`;
  // An episode holds the contact all the way; what changes is the veil.
  $('contact-word').textContent =
    side ? (veiled ? 'dov' : s.contact > 0.8 ? 'nära' : s.contact > 0.5 ? 'hör dig' : 'svagt') :
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
  $('gps').textContent = !s.gpsSeen ? GPS_TROUBLE_WORD[gpsTrouble] || 'väntar på gps' :
    s.accuracy === null ? 'gps' : `gps ±${Math.round(s.accuracy)} m`;
}

// ---------- GPS ----------
// Asked on the start screen, while the phone is still in hand. On the evening
// of 2026-10-01 the phone's location was switched off: the only sign was a
// line in the log, and the walker heard it at Vägvalet, minutes in. Pulling
// down the quick settings does not hide the page, so a failed check asks
// again by itself: soon when the phone said no at once (location off costs
// nothing to ask), later after a timeout (the GPS chip was on all along), and
// at most GPS_TRIES times before it waits for a tap on the note. A refusal is
// never asked again by itself: a prompt shown over and over can end with the
// browser blocking the site, and the walk's own GPS with it.
const GPS_RECHECK = { 2: 5, 3: 30 };  // s until the next try, per error code
const GPS_TRIES = 12;
const GPS_ADVICE = {
  1: 'Glimt får inte veta var du är. Tillåt plats för sidan i webbläsaren (låset vid adressen) innan du börjar.',
  2: 'Telefonen hittar ingen plats. Kolla att Plats är på i snabbinställningarna innan du börjar.',
  3: 'Gps:en har inte hittat dig än. Inomhus är det vanligt.',
};
const GPS_TROUBLE_WORD = { 1: 'gps nekad', 2: 'ingen gps' };
let gpsLast = null, gpsPending = false;  // the start screen's answer, for the log
let gpsCheckId = 0, gpsCheckTimer = null, gpsTries = 0;
let gpsTrouble = null;          // the walk's refusal (1) or no-position (2) before a first fix

const gpsStatus = () => !gpsPending ? gpsLast || 'inte kollad'
  : gpsLast ? `${gpsLast}, ny koll pågår` : 'väntar på svar';

// fresh: asked for by the walker, the page or the permission, not the timer.
function checkGps(fresh = true) {
  clearTimeout(gpsCheckTimer);
  if (SIM || !navigator.geolocation || $('start-screen').hidden ||
      document.visibilityState !== 'visible') return;
  if (fresh) gpsTries = 0;
  gpsTries++;
  gpsPending = true;
  // A newer check wins; an older answer that turns up late is dropped.
  const id = ++gpsCheckId;
  const note = $('gps-note');
  const answer = (text, status, wait) => {
    if (id !== gpsCheckId || $('start-screen').hidden) return;
    gpsPending = false;
    gpsLast = status;
    const again = wait && gpsTries < GPS_TRIES;
    note.textContent = text + (wait === null || again ? '' : ' Tryck här för att kolla igen.');
    if (again) gpsCheckTimer = setTimeout(() => checkGps(false), wait * 1000);
  };
  if (fresh) { note.textContent = 'Letar efter gps…'; note.hidden = false; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      answer(`Gps:en hittar dig, ±${Math.round(pos.coords.accuracy)} m.`,
        `position ±${Math.round(pos.coords.accuracy)} m`, null);
      if (id === gpsCheckId) checkMap(pos.coords);
    },
    err => answer(GPS_ADVICE[err.code] || `Gps:en svarar inte: ${err.message}`,
      `fel ${err.code}, ${err.message}`, GPS_RECHECK[err.code] || 0),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

// ---------- the test walk's own checks ----------
// A test walk is a couple of minutes, and one that needs the motion sensor
// or the map is wasted if either is not there. So the start screen looks
// first, says what it found in words, and the walk's log repeats it.
//
// The sensor: a second and a half of listening. Android hands it out
// without asking; it answers about sixty times a second while the screen
// is lit, and not at all in a page out of sight.
const sensorCheck = { status: 'inte kollad' };
function checkSensor() {
  if (!TEST || !TEST.sensor || SIM) return;
  const note = $('sensor-note');
  note.hidden = false;
  if (typeof DeviceMotionEvent === 'undefined') {
    sensorCheck.status = 'stöds inte';
    note.textContent = 'Telefonen har ingen rörelsesensor som sidan når. Testet behöver den.';
    return;
  }
  note.textContent = 'Lyssnar efter rörelsesensorn…';
  let n = 0;
  const on = e => { const a = e.accelerationIncludingGravity; if (a && a.x != null) n++; };
  window.addEventListener('devicemotion', on);
  setTimeout(() => {
    window.removeEventListener('devicemotion', on);
    sensorCheck.status = n >= 20 ? `svarar, ${n} värden på 1,5 s` : n ? `svarar glest, ${n} värden på 1,5 s` : 'svarar inte';
    note.textContent = n >= 20 ? 'Rörelsesensorn svarar.'
      : 'Rörelsesensorn svarar inte. Testet behöver den: ha skärmen tänd och sidan öppen i Chrome. Tryck här för att kolla igen.';
  }, 1500);
}

// The map: asked once the start screen's GPS check has a position, for the
// walks that go to a place. Ljudkompassen's needs a place 60-350 m away
// (realTarget in lab.js); Hitta makes one up when the map has none.
const mapCheck = { status: 'inte kollad', busy: false, at: -Infinity };
const MAP_WORDS = { vatten: 'vatten', skog: 'skog', berg: 'en höjd', bro: 'en bro', kyrkogard: 'en kyrkogård' };
function checkMap(coords) {
  if (!TEST || !TEST.map || SIM || mapCheck.busy || performance.now() - mapCheck.at < 60000) return;
  mapCheck.busy = true;
  const note = $('map-note');
  note.hidden = false;
  note.textContent = 'Frågar kartan vad som finns här…';
  const here = { latitude: coords.latitude, longitude: coords.longitude };
  fetchLandmarks(coords.latitude, coords.longitude).then(found => {
    const nearby = nearestByName(found, { lat: coords.latitude, lon: coords.longitude });
    const { target, seen } = realTarget(nearby, here);
    // An answer holds for a minute; a failure may be asked again at once.
    mapCheck.at = performance.now();
    mapCheck.status = seen.length ? `${seen.join(', ')}${target ? `, mål ${MAP_WORDS[target.kind]} ${Math.round(target.dist)} m` : ', inget mål 60-350 m bort'}` : 'inget inom 400 m';
    if (PROV_ID === 'kompass') {
      note.textContent = target
        ? `Kartan hittar ${seen.join(', ')}. Tonen leder till ${MAP_WORDS[target.kind]}, ${Math.round(target.dist)} m bort.`
        : seen.length
          ? `Kartan hittar ${seen.join(', ')}, men inget mellan 60 och 350 m härifrån. Gå en bit närmare, eller välj ett annat test.`
          : 'Kartan hittar inget här att gå till. Välj ett annat ställe, eller ett annat test.';
    } else {
      note.textContent = seen.length ? `Kartan hittar ${seen.join(', ')}.` : 'Kartan hittar inget här, så hon väljer en plats en bit bort.';
    }
  }).catch(err => {
    mapCheck.status = `svarar inte (${err.message})`;
    note.textContent = 'Kartan svarar inte just nu. Tryck här för att fråga igen.';
  }).finally(() => { mapCheck.busy = false; });
}

// ---------- vibration ----------
// Tried on the start screen, like the GPS, while the phone is still in the
// hand. Chrome on Android says yes to navigator.vibrate and then leaves the
// motor alone when the phone is on silent or Do not disturb (it asks the
// ringer mode itself: Chromium's VibrationManagerAndroid.java, and Android
// reports silent under Do not disturb), and Android drops the buzz in battery
// saver or with vibration switched off (VibrationSettings.java). The page is
// told none of it. On 2026-10-06 Hon knackar buzzed twice into a phone that
// never moved, and waited for knocks to something the walker never felt.
// Only the walker can say whether it buzzed, so the start screen asks, and a
// no skips the station instead of walking into it.
//
// The answer is not kept between visits: the phone's sound mode changes more
// often than Glimt is opened. The sensor listens while the try-out buzzes,
// for the log and the saved recording: nothing is known yet about what a
// buzz looks like in it.
const VIBRA_SETTLE = 0.4;       // s after the tap, which shakes the phone too
// The question asks for all three: a walker who felt one or two answers no,
// and is not told the phone lay still. The no's checks are one a line (the
// box breaks lines as written), in words that do not lean on what a phone
// maker calls its sound modes. The last sentence is her own when she skips
// the station ("vibra-kan-inte").
const VIBRA_NOTES = {
  idle: 'Banan Hon knackar surrar i telefonen. Prova först om du känner det.',
  buzzing: 'Surrar tre gånger…',
  asked: 'Kände du alla tre surren?',
  ja: 'Bra. Då vet du hur det känns när hon knackar.',
  nej: 'Då surrade inte telefonen som den ska. Kolla:\n' +
    'Telefonen står inte på ljudlöst\n' +
    'Stör ej är av\n' +
    'Batteri- eller energisparläget är av\n' +
    'Vibration är på (Inställningar, Ljud och vibration)\n' +
    'Tryck sedan Prova igen. Går du ändå hoppar vi över den banan.',
  vägrad: 'Webbläsaren säger nej till vibration. Går du ändå hoppar vi över den banan.',
};
const VIBRA_LOG = { ja: 'kändes', nej: 'kändes inte', vägrad: 'webbläsaren sa nej' };
// Why the station is skipped, for its line on the end screen.
const VIBRA_NO_BUZZ = {
  nej: 'vibrationen kändes inte i provet före start',
  vägrad: 'webbläsaren sa nej till vibration i provet före start',
};
// answer: 'ja', 'nej' or 'vägrad' for the newest try-out, null until answered.
// run: counts the try-outs begun and cut short; one under way that finds the
// number moved on has been cut short and touches nothing. undo: what stood
// before the try-out under way, for when it is.
const vibra = { answer: null, tried: false, busy: false, reading: null, trace: null, run: 0, undo: null };

const vibraStatus = () => {
  const said = VIBRA_LOG[vibra.answer] || (vibra.tried ? 'provad, inget svar' : 'inte provad');
  return vibra.reading ? `${said}, ${buzzWords(vibra.reading)}` : said;
};

// The stations the walk would have as the start screen stands: the link's,
// the rest of a round under way, or the whole lab.
function walkStations(def) {
  if (def.prov || !def.lab || ONLY_STATION || chosenFor(def)) return labStations(def);
  const rest = resumeStations && document.querySelector('input[name="resume"]:checked')?.value === 'rest';
  return rest ? resumeStations : LABS[def.lab];
}

function showVibra() {
  // Offered when a walk from here has Hon knackar, and a phone to buzz.
  $('vibra-box').hidden = SIM || !CAN_VIBRATE || !walkStations(CHAPTERS[chapterNo]).includes('vibration');
  const state = vibra.busy ? 'buzzing' : vibra.answer || (vibra.tried ? 'asked' : 'idle');
  $('vibra-box').dataset.state = state === 'vägrad' ? 'refused' : state;
  $('vibra-note').textContent = VIBRA_NOTES[state];
  $('vibra-btn').textContent = vibra.tried ? 'Prova igen' : 'Prova vibrationen';
  $('vibra-btn').disabled = vibra.busy;
  // The question stays up with its answer marked, so a slip can be changed.
  $('vibra-answer').hidden = vibra.busy || !vibra.tried || vibra.answer === 'vägrad';
  $('vibra-answer').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.value === vibra.answer)));
}

async function tryVibration() {
  if (vibra.busy) return;
  const run = ++vibra.run;
  const pattern = knockPattern(3);
  const sleep = s => new Promise(r => setTimeout(r, s * 1000));
  const clock = () => performance.now() / 1000;
  const samples = [];
  const listen = e => {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null && a.y != null && a.z != null) samples.push({ t: clock(), m: Math.hypot(a.x, a.y, a.z) });
  };
  const undo = { answer: vibra.answer, tried: vibra.tried, reading: vibra.reading, trace: vibra.trace };
  Object.assign(vibra, { busy: true, answer: null, reading: null, trace: null, undo });
  showVibra();
  window.addEventListener('devicemotion', listen);
  let at = null, ok = false;
  try {
    await sleep(VIBRA_SETTLE);
    // A page out of sight is refused the buzz (the screen locked, another app
    // in front), and that no says nothing about the phone: as if not tried.
    if (run === vibra.run && document.hidden) stopVibra();
    if (run === vibra.run) {
      at = clock();
      try { ok = !!navigator.vibrate(pattern); } catch (_) { ok = false; }
      if (ok) await sleep(pattern.reduce((a, b) => a + b, 0) / 1000 + 0.2);
    }
  } finally {
    window.removeEventListener('devicemotion', listen);
  }
  if (run !== vibra.run) return;
  Object.assign(vibra, { busy: false, tried: true, answer: ok ? null : 'vägrad', undo: null });
  // The reading is for the log; a fault in it must not leave the box stuck
  // on "Surrar".
  if (ok) {
    try {
      vibra.reading = buzzReading(samples, pattern, at);
      vibra.trace = { pattern, t: samples.map(s => ms(s.t - at)), m: samples.map(s => Math.round(s.m * 100)) };
    } catch (_) {
      vibra.reading = vibra.trace = null;
    }
  }
  showVibra();
}

// Cuts a try-out under way short: the motor stops, and what the walker last
// said about one stands again. The walk does it as it begins. A try-out left
// buzzing shook the new walk's sensor, and one begun after a "nej" had
// already wiped that answer, so the station buzzed into a phone known not to
// (review, 2026-10-06).
function stopVibra() {
  if (!vibra.busy) return;
  vibra.run++;
  try { navigator.vibrate(0); } catch (_) {}
  Object.assign(vibra, vibra.undo, { busy: false, undo: null });
  showVibra();
}

function startGps() {
  if (!navigator.geolocation) { log('gps stöds inte'); return; }
  let first = true;
  watchId = navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    fixTimes.push(now());
    recordFix(now(), c);
    walk.fix(now(), c);
    if (c.accuracy <= MEMORY_MAX_ACCURACY) memory.visit(c.latitude, c.longitude);
    if (first) {
      first = false;
      log(`gps: första fix ±${Math.round(c.accuracy)} m`);
      onFirstPosition(c.latitude, c.longitude);
    }
  }, err => {
    if (first && GPS_TROUBLE_WORD[err.code]) gpsTrouble = err.code;
    log('gps-fel: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

// ---------- accelerometer ----------
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const t = now(), m = Math.hypot(a.x, a.y, a.z);
  record(t, m);
  walk.motion(t, m);
}

function record(t, m) {
  if (rec.t.length >= REC_MAX) return;
  rec.t.push(ms(t));
  rec.m.push(Math.round(m * 100));
}

function recordFix(t, c) {
  if (!rec.origin) rec.origin = { latitude: c.latitude, longitude: c.longitude };
  const north = (c.latitude - rec.origin.latitude) * 111320;
  const east = (c.longitude - rec.origin.longitude) * 111320 * Math.cos(rec.origin.latitude * Math.PI / 180);
  rec.fixes.push([ms(t), Math.round(north * 10) / 10, Math.round(east * 10) / 10,
    c.accuracy == null ? null : Math.round(c.accuracy), c.speed == null ? null : Math.round(c.speed * 100) / 100]);
}

// A file, not the clipboard: an hour of samples is a megabyte, and it goes
// to Demi as an attachment rather than pasted text.
//
// A test walk's file is the whole answer: its name says which test, and it
// carries the end screen's answers and verdicts, so the walker only has to
// put it in the chat (Henric, 2026-10-07: as little handwork as can be).
function saveRecording() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const body = JSON.stringify({
    kind: 'glimt-sensor', version: 1, build: $('build').textContent, browser: BROWSER,
    chapter: chapterNo, station: ONLY_STATION, saved: new Date().toISOString(),
    prov: PROV_ID && {
      id: PROV_ID, title: TEST.title, appVersion: APP_VERSION, answers: provAnswers,
      results: labResults.map(r => ({ ...r, rating: provRatings[r.id] || null })),
    },
    units: {
      t: 'ms since start', m: 'centi m/s², |acceleration including gravity|', fixes: '[t, north m, east m, accuracy m, speed m/s]',
      vibrationCheck: "the start screen's try-out: t in ms from the call to vibrate, m as above",
    },
    t: rec.t, m: rec.m, fixes: rec.fixes, log: rec.log,
    vibrationCheck: vibra.trace && { ...vibra.trace, answer: vibra.answer },
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = PROV_ID ? `glimt-prov-${PROV_ID}-${stamp}.json` : `glimt-sensor-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('save-btn').textContent = PROV_ID ? 'Sparad i Nedladdningar. Lägg filen i chatten med Demi.' : 'Sparad i Nedladdningar';
}

function startMotion() {
  if (typeof DeviceMotionEvent === 'undefined') { log('rörelsesensor: stöds inte, gps avgör gång och stilla'); return; }
  window.addEventListener('devicemotion', onMotion);
}

// ---------- simulator ----------
function startSim() {
  // The slider's speed as footsteps too, so ?sim exercises the step path.
  motionSimId = setInterval(() => {
    // "sensorn tyst" in the sim box: as when the screen locks.
    if ($('sim-sensor-off').checked) return;
    const t = now();
    const m = simulatedMagnitude(t, parseFloat($('sim-speed').value));
    record(t, m);
    walk.motion(t, m);
  }, 20);
  let lat = 59.38, lon = 13.5, heading = 0;
  const speedEl = $('sim-speed');
  const out = $('sim-out');
  speedEl.addEventListener('input', () => { out.textContent = kmh(parseFloat(speedEl.value)); });
  $('sim-turn').addEventListener('click', () => { heading += Math.PI; log('sim: vänder'); });
  $('sim-left').addEventListener('click', () => { heading -= Math.PI / 2; log('sim: vänster'); });
  $('sim-right').addEventListener('click', () => { heading += Math.PI / 2; log('sim: höger'); });
  // One sharp sample between the simulated steps. Click twice for a double.
  // Walking it is as hard as Henric's recorded walking knocks (18-60): the
  // walking bar is 15, and a standing knock's 9 never cleared it.
  $('sim-knock').addEventListener('click', () => {
    const m = 9.81 + (walk.state().moving ? 40 : 9);
    record(now(), m);
    walk.motion(now(), m);
  });
  let first = true;
  simId = setInterval(() => {
    const v = parseFloat(speedEl.value);
    const accuracy = $('sim-fog').checked ? 80 : 8;
    lat += (v * Math.cos(heading)) / 111320;
    lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
    fixTimes.push(now());
    const fix = { latitude: lat, longitude: lon, accuracy, speed: v };
    recordFix(now(), fix);
    walk.fix(now(), fix);
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
  if (side) side.close();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('walking').hidden = true;
  $('done').hidden = false;
  // A test walk is not one of her walks: it claims no squares and is not
  // the last walk her memory lines count from.
  if (memory && !TEST) {
    if (now() >= MEMORY_MIN_WALK) {
      memory.endWalk(Date.now(), chapterNo);
      log(`minne: ${memory.fresh.size} nya rutor, ${memory.known.size} totalt`);
      showWorld('world-end', memory, memory.fresh, 'end');
    } else {
      // Too short to count: her world as it was, no new squares claimed.
      showWorld('world-end', new Memory(SIM ? null : localStorage), new Set(), 'short');
    }
  }
  if (CHAPTERS[chapterNo].lab) {
    // Stopped mid-station: it still goes on the list, so it can be rated.
    // The first field lab ended inside Hitta, and Hitta got no verdict.
    if (currentStation && !labResults.some(r => r.id === currentStation)) {
      labResults.push({ id: currentStation, outcome: 'avbruten', detail: 'du avslutade mitt i banan' });
    }
    // runLab says this at its end, which a walk stopped early never reaches.
    if (labMemo && !logLines.some(l => l.includes('dubbelknack utan'))) {
      const windows = labMemo.knockWindows || [];
      const stray = walk.knocks.history.filter(t => !windows.some(([a, b]) => t >= a && t <= b)).length;
      log(`knack: ${stray} dubbelknack utan att någon bad om det`);
    }
    showLabResults();
  }
  $('final-log').textContent = logLines.join('\n');
  // A test walk's file carries its answers, so it is offered without a
  // sensor too.
  $('save-btn').hidden = rec.t.length === 0 && !PROV_ID;
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
const OUTCOME_WORDS = { klarade: 'klarade', missade: 'missade', hoppade: 'hoppades över', avbruten: 'avbröts' };

function loadRatings() {
  try {
    const all = JSON.parse(localStorage.getItem(RATINGS_KEY) || '[]');
    return Array.isArray(all) ? all : [];
  } catch (_) { return []; }
}

function saveRating(entry) {
  try {
    const all = loadRatings();
    all.push(entry);
    localStorage.setItem(RATINGS_KEY, JSON.stringify(all.slice(-500)));
  } catch (_) {}
}

// The test walk's questions on the end screen: what only the walker knows.
// Each answer goes in the log and in the saved file.
const provAnswers = {};
const provRatings = {};
function showProvAsks() {
  const box = $('prov-asks');
  box.textContent = '';
  box.hidden = !TEST || !TEST.asks || !TEST.asks.length;
  if (box.hidden) return;
  for (const q of TEST.asks) {
    const group = document.createElement('div');
    group.className = 'prov-ask';
    const label = document.createElement('p');
    label.className = 'prov-ask-text';
    label.textContent = q.text;
    const row = document.createElement('div');
    row.className = 'lab-rate';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', q.text);
    for (const option of q.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = option;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        if (provAnswers[q.id] === option) return;
        const changed = q.id in provAnswers;
        provAnswers[q.id] = option;
        row.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        log(`svar: ${q.text}: ${option}${changed ? ' (ändrat)' : ''}`);
        $('final-log').textContent = logLines.join('\n');
      });
      row.appendChild(b);
    }
    group.append(label, row);
    box.appendChild(group);
  }
}

function showLabResults() {
  const box = $('lab-results');
  const list = $('lab-list');
  list.textContent = '';
  showProvAsks();
  if (!labResults.length && !TEST) { box.hidden = true; return; }
  box.hidden = false;
  $('end-word').textContent = TEST ? `${TEST.title}: några frågor till dig` : 'Vilka banor vill du göra igen?';
  $('lab-hint').textContent = TEST
    ? 'Svara på frågorna, tryck Spara filen till Demi och lägg filen i chatten. Mer behövs inte.'
    : 'Ditt svar hamnar i loggen. Kopiera den och skicka till Demi, och spara gärna sensordatan och lägg filen i chatten.';
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
        provRatings[r.id] = value;
        saveRating({ at: new Date().toISOString(), station: r.id, rating: value, outcome: r.outcome, walk: walkId, only: !!ONLY_STATION, picked: !!pickedWalk, prov: PROV_ID });
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
  // Her side has its own way out to the speakers and fades with the rest.
  if (side) side.fade(2);
  await mixer.fadeOut(2);
  finish();
});

$('save-btn').addEventListener('click', saveRecording);

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
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (walking()) log('wake lock: släppt, skärmen kan slockna');
    });
  } catch (err) {
    log('wake lock: ' + err.message);
  }
}

// Said in the log both ways: the sensor stops with a hidden page, and the
// first field lab could only guess at why it went quiet (2026-09-28).
document.addEventListener('visibilitychange', () => {
  // Back from the phone's settings: ask again, the answer may have changed.
  if (!walking()) { checkGps(); return; }
  if (document.visibilityState === 'visible') {
    log('sidan: synlig igen');
    if (!wakeLock) acquireWakeLock();
    if (mixer && mixer.ctx.state === 'suspended') mixer.resume();
  } else {
    log('sidan: dold (skärmen låst eller en annan app framme)');
  }
});

// ---------- start screen ----------
function selectChapter(n) {
  chapterNo = CHAPTERS[n] ? String(n) : 'episod1';
  // A hidden choice (?kapitel=labb2 before its radio exists) still runs,
  // it just has no radio to tick.
  const radio = document.querySelector(`input[name="chapter"][value="${chapterNo}"]`);
  if (radio) radio.checked = true;
  else document.querySelectorAll('input[name="chapter"]').forEach(el => { el.checked = false; });
  try { if (radio) localStorage.setItem('glimt-chapter', chapterNo); } catch (_) {}
  const def = CHAPTERS[chapterNo];
  $('subtitle').textContent = def.subtitle;
  $('variant-box').hidden = !!def.lab || !!def.side;
  // A test walk is the link's one choice: nothing else to pick.
  $('chapter-box').hidden = !!def.prov;
  showProvBox(def);
  // The round's choice first: the try-out is offered for the stations it gives.
  showResume(def);
  showVibra();
  document.title = def.prov ? `Glimt, test: ${def.prov.title}` : def.lab ? `Glimt, labb ${def.lab}`
    : def.side ? 'Glimt, episod 1' : `Glimt, kapitel ${chapterNo}`;
  preload();
}

// The test walk's card: what it is for and what to do, and the version, so a
// phone still on an old one shows it before the walk.
function showProvBox(def) {
  $('prov-box').hidden = !def.prov;
  if (!def.prov) return;
  $('prov-title').textContent = def.prov.title;
  $('prov-question').textContent = def.prov.question;
  $('prov-todo').textContent = def.prov.todo;
  $('prov-version').textContent = `Version ${APP_VERSION}`;
}

// The rated stations of the lab's round under way, and where it goes on.
// Nothing to choose when none are rated, or when the URL picked the stations.
const NUMBER_WORDS = { 7: 'sju', 8: 'åtta' };
function showResume(def) {
  const done = def.lab && !ONLY_STATION && !chosenFor(def) && RESUMABLE.includes(def.lab) ? ratedThisRound(loadRatings(), def.lab) : [];
  resumeStations = done.length ? LABS[def.lab].filter(id => !done.includes(id)) : null;
  $('resume-box').hidden = !resumeStations;
  if (!resumeStations) return;
  const n = LABS[def.lab].length;
  $('resume-rest').textContent = `Fortsätt vid ${TITLES[resumeStations[0]]}. ${andList(done.map(id => TITLES[id]))} har du gjort.`;
  $('resume-all').textContent = `Alla ${NUMBER_WORDS[n] || n} från början`;
  document.querySelector('input[name="resume"][value="rest"]').checked = true;
}

(function initStartScreen() {
  let variant = 'a';
  try { variant = localStorage.getItem('glimt-variant') || 'a'; } catch (_) {}
  if (params.get('variant') === 'a' || params.get('variant') === 'b') variant = params.get('variant');
  if (variant !== 'a' && variant !== 'b') variant = 'a';
  document.querySelector(`input[name="variant"][value="${variant}"]`).checked = true;

  let ch = 'episod1';
  try { ch = localStorage.getItem('glimt-chapter') || 'episod1'; } catch (_) {}
  if (params.has('kapitel')) ch = params.get('kapitel');
  // A single station belongs to whichever lab has it.
  if (ONLY_STATION) ch = LABS[2].includes(ONLY_STATION) ? 'labb2' : 'labb1';
  if (TEST) ch = 'prov';
  else if (CHOSEN) ch = `labb${CHOSEN.lab}`;
  // An unreadable ?banor= or ?prov= still meant a lab, and only a lab's
  // start screen has room to say the link was not understood.
  else if (BAD_CHOICE !== null || BAD_PROV !== null) ch = `labb${RESUMABLE[0]}`;
  document.querySelectorAll('input[name="chapter"]').forEach(el => {
    el.addEventListener('change', () => selectChapter(el.value));
  });

  try {
    const last = localStorage.getItem('glimt-last-log');
    if (last) { $('last-log').textContent = last; $('last-log-box').hidden = false; }
  } catch (_) {}

  try {
    const m = new Memory(localStorage);
    if (!TEST) showWorld('world-start', m, m.lastWalkCells(), 'start');
  } catch (_) {}
  if (TEST) $('save-btn').textContent = 'Spara filen till Demi';

  $('start-btn').addEventListener('click', start);
  if (ANDROID_FIREFOX) {
    $('chrome-link').href = chromeIntent();
    $('chrome-link').hidden = false;
  }
  selectChapter(ch);
  // Going on with the rest of a round, or walking all of it, changes whether
  // Hon knackar is in the walk.
  document.querySelectorAll('input[name="resume"]').forEach(el => el.addEventListener('change', showVibra));
  $('vibra-btn').addEventListener('click', tryVibration);
  $('vibra-answer').addEventListener('click', e => {
    const b = e.target.closest('button[value]');
    if (!b || vibra.busy) return;
    vibra.answer = b.value;
    showVibra();
  });
  $('gps-note').addEventListener('click', () => checkGps());
  $('sensor-note').addEventListener('click', checkSensor);
  $('map-note').addEventListener('click', () => { mapCheck.at = -Infinity; checkGps(); });
  checkSensor();
  // Allowed in the browser's settings, or a prompt answered: ask again.
  if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' })
    .then(st => st.addEventListener('change', () => checkGps())).catch(() => {});
  checkGps();
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
