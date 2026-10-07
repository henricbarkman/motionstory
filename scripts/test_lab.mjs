#!/usr/bin/env node
// Runs the mechanics lab (glimt/lab.js) against the engine with simulated
// walkers and a fake clock. The sounds are the real glimt/synth.js on a
// strict stand-in for Web Audio (scripts/fake_audio.mjs); no DOM.
//
// Every station must tell a walker who does what Vega asks from one who does
// not: the `pass` walkers must clear each station and the `fail` walkers must
// miss it. A station both kinds clear, or both miss, measures nothing, and
// that is the bug this script exists to catch.
//
//   node scripts/test_lab.mjs                 # both labs, every profile, 10 runs each
//   node scripts/test_lab.mjs 1 pass          # lab 1, one profile
//   RUNS=10 VERBOSE=1 node scripts/test_lab.mjs 2
//   node scripts/test_lab.mjs 1 abort         # press stop inside every station
//   DETAILS=vagval node scripts/test_lab.mjs 2 fail-drift   # every run's detail
//   node scripts/test_lab.mjs prov            # the test walks (?prov=) only
//   node scripts/test_lab.mjs prov riktning   # one of them

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter, cadencePace, bearing } from '../glimt/engine.js';
import { runLab, labHelpers, LABS, PROV, ratedThisRound, chosenStations, denseGps, realTarget } from '../glimt/lab.js';
import { Synth } from '../glimt/synth.js';
import { makeClock, FakeAudioContext } from './fake_audio.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = parseInt(process.env.RUNS || '10', 10);
// A profile whose stations are judged by a rate walks this many times: ten
// walks against an 85 % bar is a coin toss for a station that clears 94 %.
const RATE_RUNS = parseInt(process.env.RATE_RUNS || '100', 10);
const VERBOSE = !!process.env.VERBOSE;

// Seeded, so a red run means the code changed and not the dice. Unseeded,
// the field profiles' 85 % bars over ten random walks failed three runs in
// six with nothing changed (2026-10-01). Each walk has its own seed from
// lab, profile and run, so a walk is the same whatever ran before it and
// `node scripts/test_lab.mjs 2 pass-field` replays the full run's walks.
// SEED=<n> tries other walks.
const BASE_SEED = parseInt(process.env.SEED || '1', 10) >>> 0;
let seed = 1;
function reseed(...parts) {
  let h = BASE_SEED ^ 2166136261;
  for (const c of parts.join('/')) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  seed = h % 2147483646 + 1;
}
Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

// About ten characters a second, measured on the rendered chapter 2 lines.
const LINES = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/labb.json'), 'utf8')).lines;
const SECONDS = Object.fromEntries(Object.entries(LINES).map(([id, text]) => {
  const plain = text.replace(/\[[a-z]+\]/g, '').replace(/\s+/g, ' ').trim();
  return [id, Math.round(1 + plain.length / 10)];
}));

// The phone from the second field test: a fix every six seconds, positions
// that wander ten metres, its own speed reading far off.
const GOOD_GPS = { every: 1, jitter: 0, accuracy: 8, phone: v => v + (v ? (Math.random() - 0.5) * 0.2 : 0) };
const FIELD_GPS = {
  every: 6, jitter: 10, accuracy: 25, handling: true,
  phone: v => v ? v * (0.8 + Math.random() * 1.4) : 0.3 + Math.random() * 0.5,
};

// GPS error does not jump about fix by fix, it drifts: the satellites in
// view change as the walker passes a building or goes under trees, and the
// position is off in the same direction for half a minute or more. Averaging
// cancels jitter but not drift, so the direction stations are also run with
// a bias that wanders (eight metres typical, half a minute to change) on
// top of five metres of jitter. The size is a guess, like the rest of the
// field phone; the point is that the error is correlated (review 2026-09-25).
const DRIFT_GPS = { ...FIELD_GPS, jitter: 5, drift: { sigma: +(process.env.DRIFT_SIGMA || 8), tau: +(process.env.DRIFT_TAU || 30) } };

// Chrome on the field phone: two fixes a second at ±3-6 m (2026-10-06).
// One a second here, the sim's clock. Measured on that walk's straight
// stretches: 0,5-0,8 m sideways around a straight line over 20-30 s, and the
// fast reading's heading within 3 degrees (sd). This jitter and drift give
// about twice that, on purpose: a walk under trees or between tall houses
// is worse than his street. The test walks' direction reading is judged on
// it, straight walks included (CHROME_SIGMA=4 for much worse).
const CHROME_GPS = {
  every: 1, jitter: 1.5, accuracy: 5, drift: { sigma: +(process.env.CHROME_SIGMA || 2), tau: 30 },
  phone: v => v + (v ? (Math.random() - 0.5) * 0.2 : 0),
};

const PROFILES = {
  pass: { kind: 'pass', gps: GOOD_GPS, steps: true },
  fail: { kind: 'fail', gps: GOOD_GPS, steps: true },
  'pass-field': { kind: 'pass', gps: FIELD_GPS, steps: true },
  'fail-field': { kind: 'fail', gps: FIELD_GPS, steps: true },
  // No accelerometer at all: the step-based stations must step aside.
  'pass-drift': { kind: 'pass', gps: DRIFT_GPS, steps: true },
  'fail-drift': { kind: 'fail', gps: DRIFT_GPS, steps: true },
  'gps-only': { kind: 'pass', gps: GOOD_GPS, steps: false },
  // Presses stop 3, 20 and 45 seconds into each station in turn, one run
  // each: in the intro line, early, and deep in. Nothing may sound on after
  // it, and nothing new may start: a review found a chime created after the
  // stop that pinged until the tab was closed (2026-09-25).
  abort: { kind: 'pass', gps: GOOD_GPS, steps: true, abort: [3, 20, 45] },
  // The first field lab (2026-09-28): the screen went dark as the walker
  // stopped for the first question, and the sensor with it, for six minutes.
  // `screen-off` is that walk, a walker who never looks at the phone until
  // the named line; `screen-wake` looks when Vega asks. Per lab: the line the
  // sensor stops at, and the line (plus seconds) it comes back after.
  'screen-off': {
    kind: 'pass', gps: GOOD_GPS, steps: true,
    sensorOff: { 1: { from: 'ja-intro', until: 'frys-klarade' }, 2: { from: 'morse-intro', until: 'takten-dov', after: 3 } },
  },
  'screen-wake': {
    kind: 'pass', gps: GOOD_GPS, steps: true,
    sensorOff: { 1: { from: 'ja-intro', until: 'sensor-tyst', after: 8 }, 2: { from: 'morse-intro', until: 'sensor-tyst', after: 8 } },
  },
  'pass-chrome': { kind: 'pass', gps: CHROME_GPS, steps: true, provOnly: true },
  'fail-chrome': { kind: 'fail', gps: CHROME_GPS, steps: true, provOnly: true },
  // Knacket gående: the phone taken out and put back bumps twice, as hard
  // as a knock standing. That must count as a double, or the walk cannot
  // tell Henric whether a jolt reads as one.
  jolt: { kind: 'pass', gps: GOOD_GPS, steps: true, jolt: true, provOnly: true },
  // Gå och spring: runs at the word but falls back to a walk after six
  // seconds, both times. The switch is read; the run that did not last must
  // fail it all the same.
  'brief-run': { kind: 'pass', gps: GOOD_GPS, steps: true, briefRun: true, provOnly: true },
  // A test walk whose sensor goes quiet in its first station and comes back
  // when she says so: she must say it within seconds.
  'screen-prov': { kind: 'pass', gps: GOOD_GPS, steps: true, sensorOffProv: true, provOnly: true },
  // The sensor dies inside a knock station, after its start check passed:
  // Knacket as she asks for the first knock, Hon knackar after a round it
  // heard (review, 2026-09-28).
  'screen-mid': {
    kind: 'pass', gps: GOOD_GPS, steps: true,
    sensorOff: { 1: { from: 'knack-intro', until: 'knack-nej', after: 2 }, 2: { from: 'vibra-ratt', until: 'takten-dov', after: 2 } },
  },
};

// What each profile must get. A string is asserted on every run; `null` is
// reported, not asserted. On the field phone the direction stations read
// averaged fixes and still err now and then, so there the demand is a rate
// over all runs ({ want, rate }): most walks right, not every one.
const EXPECT = {
  pass: () => 'klarade',
  fail: () => 'missade',
  'pass-field': id => ['vandom', 'vagval', 'kompass'].includes(id) ? { want: 'klarade', rate: 0.85 } : 'klarade',
  'fail-field': id => ['vandom', 'vagval', 'kompass'].includes(id) ? { want: 'missade', rate: 0.85 } : 'missade',
  'pass-drift': id => ['vandom', 'vagval', 'kompass'].includes(id) ? { want: 'klarade', rate: 0.85 } : null,
  'fail-drift': id => ['vandom', 'vagval', 'kompass'].includes(id) ? { want: 'missade', rate: 0.85 } : null,
  'gps-only': id => ['takten', 'tassa', 'knack', 'vibration'].includes(id) ? 'hoppade' : null,
  abort: () => null,
  // Listening to a silent sensor is a skip, not a miss; the rest runs on GPS.
  'screen-off': id => ['knack', 'takten', 'vibration'].includes(id) ? 'hoppade' : 'klarade',
  'screen-wake': () => 'klarade',
  'screen-mid': id => ['knack', 'vibration'].includes(id) ? 'hoppade' : 'klarade',
};

// How hard the phone's motor shakes the sensor, in m/s² either way. A guess,
// and a hostile one: no buzz has been recorded yet (2026-10-06, the phone was
// on silent). Five passes for knocks standing still, and for the sway of a
// gait in the second after the buzz (from about four), which is what the
// mute and the sway's blind spot are there to stop; taking either out fails
// Hon knackar here. MOTOR=0 walks the lab with a motor the sensor does not
// feel at all, and that must pass too.
const MOTOR = +(process.env.MOTOR ?? 5);
// A real motor does not start the moment the page asks, nor stop at once:
// the browser hands over each buzz in turn, and the motor rings on. Seconds
// late, and seconds its shake takes to die away. Guesses too (a review's,
// 2026-10-06): with the detector deaf for only a quarter second after her
// last buzz, this motor's tail was a knock nobody knocked.
const MOTOR_LAG = +(process.env.MOTOR_LAG ?? 0.2);
const MOTOR_RING = +(process.env.MOTOR_RING ?? 0.25);
// Seconds from her last buzz, as the walker feels it, to the pass walker's
// first knock back.
const ANSWER_AFTER = +(process.env.ANSWER_AFTER ?? 0.7);

// Smallest whole cadence whose stride model reaches `speed`; the same
// inverse simulatedMagnitude uses, so pace from steps matches the GPS.
function cadenceFor(speed) {
  let c = 60;
  while (c < 220 && cadencePace(c) < speed) c++;
  return c;
}

function makeWalker(kind, env) {
  const w = {
    base: 1.4, speed: null, cadenceMul: 1, heading: 0, steer: 0,
    matchBeat: false, knocks: [], events: [], buzzes: [],
  };
  const at = (time, fn) => w.events.push({ time, fn });
  const stopAt = time => at(time, () => { w.speed = 0; });
  const goAt = time => at(time, () => { w.speed = null; });
  const speedAt = (time, v) => at(time, () => { w.speed = v; });
  // Knocks standing are light on purpose (the low bar must hear them).
  // Walking ones are as hard as Henric's recorded pocket gave, 18-60: they
  // must clear the walking bar over the heel strikes (2026-09-28).
  const knock = (time, height = 8) => w.knocks.push({ t: time, height });
  const pass = kind === 'pass';

  w.onLine = (id, t) => {
    const off = env.sensorOff;
    if (off && id === off.from) { w.sensorOff = true; env.note('sensor off'); }
    if (off && id === off.until && w.sensorOff) at(t + (off.after || 0), () => { w.sensorOff = false; env.note('sensor on'); });
    if (id.startsWith('hitta-intro') || id === 'kompass-intro') w.steer = pass ? 1 : -1;
    if (['hitta-framme', 'hitta-tid', 'kompass-framme', 'kompass-tid'].includes(id)) w.steer = 0;
    // Sensorvakten: the pass walker locks the screen as asked and unlocks
    // when she says the steps are gone.
    if (pass && id === 'vakten-intro') at(t + 2, () => { w.sensorOff = true; w.locked = true; env.note('sensor off'); });
    if (id === 'sensor-tyst' && w.locked) at(t + 4, () => { w.sensorOff = false; w.locked = false; env.note('sensor on'); });
    if (!pass) {
      // The fail walker walks on through everything. Where a station has a
      // second way to fail it does that instead: uneven steps in Stämma
      // linjen, a stop that does not last in Frys, speeding up the way
      // someone does who forgets in Gå normalt.
      if (id === 'linjen-intro') w.uneven = true;
      if (id === 'linjen-stanna') w.uneven = false;
      if (id === 'frys-nu') { stopAt(t + 0.8); goAt(t + 7); }
      if (id === 'normalt-nu') speedAt(t + 20, w.base * 1.35);
      // Stops instead of turning back: standing, the GPS wander alone can
      // look like a step back.
      if (id === 'vandom-nu' || id === 'vandom-igen') { stopAt(t + 1); goAt(t + 40); }
      if (id === 'normalt-marktes' || id === 'normalt-klarade') goAt(t + 0.5);
      return;
    }
    switch (id) {
      case 'linjen-stanna': stopAt(t + 1); break;
      case 'linjen-ga': goAt(t + 1); break;
      case 'ja-q1': case 'ja-q2-ljust': case 'ja-q2-morkt': stopAt(t + 1.5); goAt(t + 8); break;
      case 'knack-intro': stopAt(t + 0.5); knock(t + 2); knock(t + 2.3); break;
      case 'knack-igen': knock(t + 1.5); knock(t + 1.8); break;
      case 'knack-hord': case 'knack-inget': goAt(t + 0.5); break;
      // Walking, one blow soft and one hard, the shape of his recorded
      // doubles (19/39, 43/19, 32/61).
      case 'knack-ga': knock(t + 8, 20); knock(t + 8.3, 40); break;
      case 'knack-fraga': knock(t + 3, 40); knock(t + 3.3, 20); break;
      case 'takten-intro': w.matchBeat = true; break;
      case 'takten-slut': w.matchBeat = false; goAt(t); break;
      case 'flykten-intro': speedAt(t + 1, 2.8); break;
      case 'flykten-undan': case 'flykten-fast': goAt(t + 1); break;
      case 'frys-nu': stopAt(t + 0.8); break;
      case 'frys-klarade': case 'frys-rorde': case 'frys-sen': goAt(t + 0.5); break;
      case 'spoket-intro': speedAt(t + 0.5, w.base * 1.3); break;
      case 'spoket-klarade': case 'spoket-forbi': goAt(t + 0.5); break;
      case 'vandom-nu': case 'vandom-igen': at(t + 1.5, () => { w.heading += Math.PI; }); break;
      // Right, or left when the run says so (the test walk asks for left).
      case 'vagval-intro': at(t + 12, () => { w.heading += env.left ? -Math.PI / 2 : Math.PI / 2; }); break;
      // Kontakten: two stops of 28 s, the walk between long enough for her
      // to come all the way back.
      case 'kontakt-intro': stopAt(t + 10); goAt(t + 38); stopAt(t + 80); goAt(t + 108); break;
      // Knacket gående: his recorded walking double, without a stop.
      case 'knackgang-nu': knock(t + 1.5, 40); knock(t + 1.8, 20); break;
      // Gå och spring: a jog, 10,8 km/h, a second after each word.
      case 'vaxla-spring': case 'vaxla-spring-igen': speedAt(t + 1, 3.0); if (env.briefRun) goAt(t + 7); break;
      case 'vaxla-ga': case 'vaxla-ga-igen': goAt(t + 1); break;
      case 'knackgang-ficka':
        stopAt(t + 1); goAt(t + 8);
        if (env.jolt) { knock(t + 3, 8); knock(t + 3.4, 8); }
        break;
      case 'morse-intro': case 'morse-igen':
        stopAt(t + 1); goAt(t + 7); stopAt(t + 13); goAt(t + 21); break;
      case 'vibra-intro': stopAt(t + 0.5); break;
      // A skipped station ('takten-dov') means walk on, like the end of one.
      case 'vibra-slut': case 'vibra-kande-inte': case 'vibra-kan-inte': case 'takten-dov': goAt(t + 0.5); break;
      // Soft steps: a smaller wave and half the heel strike, same pace.
      // How much softer a real pocket reads is not known yet (2026-09-25).
      case 'tassa-nu': at(t + 1, () => { w.soft = true; }); break;
      case 'tassa-klarade': case 'tassa-inte': at(t + 0.5, () => { w.soft = false; }); break;
    }
  };

  // The phone buzzes whoever carries it: `buzzes` are the stretches its motor
  // runs. Only the pass walker knocks back, as many times, and promptly: the
  // first knock 0.7 s after her last buzz ends, about as soon as one can be
  // sure it was the last. An earlier walker waited 1.3 s, and the station
  // passed for days while its count opened a second after the buzz
  // (2026-10-06).
  w.onVibrate = (pattern, t) => {
    let u = t + MOTOR_LAG, end = u;
    for (let i = 0; i < pattern.length; i += 2) {
      end = u + pattern[i] / 1000;
      w.buzzes.push([u, end]);
      u = end + (pattern[i + 1] || 0) / 1000;
    }
    if (!pass) return;
    for (let i = 0; i < Math.ceil(pattern.length / 2); i++) knock(end + ANSWER_AFTER + i * 0.45);
  };

  let beatSeen = null;
  w.step = (t, pos) => {
    const due = w.events.filter(e => e.time <= t);
    w.events = w.events.filter(e => e.time > t);
    due.sort((a, b) => a.time - b.time).forEach(e => e.fn());
    // In Takten the pass walker hears the beat change and follows it a few
    // seconds later.
    if (w.matchBeat && env.bpm() && env.bpm() !== beatSeen) {
      beatSeen = env.bpm();
      speedAt(t + 2.5, cadencePace(beatSeen));
    }
    if (w.steer && env.target() && pos) {
      const b = bearing(pos, env.target()) * Math.PI / 180;
      w.heading = w.steer > 0 ? b : b + Math.PI;
    }
    let speed = w.speed === null ? w.base : w.speed;
    if (w.uneven && speed > 0) speed *= Math.floor(t / 5) % 2 ? 0.7 : 1.3;
    const cadence = speed > 0.3 ? cadenceFor(speed) * w.cadenceMul : 0;
    return { speed, cadence, heading: w.heading, soft: !!w.soft };
  };
  return w;
}

function simulate(labNo, name, run, abortIn = null, { stations = null, noBuzz = null, prov = null } = {}) {
  reseed(labNo, name, run, abortIn ? `${abortIn.id}@${abortIn.after}` : '', stations ? stations.join(',') : '', prov || '');
  const profile = PROFILES[name];
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  const results = [];
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let ended = false;
  let target = null, nextBump = 0, phase = 0, stepNo = -1, stepHard = 1, motorUp = false;
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // Every other run has a landmark 250 m east, so Hitta tries both kinds.
  const world = { light: 'dark', rain: false, landmark: 'skog', landmarkCoord: null };
  if (run % 2 === 1) {
    world.landmark = 'vatten';
    world.landmarkCoord = { lat, lon: lon + 250 / (111320 * Math.cos(lat * Math.PI / 180)) };
  }
  // The test walks' Ljudkompassen walks to what the map found: a bridge
  // 180 m east and water 120 m north, so the bridge wins (realTarget).
  if (prov) {
    world.landmarkAnswered = 'karta';
    world.sources = { landmark: 'karta' };
    world.nearby = {
      bro: { lat, lon: lon + 180 / (111320 * Math.cos(lat * Math.PI / 180)), dist: 180 },
      vatten: { lat: lat + 120 / 111320, lon, dist: 120 },
    };
  }

  // The walker hears the beat: its tempo is read off the last two beats
  // the real Synth scheduled, not off what the station asked for.
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const sfx = new Synth({ ctx: audio, master: audio.createGain() }, clock);
  const bpm = () => {
    const h = [...sfx.live].find(x => Array.isArray(x.beats));
    const b = h && h.beats;
    return b && b.length >= 2 ? Math.round(60 / (b[b.length - 1] - b[b.length - 2])) : null;
  };
  const sensorOff = profile.sensorOffProv && prov
    ? { from: { prov: 'prov-intro' }.prov, until: 'sensor-tyst', after: 4 }
    : profile.sensorOff && profile.sensorOff[labNo];
  const walker = makeWalker(profile.kind, {
    bpm, target: () => target, sensorOff, jolt: !!profile.jolt, briefRun: !!profile.briefRun, left: run % 2 === 0,
    note: msg => log.push(`${fmt(t)}  ~ ${msg}`),
  });
  let station = null, stationAt = 0, aborted = null;
  let pressedAt = null, startedBefore = 0, liveAtPress = 0;
  const trace = [];
  // The drifting bias, north and east in metres, started from its spread.
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const drift = profile.gps.drift;
  let biasN = drift ? drift.sigma * gauss() : 0, biasE = drift ? drift.sigma * gauss() : 0;

  let voiceChain = Promise.resolve();
  let buzzed = 0;               // times the phone was asked to vibrate
  const helpers = labHelpers(walk, {
    now: () => t,
    vibrateImpl: p => { buzzed++; walker.onVibrate(p, t); return true; },
  });
  const ctx = {
    world, sfx, memo: {}, noBuzz,
    state: () => walk.state(),
    log: msg => log.push(`${fmt(t)}  ${msg}`),
    hold: on => { walk.contact.hold = on; },
    until: (pred, opts) => waiter.until(pred, opts),
    // One line at a time, as app.js plays them: a line asked for while
    // another plays (the sensor watcher's) waits its turn, and the log
    // stamps it when it starts, not when it was asked for.
    play(id) {
      const dur = SECONDS[id];
      if (dur === undefined) throw new Error(`unknown line ${id}`);
      const turn = voiceChain.then(() => {
        log.push(`${fmt(t)}  ▶ ${id}`);
        return waiter.until(() => false, { timeout: dur }).then(() => walker.onLine(id, t));
      });
      voiceChain = turn.catch(() => {});
      return turn;
    },
    station(id, k, n) { station = id; stationAt = t; if (id) log.push(`${fmt(t)}  == ${id} ${k}/${n}`); },
    result(id, r) { results.push({ id, ...r }); log.push(`${fmt(t)}  => ${id}: ${r.outcome}. ${r.detail}`); },
    ...helpers,
    setTarget: c => { target = c; walk.setTarget(c); },
  };

  const done = runLab(ctx, labNo, { stations, prov }).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });

  return (async () => {
    while (!ended && t < 45 * 60) {
      clock.advance(t, () => audio.update());
      // The stop button, as app.js has it: the sounds close at once, the
      // stations tick on through two seconds of fade, then finish() ends
      // the waits.
      if (abortIn !== null && pressedAt === null && station === abortIn.id && t >= stationAt + abortIn.after) {
        log.push(`${fmt(t)}  ■ stop`);
        pressedAt = t;
        startedBefore = audio.started.length;
        liveAtPress = sfx.live.size;
        sfx.close();
        audio.watching = true;
      }
      if (pressedAt !== null && t >= pressedAt + 2) {
        aborted = await finishWalk();
        break;
      }
      const pos = walk.position();
      const { speed, cadence, heading, soft } = walker.step(t, pos || { latitude: lat, longitude: lon });
      // The accelerometer at 50 Hz: one wave per step at the walker's
      // cadence, noise, a sharp spike per knock, and while standing on the
      // field phone a bump every second or so from handling it.
      if (profile.steps && !walker.sensorOff) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          // Integrate the step phase so a cadence change does not jump it.
          phase += cadence / 60 * 0.02;
          let m = 9.81 + (Math.random() - 0.5) * 0.3;
          if (cadence > 0) {
            m += (speed > 2 ? 6 : 3) * (soft ? 0.55 : 1) * Math.sin(2 * Math.PI * phase);
            // A heel strike on top of the wave: a narrow pulse at each step,
            // sharper and harder when running. The width and height are a
            // guess (no pocket recording yet); they are there so the knock
            // detector meets something sharper than a sine. No two strikes
            // are equally hard, so some clear the knock threshold and some
            // do not, which is how stray pairs happen in a real run.
            if (Math.floor(phase) !== stepNo) { stepNo = Math.floor(phase); stepHard = 0.6 + Math.random() * 0.8; }
            const dp = ((phase % 1) + 1.25) % 1 - 0.5;
            const dt = dp * 60 / cadence;
            const [h, sigma] = speed > 2 ? [10, 0.02] : [4, 0.025];
            m += stepHard * (soft ? 0.5 : 1) * h * Math.exp(-(dt * dt) / (2 * sigma * sigma));
          }
          for (const k of walker.knocks) if (u >= k.t - 0.01 && u < k.t + 0.01) m += k.height;
          // The phone's own motor: every other sample up, every other down
          // while it runs, and dying away after each buzz.
          const buzz = walker.buzzes.find(([a, b]) => u >= a && u < b + MOTOR_RING);
          if (buzz) {
            const amp = u < buzz[1] ? MOTOR : MOTOR * (1 - (u - buzz[1]) / MOTOR_RING);
            motorUp = !motorUp;
            m += motorUp ? amp : -amp;
          }
          if (profile.gps.handling && speed === 0) {
            if (u >= nextBump + 0.15) nextBump = u + 0.8 + Math.random() * 0.8;
            if (u >= nextBump) m += 1.6;
          }
          walk.motion(u, m);
        }
      }
      if (Number.isInteger(t)) {
        lat += (speed * Math.cos(heading)) / 111320;
        lon += (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        const g = profile.gps;
        if (drift) {
          const k = Math.sqrt(2 / drift.tau) * drift.sigma;
          biasN += -biasN / drift.tau + k * gauss();
          biasE += -biasE / drift.tau + k * gauss();
        }
        if (t % g.every === 0) {
          const j = () => (Math.random() - 0.5) * 2 * g.jitter;
          walk.fix(t, {
            latitude: lat + (j() + biasN) / 111320,
            longitude: lon + (j() + biasE) / (111320 * Math.cos(lat * Math.PI / 180)),
            accuracy: g.accuracy, speed: g.phone(speed),
          });
        }
      }
      const s = walk.tick(t);
      trace.push({ t, band: s.band, speed, station });
      waiter.check(s);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      t = Math.round((t + 0.25) * 4) / 4;
    }
    await Promise.race([done, Promise.resolve()]);
    // However the walk ended, the app closes the Synth. Five seconds on,
    // every fade must have run out and every loop stopped.
    const liveAtEnd = aborted ? aborted.live : sfx.live.size;
    if (!aborted) await drain();
    const after = aborted || { live: liveAtEnd, playing: audio.playing.size, intervals: clock.intervals(), started: 0, raised: 0 };
    // Where each double nobody asked for fell: band, speed, station.
    const windows = ctx.memo.knockWindows || [];
    const strays = walk.knocks.history.filter(k => !windows.some(([a, b]) => k >= a && k <= b)).map(k => {
      const at = trace.findLast(x => x.t <= k) || {};
      const before = trace.findLast(x => x.t <= k - 3) || {};
      return `${fmt(k)} ${at.station} band ${at.band}, ${at.speed?.toFixed(1)} m/s (3 s before: ${before.band}, ${before.speed?.toFixed(1)} m/s)`;
    });
    return { log, results, ended, t, station, strays, buzzed, sound: { ...after, liveAtEnd } };
  })();

  // What finish() in app.js does to the sound and the waits, then five
  // seconds of audio clock with no ticks, as in a phone after Avsluta.
  async function finishWalk() {
    waiter.abort();
    sfx.close();
    await drain();
    return {
      live: liveAtPress, playing: audio.playing.size, intervals: clock.intervals(),
      started: audio.started.length - startedBefore, raised: audio.raised,
    };
  }

  async function drain() {
    sfx.close();
    for (let k = 0; k < 20; k++) {
      for (let i = 0; i < 4; i++) await Promise.resolve();
      clock.advance(clock.time + 0.25, () => audio.update());
    }
  }
}

// Going on where the walker left off: which stations a round has rated, and
// a lab run from the first unrated one. Henric walked two stations of labb 2
// on 2026-10-01 and had to stop; the next walk starts at Vägvalet.
async function resumeChecks() {
  let failed = 0;
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
  const r = (...ids) => ids.map(station => ({ station, rating: 'igen' }));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(same(ratedThisRound([], 2), []), 'nothing rated, nothing to skip');
  check(same(ratedThisRound(r('normalt', 'vandom'), 2), ['normalt', 'vandom']), 'two rated in labb 2 are skipped');
  check(same(ratedThisRound(r('knack', 'takten', 'normalt'), 2), ['normalt']), "labb 1's ratings do not count in labb 2");
  check(same(ratedThisRound(r('vandom', 'normalt', 'vandom'), 2), ['normalt', 'vandom']), 'a changed rating counts once, in the lab\'s order');
  check(same(ratedThisRound(r(...LABS[2], 'normalt'), 2), ['normalt']), 'a round with every station rated is over; the next starts empty');
  check(same(ratedThisRound(r(...LABS[2]), 2), []), 'all seven rated: the whole lab again');
  check(same(ratedThisRound([null, { rating: 'nej' }, ...r('tassa')], 2), ['tassa']), 'a broken entry is skipped');
  const stopped = [{ station: 'vagval', rating: 'igen', outcome: 'avbruten' }, { station: 'kompass', rating: 'nej', outcome: 'hoppade' }];
  check(same(ratedThisRound([...r('normalt'), ...stopped], 2), ['normalt']), 'a station stopped inside or skipped is not done, rated or not');
  // Review, 2026-10-01: a try-out with ?bana= is not a walk of the lab, and a
  // rating changed after the last station is not the next round's first.
  check(same(ratedThisRound([...r('normalt'), { station: 'vagval', rating: 'igen', outcome: 'klarade', only: true }], 2), ['normalt']),
    'a station tried alone does not count as done in the lab');
  const walked = (walk, ...ids) => ids.map(station => ({ station, rating: 'igen', outcome: 'klarade', walk }));
  check(same(ratedThisRound([...walked('w1', ...LABS[2]), ...walked('w1', 'tassa')], 2), []),
    'changing a rating on the done screen does not open a new round');
  check(same(ratedThisRound([...walked('w1', ...LABS[2]), ...walked('w2', 'normalt')], 2), ['normalt']),
    'the next walk of the lab does');
  for (const junk of [{}, 5, true, 'x', null]) check(same(ratedThisRound(junk, 2), []), `a stored ${JSON.stringify(junk)} is no ratings`);

  // ?banor=: the three stations Firefox skipped, walked in Chrome, where the
  // saved ratings are not (2026-10-01).
  const picked = x => JSON.stringify(chosenStations(x));
  check(picked('vagval,kompass,vibration') === JSON.stringify({ lab: 2, stations: ['vagval', 'kompass', 'vibration'] }), 'a link names three stations of labb 2');
  check(picked('vibration, vagval') === JSON.stringify({ lab: 2, stations: ['vagval', 'vibration'] }), "they are walked in the lab's order, spaces or not");
  check(picked('VAGVAL,Kompass,vagval') === JSON.stringify({ lab: 2, stations: ['vagval', 'kompass'] }), 'in any case, each once');
  // Review: labb 1 is never walked in part; Takten, Flykten and Spöket read
  // the pace Stämma linjen measures.
  for (const bad of ['knack,takten', 'vagval,knack', 'vagval,vagvalet', '', ',', null, undefined]) {
    check(chosenStations(bad) === null, `${JSON.stringify(bad)} chooses nothing`);
  }
  check(same(ratedThisRound([...r('normalt'), { station: 'vagval', rating: 'igen', outcome: 'klarade', picked: true }], 2), ['normalt']),
    "a station walked from a link stands for another browser's round, not this one's");
  const three = ['vagval', 'kompass', 'vibration'];
  const chosenWalk = await simulate(2, 'pass', 0, null, { stations: three });
  check(same(chosenWalk.results.map(x => x.id), three), `the link walks just those (${chosenWalk.results.map(x => x.id).join(', ')})`);

  // Hon knackar and a phone that will not buzz. On 2026-10-06 Chrome said
  // yes and the phone, on silent, never moved: the station waited twice for
  // knocks and called it a miss. The start screen now has a try-out, and
  // when that was not felt the station steps aside before it begins.
  check(chosenWalk.buzzed === 2, `with a phone that buzzes she knocks once a round (${chosenWalk.buzzed})`);
  // She says that a second round comes. On 2026-10-06 the three came with no
  // word of more, a second and a half after "Rätt. Samma antal.", and he
  // never noticed them.
  const where = re => chosenWalk.log.map((l, i) => re.test(l) ? i : -1).filter(i => i >= 0);
  const again = where(/▶ vibra-igen$/), counted = where(/hon knackade \d, du \d/), read = where(/surr: /);
  check(again.length === 1 && counted[0] < again[0] && again[0] < read[1],
    `she says a second round comes, once, between the first count and her next knocks (line ${again.join(', ')}; counts ${counted.join(', ')}; buzzes read ${read.join(', ')})`);
  const num = x => parseFloat(x.replace(',', '.'));
  const seen = chosenWalk.log.map(l => /surr: sensorn (\d+,\d+) före, (\d+,\d+) under surren, (\d+,\d+) emellan/.exec(l)).filter(Boolean);
  check(seen.length === 2, `and the log has the sensor's reading of each buzz (${seen.length})`);
  // Against the level before, wherever a late motor's shake landed.
  if (MOTOR > 0) check(seen.every(m => Math.max(num(m[2]), num(m[3])) > 5 * num(m[1])), `the motor shows in it (${seen.map(m => `${m[1]} / ${m[2]} / ${m[3]}`).join('; ')})`);
  const why = 'vibrationen kändes inte i provet före start';
  const unfelt = await simulate(2, 'pass', 0, null, { stations: three, noBuzz: why });
  const said = id => unfelt.log.some(l => l.endsWith(`▶ ${id}`));
  const skipped = unfelt.results.find(x => x.id === 'vibration') || {};
  check(skipped.outcome === 'hoppade' && skipped.detail === why, `a try-out that was not felt skips the station and says why (${skipped.outcome}: ${skipped.detail})`);
  check(unfelt.buzzed === 0, `the phone is never asked to buzz (${unfelt.buzzed})`);
  check(said('vibra-kan-inte') && !said('vibra-intro'), 'she says it at once, without asking the walker to stop and feel for it');
  check(unfelt.results.filter(x => x.id !== 'vibration').every(x => x.outcome === 'klarade') && unfelt.ended, `the other stations are walked as usual (${unfelt.results.map(x => x.outcome).join(', ')})`);

  const rest = LABS[2].filter(id => !['normalt', 'vandom'].includes(id));
  const { log, results, ended } = await simulate(2, 'pass', 0, null, { stations: rest });
  check(ended, 'the resumed lab ends');
  check(same(results.map(x => x.id), rest), `it walks the five left, in order (${results.map(x => x.id).join(', ')})`);
  const first = log.find(l => l.includes('== '));
  check(/== vagval 3\/7$/.test(first || ''), `numbered as in the whole lab (${first && first.trim()})`);
  check(results.every(x => x.outcome === 'klarade'), `and a walker who does as asked clears them (${results.map(x => x.outcome).join(', ')})`);
  return failed;
}

// ---------- the test walks (?prov=, 2026-10-07) ----------
// Each walk is run by walkers who do as asked and walkers who do not, like
// the labs, and its log must say what Henric's walk is for without anyone
// reading the sensor file: the lines named in PROV_SAYS, per walk, have to
// be there. Riktning is also walked on dense GPS (Chrome) both ways, and
// held to how fast it reads a turn there.
const SENSOR_PROV = Object.keys(PROV).filter(id => PROV[id].sensor);
const DIRECTION = ['vagval', 'vandom'];
const PROV_EXPECT = {
  pass: () => 'klarade',
  fail: () => 'missade',
  // Without a sensor the walks that need one step aside; the rest run on GPS.
  'gps-only': (id, prov) => ['frys', 'knackgang', 'takten', 'tassa', 'vakten'].includes(id) ? 'hoppade' : null,
  'pass-chrome': id => DIRECTION.includes(id) ? { want: 'klarade', rate: 0.9 } : null,
  'fail-chrome': id => DIRECTION.includes(id) ? { want: 'missade', rate: 0.95 } : null,
  jolt: id => id === 'knackgang' ? 'missade' : null,
  'brief-run': id => id === 'vaxla' ? 'missade' : null,
  'screen-prov': () => null,
  abort: () => null,
};
const PROV_PROFILES = {
  pass: Object.keys(PROV), fail: Object.keys(PROV), 'gps-only': [...SENSOR_PROV, 'vaxla'],
  'pass-chrome': ['riktning'], 'fail-chrome': ['riktning'], jolt: ['knack'], 'brief-run': ['vaxla'], 'screen-prov': Object.keys(PROV), abort: Object.keys(PROV),
};
// What a pass walk's results and log must say, so the walk answers its
// question from the log alone.
const PROV_SAYS = {
  frys: [/stopp läst [\d,]+ s efter ordet \(steg\): du stannade .*telefonen märkte det [\d,]+ s efter sista steget/, /frys 2: /],
  ja: [/ja-q1: ja läst [\d,]+ s efter ordet \(steg\): du stannade/, /ja\/ja\/nej \(rätt: ja\/ja\/nej\)/],
  kontakt: [/stopp 1: stod [\d,]+ s \(still läst [\d,]+ s efter sista steget\), dov under 0,5 efter [\d,]+ s, under 0,2 efter/, /stopp 2: .*över 0,8 efter [\d,]+ s/],
  knack: [/knack gående 3: hört \(\d+ utslag/, /gående 3 av 3 hörda .*upp ur fickan 0 dubbelknack/],
  riktning: [/vägval: (tät|gles) gps \(\d+ positioner på 20 s/, /läst [\d,]+ s efter frågan, [\d,]+ s efter svängen i spåret/, /[\d,]+ s efter vändpunkten i spåret/],
  kompass: [/kompass: mot en bro \d+ m bort, framme inom 25 m \(kartan: /, /en bro \d+ m bort, framme efter/],
  takten: [/dina steg \d+\/\d+\/\d+ per minut, gps /],
  hitta: [/framme efter/],
  tassa: [/före: \d+ steg, styrka/],
  vaxla: [/växla 2 \(spring\): löpning läst [\d,]+ s efter ordet, annat band \d+ % .*\d+ steg\/min, gps [\d,]+ km\/h, stegen avgjorde/,
    /växla 3 \(gå\): gång läst [\d,]+ s efter ordet/, /Flykten och Spöket räknar från gångfarten [\d,]+ km\/h/, /Gå och spring gicks blandat \(löpning \d+ %/],
  vakten: [/tyst (redan under ordet|[\d,]+ s efter ordet), hon bad om att få säga till [\d,]+ s (senare|efter ordet), sensorn tillbaka efter/],
};

async function provChecks(only) {
  let failed = 0;
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };

  // The pure parts first.
  const fixes = (n, acc, step = 1) => Array.from({ length: n }, (_, i) => ({ t: 100 - i * step, latitude: 0, longitude: 0, accuracy: acc }));
  check(denseGps(fixes(20, 5), 100), 'twenty fixes in twenty seconds at ±5 m is dense');
  check(!denseGps(fixes(14, 5), 100), 'fourteen is not');
  check(!denseGps(fixes(20, 20), 100), 'twenty at ±20 m is not');
  check(!denseGps(fixes(4, 20, 6), 100), "Firefox's one every six seconds is not");
  check(!denseGps(fixes(20, null), 100), 'fixes without an accuracy are not');
  const here = { latitude: 59.38, longitude: 13.5 };
  const east = m => 13.5 + m / (111320 * Math.cos(59.38 * Math.PI / 180));
  const at = (m, lat = 59.38) => ({ lat, lon: east(m) });
  const pick = nearby => realTarget(nearby, here).target?.kind ?? null;
  check(pick({ vatten: at(120), bro: at(200) }) === 'bro', 'a bridge 200 m away goes before water 120 m away');
  check(pick({ vatten: at(120), bro: at(400) }) === 'vatten', 'water, when the bridge is out of reach');
  check(pick({ bro: at(40) }) === null, 'nothing under 60 m: the walk would be over before it began');
  check(pick({ skog: { lat: null, lon: null } }) === null, 'a kind without a position is not a place to walk to');
  const told = realTarget({ skog: at(500), bro: at(90) }, here).seen.join(', ');
  check(/^skog \d{3} m, en bro \d{2} m$/.test(told), `and what the map found is told, near and far (${told})`);

  for (const [name, ids] of Object.entries(PROV_PROFILES)) {
    const profile = name === 'abort' ? PROFILES.abort : PROFILES[name];
    for (const prov of ids) {
      if (only && only !== prov) continue;
      const stations = PROV[prov].stations;
      const expect = PROV_EXPECT[name];
      const byRate = stations.some(id => { const w = expect(id); return !!w && typeof w === 'object'; });
      const runs = profile.abort ? stations.flatMap(id => profile.abort.map(after => ({ id, after })))
        : Array.from({ length: byRate ? RATE_RUNS : Math.min(RUNS, 4) }, () => null);
      const tally = {}, problems = [], lags = [], took = [];
      let firstLog = null;
      for (let run = 0; run < runs.length; run++) {
        const abortIn = runs[run];
        const r = await simulate(null, name, run, abortIn, { prov });
        if (!firstLog) firstLog = r.log;
        const where = abortIn ? `stop ${abortIn.after} s into ${abortIn.id}` : `run ${run}`;
        if (r.sound.playing || r.sound.intervals || r.sound.started || r.sound.raised) problems.push(`${where}: sound on after the end`);
        if (abortIn) continue;
        if (!r.ended) problems.push(`${where}: did not end`);
        took.push(r.t);
        const err = r.log.find(l => l.startsWith('ERROR'));
        if (err) problems.push(`${where}: ${err}`);
        for (const x of r.results) {
          if (x.detail.startsWith('fel:')) problems.push(`${where}: ${x.id} threw: ${x.detail}`);
          (tally[x.id] = tally[x.id] || []).push(x.outcome);
          const want = expect(x.id, prov);
          if (typeof want === 'string' && x.outcome !== want) problems.push(`${where}: ${x.id} ${x.outcome}, wanted ${want} (${x.detail})`);
          const ran = x.id === 'vaxla' && name === 'pass' && /löpning läst ([\d,]+) s \/ ([\d,]+) s/.exec(x.detail);
          if (ran && [ran[1], ran[2]].some(v => parseFloat(v.replace(',', '.')) < 1)) problems.push(`${where}: a run read before the walker started running (${x.detail})`);
          const lag = x.id === 'vagval' && /([\d,]+) s efter svängen i spåret/.exec(x.detail);
          if (lag) lags.push(parseFloat(lag[1].replace(',', '.')));
          if (process.env.DETAILS === x.id) console.log(`    ${where}: ${x.outcome}. ${x.detail}`);
        }
        const missing = stations.filter(id => !r.results.some(x => x.id === id));
        if (missing.length) problems.push(`${where}: never finished ${missing.join(', ')}`);
        const text = r.log.join('\n');
        if (name === 'pass') for (const re of PROV_SAYS[prov]) if (!re.test(text)) problems.push(`${where}: the log never says ${re}`);
        // The sensor's silence, said within seconds (3 s, plus the 2 s it
        // takes to count as silent, plus a tick).
        const said = id => r.log.filter(l => l.endsWith(`▶ ${id}`)).map(l => parseInt(l.slice(0, 2), 10) * 60 + parseInt(l.slice(3, 5), 10));
        const offs = r.log.filter(l => l.endsWith('~ sensor off')).map(l => parseInt(l.slice(0, 2), 10) * 60 + parseInt(l.slice(3, 5), 10));
        if (offs.length && !said('sensor-tyst').some(w => w >= offs[0] && w <= offs[0] + 7)) {
          problems.push(`${where}: the sensor went quiet at ${offs[0]} s and she did not say so within 7 s (${said('sensor-tyst').join(', ') || 'never'})`);
        }
        if (!offs.length && said('sensor-tyst').length) problems.push(`${where}: she said the sensor went quiet while it answered`);
        if (r.ended && !r.log.some(l => l.endsWith('▶ prov-slut'))) problems.push(`${where}: no end line`);
        if (r.log.some(l => /▶ (labb-|franvaro|nyckel|varld)/.test(l))) problems.push(`${where}: a lab's or the memory's line in a test walk`);
      }
      for (const id of stations) {
        const want = expect(id, prov);
        const outs = tally[id] || [];
        if (want && typeof want === 'object' && outs.length) {
          const got = outs.filter(o => o === want.want).length / outs.length;
          if (got < want.rate) problems.push(`${id}: ${want.want} in ${Math.round(got * 100)} % of runs, wanted ${Math.round(want.rate * 100)} %`);
        }
      }
      // Dense GPS is for reading a turn sooner: the slow reading took 42 s
      // after the corner on his Chrome walk of 2026-10-06, the fast one 9,9.
      // Here, half within thirteen seconds and none later than twenty, and
      // every turn's corner found in the track.
      if (name === 'pass-chrome') {
        const sorted = [...lags].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)], worst = sorted[sorted.length - 1];
        const read = (tally.vagval || []).filter(o => o === 'klarade').length;
        if (!lags.length || med > 13 || worst > 20) problems.push(`vagval read ${med} s after the corner (median), ${worst} s at worst`);
        if (lags.length < read) problems.push(`the corner was found in ${lags.length} of ${read} turns read`);
        console.log(`  vagval on dense GPS: read ${med} s after the corner (median), ${worst} s at worst, ${lags.length} turns`);
      }
      const summary = Object.entries(tally).map(([id, outs]) => `${id} ${Object.entries(outs.reduce((a, o) => ({ ...a, [o]: (a[o] || 0) + 1 }), {})).map(([o, n]) => `${o} ${n}/${outs.length}`).join(', ')}`).join('; ');
      const minutes = took.length ? `${(Math.max(...took) / 60).toFixed(1)} min at most` : '';
      console.log(`${problems.length ? 'FAIL' : 'ok  '}  prov ${prov} / ${name}: ${summary || `${runs.length} stops`} ${minutes}`);
      if (problems.length) { failed++; console.log(`  ${problems.slice(0, 8).join('\n  ')}`); }
      if (VERBOSE && firstLog) console.log(firstLog.join('\n'));
    }
  }
  return failed;
}

async function main() {
  if (process.argv[2] === 'prov') process.exit(await provChecks(process.argv[3]) ? 1 : 0);
  const onlyLab = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const onlyProfile = process.argv[3];
  let failures = onlyLab || onlyProfile ? 0 : await resumeChecks() + await provChecks();
  for (const labNo of [1, 2]) {
    if (onlyLab && onlyLab !== labNo) continue;
    for (const name of Object.keys(PROFILES)) {
      if (onlyProfile && onlyProfile !== name) continue;
      if (PROFILES[name].provOnly) continue;
      const profile = PROFILES[name];
      const tally = {};
      const problems = [];
      const firstDetail = {};
      const hits = {};
      const byRate = LABS[labNo].some(id => typeof EXPECT[name](id) === 'object');
      const runs = profile.abort ? LABS[labNo].flatMap(id => profile.abort.map(after => ({ id, after }))) : Array.from({ length: byRate ? Math.max(RUNS, RATE_RUNS) : RUNS }, () => null);
      for (let run = 0; run < runs.length; run++) {
        const abortIn = runs[run];
        const { log, results, ended, t, station, strays, sound } = await simulate(labNo, name, run, abortIn);
        if (VERBOSE && run === 0) console.log(`\n--- lab ${labNo} / ${name} / run ${run}\n${log.join('\n')}`);
        const where = abortIn ? `stop ${abortIn.after} s into ${abortIn.id}` : `run ${run}`;
        if (sound.playing || sound.intervals || sound.started || sound.raised) problems.push(`${where}: sound on after the end: ${sound.playing} playing, ${sound.intervals} loops, ${sound.started} started and ${sound.raised} turned up after stop`);
        if (!abortIn && sound.liveAtEnd) problems.push(`${where}: ${sound.liveAtEnd} sounds still live when the lab ended`);
        if (abortIn) {
          // A station shorter than the offset ends before the stop; the
          // others still press it inside, and one of them must.
          const hit = station === abortIn.id;
          if (hit) (hits[abortIn.id] = (hits[abortIn.id] || 0) + 1);
          if (VERBOSE) console.log(`  ${where}: ${hit ? `${sound.live} live at stop, ${sound.started} started after` : `station over first (ended in ${station})`}`);
          continue;
        }
        if (!ended) problems.push(`run ${run}: did not end by ${Math.round(t / 60)} min`);
        const err = log.find(l => l.startsWith('ERROR'));
        if (err) problems.push(`run ${run}: ${err}`);
        // She must say it when the sensor goes quiet and when it is back, and
        // never while it answers, nor on a phone that never had one: a false
        // alarm sends the walker digging for the phone for nothing.
        const said = line => log.some(l => l.endsWith(`▶ ${line}`));
        if (profile.sensorOff && profile.sensorOff[labNo]) {
          if (!said('sensor-tyst')) problems.push(`run ${run}: sensor went quiet and she never said so`);
          if (!said('sensor-tillbaka')) problems.push(`run ${run}: sensor came back and she never said so`);
        } else if (said('sensor-tyst')) {
          problems.push(`run ${run}: she said the sensor went quiet while it answered\n    ${log.filter(l => l.includes('sensor-')).join('\n    ')}`);
        }
        const stray = log.find(l => l.includes('dubbelknack utan'));
        if (stray && !/ 0 dubbelknack/.test(stray)) problems.push(`run ${run}: ${stray.trim()}\n    ${strays.join('\n    ')}`);
        for (const r of results) {
          if (r.detail.startsWith('fel:')) problems.push(`run ${run}: ${r.id} threw: ${r.detail}`);
          (tally[r.id] = tally[r.id] || []).push(r.outcome);
          if (!(r.id in firstDetail)) firstDetail[r.id] = r.detail;
          if (process.env.DETAILS === r.id) console.log(`    run ${run}: ${r.outcome}. ${r.detail}`);
          const want = EXPECT[name](r.id);
          if (typeof want === 'string' && r.outcome !== want) problems.push(`run ${run}: ${r.id} ${r.outcome}, wanted ${want} (${r.detail})`);
          // A skip must say why. 'No rhythm' for a sensor that was not running
          // is the misreading the first field lab made (2026-09-28).
          if (profile.sensorOff && r.outcome === 'hoppade' && !/sensorn tyst/.test(r.detail)) problems.push(`run ${run}: ${r.id} skipped without saying the sensor was quiet (${r.detail})`);
          // The hiss in Stämma linjen is the mechanic, and its outcome is
          // the stop test, so the evenness is checked from the detail.
          const even = r.id === 'linjen' && /jämn (\d+) %/.exec(r.detail);
          if (even && profile.steps && profile.kind === 'pass' && +even[1] < 80) problems.push(`run ${run}: even walker only ${even[1]} % even`);
          if (even && profile.steps && profile.kind === 'fail' && +even[1] > 40) problems.push(`run ${run}: uneven walker ${even[1]} % even`);
        }
        const missing = LABS[labNo].filter(id => !results.some(r => r.id === id));
        if (missing.length) problems.push(`run ${run}: stations never finished: ${missing.join(', ')}`);
        if (run === 0) console.log(`\n=== lab ${labNo} / ${name}: ${ended ? `ended at ${(t / 60).toFixed(1)} min` : 'DID NOT END'}`);
      }
      if (profile.abort) {
        const never = LABS[labNo].filter(id => !hits[id]);
        if (never.length) problems.push(`stop never pressed inside: ${never.join(', ')}`);
        const n = Object.values(hits).reduce((a, b) => a + b, 0);
        console.log(`\n=== lab ${labNo} / ${name}: stop pressed ${n} times inside ${LABS[labNo].length - never.length} stations`);
        console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'OK');
        if (problems.length) failures++;
        continue;
      }
      for (const id of LABS[labNo]) {
        const want = EXPECT[name](id);
        const outs = tally[id] || [];
        if (want && typeof want === 'object' && outs.length) {
          const got = outs.filter(o => o === want.want).length / outs.length;
          if (got < want.rate) problems.push(`${id}: ${want.want} in ${Math.round(got * 100)} % of runs, wanted at least ${Math.round(want.rate * 100)} %`);
        }
        const counts = outs.reduce((a, o) => ({ ...a, [o]: (a[o] || 0) + 1 }), {});
        const summary = Object.entries(counts).map(([o, n]) => `${o} ${n}/${outs.length}`).join(', ');
        console.log(`  ${id.padEnd(10)} ${summary.padEnd(28)} ${firstDetail[id] || ''}`);
      }
      if (problems.length) {
        failures++;
        console.log(`FAIL\n  ${problems.join('\n  ')}`);
      } else {
        console.log('OK');
      }
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
