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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter, cadencePace, bearing } from '../glimt/engine.js';
import { runLab, labHelpers, LABS, ratedThisRound } from '../glimt/lab.js';
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
    matchBeat: false, knocks: [], events: [],
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
    if (off && id === off.from) w.sensorOff = true;
    if (off && id === off.until && w.sensorOff) at(t + (off.after || 0), () => { w.sensorOff = false; });
    if (id.startsWith('hitta-intro') || id === 'kompass-intro') w.steer = pass ? 1 : -1;
    if (['hitta-framme', 'hitta-tid', 'kompass-framme', 'kompass-tid'].includes(id)) w.steer = 0;
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
      case 'vagval-intro': at(t + 12, () => { w.heading += Math.PI / 2; }); break;
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

  // Knock back as many times as the phone buzzed.
  w.onVibrate = (pattern, t) => {
    if (!pass) return;
    const len = pattern.reduce((a, b) => a + b, 0) / 1000;
    for (let i = 0; i < pattern.length / 2; i++) knock(t + len + 1.0 + i * 0.45);
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

function simulate(labNo, name, run, abortIn = null, { stations = null } = {}) {
  reseed(labNo, name, run, abortIn ? `${abortIn.id}@${abortIn.after}` : '', stations ? stations.join(',') : '');
  const profile = PROFILES[name];
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  const results = [];
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let ended = false;
  let target = null, nextBump = 0, phase = 0, stepNo = -1, stepHard = 1;
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // Every other run has a landmark 250 m east, so Hitta tries both kinds.
  const world = { light: 'dark', rain: false, landmark: 'skog', landmarkCoord: null };
  if (run % 2 === 1) {
    world.landmark = 'vatten';
    world.landmarkCoord = { lat, lon: lon + 250 / (111320 * Math.cos(lat * Math.PI / 180)) };
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
  const walker = makeWalker(profile.kind, { bpm, target: () => target, sensorOff: profile.sensorOff && profile.sensorOff[labNo] });
  let station = null, stationAt = 0, aborted = null;
  let pressedAt = null, startedBefore = 0, liveAtPress = 0;
  const trace = [];
  // The drifting bias, north and east in metres, started from its spread.
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const drift = profile.gps.drift;
  let biasN = drift ? drift.sigma * gauss() : 0, biasE = drift ? drift.sigma * gauss() : 0;

  let voiceChain = Promise.resolve();
  const helpers = labHelpers(walk, {
    now: () => t,
    vibrateImpl: p => { walker.onVibrate(p, t); return true; },
  });
  const ctx = {
    world, sfx, memo: {},
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

  const done = runLab(ctx, labNo, { stations }).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });

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
    return { log, results, ended, t, station, strays, sound: { ...after, liveAtEnd } };
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

  const rest = LABS[2].filter(id => !['normalt', 'vandom'].includes(id));
  const { log, results, ended } = await simulate(2, 'pass', 0, null, { stations: rest });
  check(ended, 'the resumed lab ends');
  check(same(results.map(x => x.id), rest), `it walks the five left, in order (${results.map(x => x.id).join(', ')})`);
  const first = log.find(l => l.includes('== '));
  check(/== vagval 3\/7$/.test(first || ''), `numbered as in the whole lab (${first && first.trim()})`);
  check(results.every(x => x.outcome === 'klarade'), `and a walker who does as asked clears them (${results.map(x => x.outcome).join(', ')})`);
  return failed;
}

async function main() {
  const onlyLab = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const onlyProfile = process.argv[3];
  let failures = onlyLab || onlyProfile ? 0 : await resumeChecks();
  for (const labNo of [1, 2]) {
    if (onlyLab && onlyLab !== labNo) continue;
    for (const name of Object.keys(PROFILES)) {
      if (onlyProfile && onlyProfile !== name) continue;
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
