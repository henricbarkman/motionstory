#!/usr/bin/env node
// Runs a Glimt chapter against the contact engine with a simulated walker
// and a fake clock. No audio, no DOM. Prints the scene log with timestamps
// and checks that every scene fired in order and, for the scenes with a
// fixed earliest moment, on time.
//
//   node scripts/test_glimt.mjs               # both chapters and episode 1, all profiles
//   node scripts/test_glimt.mjs 2             # chapter 2
//   node scripts/test_glimt.mjs 2 stubborn    # one profile
//   node scripts/test_glimt.mjs e1            # episode 1
//   node scripts/test_glimt.mjs e1 own        # one of its walkers
//
// Episode 1 has more to get wrong than scene order: which stop lights the
// lamp, which branch each walker hears, and that her half minute is a half
// minute. Its walkers react to what she says (see EPISODE_WALKERS).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter, simulatedMagnitude } from '../glimt/engine.js';
import { runChapter1 } from '../glimt/chapter1.js';
import { runChapter2 } from '../glimt/chapter2.js';
import { runEpisode1 } from '../glimt/episod1.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Line lengths in seconds. Chapter 1 was measured from the rendered files;
// chapter 2 is estimated from the text (tags stripped), which is close
// enough for scene ordering and clock fallbacks.
const LINE_SECONDS_1 = {
  s0: 16, s1a: 24, s1b: 24,
  's2a-stop-1': 4, 's2a-stop-2': 8, 's2a-resume': 5, 's2a-ask-1': 5, 's2a-ask-2': 10,
  's2b-stop-1': 7, 's2b-resume': 6, 's2b-ask-1': 5, 's2b-ask-2': 9,
  's3-1': 6, 's3-light': 5, 's3-dark': 5, 's3-2': 6, 's3-rain': 6, 's3-dry': 5,
  's4a-1': 9, 's4a-up': 8, 's4a-noup': 5, 's4b-1': 9, 's4b-up': 4, 's4b-noup': 6,
  s5: 16, 's6-vatten': 18, 's6-skog': 18, 's6-berg': 18, 's6-bro': 18, 's6-kyrkogard': 18,
  s7a: 20, s7b: 16, 's7-other': 3,
};

function estimatedSeconds(file) {
  const chapter = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const out = {};
  for (const [id, text] of Object.entries(chapter.lines)) {
    const plain = text.replace(/\[[a-z]+\]/g, '').replace(/\s+/g, ' ').trim();
    // Measured on the rendered chapter 2 files: about ten characters per second.
    out[id] = Math.round(1 + plain.length / 10);
  }
  return out;
}

// Chapter 2's questions: the walker answers yes by stopping shortly after
// the line ends. The last one is answered with the final stop.
const QUESTIONS_2 = new Set(['s1-1', 's1-no', 's2-light', 's2-dark', 's3-1',
  's6-vatten-q', 's6-skog-q', 's6-berg-q', 's6-bro-q', 's6-kyrkogard-q', 's6-nomap-q', 's9-1']);

// The phone in the second field test (2026-09-25): a fix every six seconds,
// its own speed reading 4-11 km/h walking and 1-3 km/h standing, positions
// that wander. GPS alone cannot find a stop in this; `steps: true` adds the
// accelerometer. GLIMT_NO_STEPS=1 turns the feet off to show that.
const FIELD_2 = {
  accuracy: 25, every: 6, jitter: 10, steps: true,
  phone: v => v ? v * (0.8 + Math.random() * 1.4) : 0.3 + Math.random() * 0.5,
};
const NO_STEPS = !!process.env.GLIMT_NO_STEPS;

// Walker profiles: speed (m/s) as a function of t, plus a heading so the
// distance to start is real. Each returns {speed, heading, accuracy?, every?,
// doppler?, jitter?, phone?, steps?}: `every` is seconds between fixes
// (default 1), `doppler: false` means the phone reports no speed of its own,
// `phone` maps the true speed to the one it reports, `jitter` is metres of
// position noise, `steps` feeds the accelerometer.
const PROFILES_1 = {
  // Walks, stops once at 2:00 for 15 s, speeds up at 5:10, turns back at 7:30.
  ideal: t => ({
    speed: t < 5 ? 0 : (t >= 120 && t < 135) ? 0 : t >= 310 && t < 400 ? 2.3 : 1.4,
    heading: t < 450 ? 0 : Math.PI,
  }),
  // Never stops, never speeds up, never turns. Every fallback must fire.
  stubborn: t => ({ speed: t < 5 ? 0 : 1.3, heading: 0 }),
  // Runs the whole way, stops briefly at 1:30, turns back at 6:00.
  runner: t => ({
    speed: t < 5 ? 0 : (t >= 90 && t < 102) ? 0 : t >= 330 ? 3.2 : 2.6,
    heading: t < 360 ? 0.3 : 0.3 + Math.PI,
  }),
  // Good walker, terrible GPS: accuracy 80 m the whole time.
  fog: t => ({ speed: t < 5 ? 0 : 1.4, heading: 0, accuracy: 80 }),
  // The ideal walk on a phone that reports every six seconds with no speed of
  // its own. The first field test (2026-09-25) read this as standing still.
  sparse: t => ({ ...PROFILES_1.ideal(t), accuracy: 30, every: 6, doppler: false }),
  // Same, every ten seconds, with the phone's own speed on each fix.
  'sparse-doppler': t => ({ ...PROFILES_1.ideal(t), accuracy: 30, every: 10 }),
  // The ideal walk on the phone from the second field test, with footsteps,
  // fiddling with the phone whenever standing.
  field: t => ({ ...PROFILES_1.ideal(t), ...FIELD_2, handling: true }),
  // Same, but from 2:30 the steps stop reaching the sensor while the walker
  // walks on. GPS must take over, or the chapter reads them as standing.
  'field-quiet': t => ({ ...PROFILES_1.ideal(t), ...FIELD_2, quietAfter: 150 }),
};

// Profiles that stop for ten seconds or more before 3:00, so scene 2 must see
// the walker stop on their own instead of asking.
const STOPS_1 = new Set(['ideal', 'runner', 'sparse', 'sparse-doppler', 'field', 'field-quiet']);

// Chapter 2 profiles carry `answers` (does the walker stop for a question),
// `map` (is the landmark's position known) and `runAt` (a tempo increase).
const PROFILES_2 = {
  // Answers everything, runs when asked, walks straight at the landmark.
  ideal: {
    answers: () => true, map: true,
    walk: (t, running) => ({ speed: t < 5 ? 0 : running ? 2.6 : 1.4, heading: t < 660 ? 0 : Math.PI }),
  },
  // Never stops, never speeds up. Every no-branch and every fallback fires.
  stubborn: {
    answers: () => false, map: true,
    walk: t => ({ speed: t < 5 ? 0 : 1.3, heading: 0 }),
  },
  // No map data: she asks the walker to choose, and the walker stops at 8:00.
  nomap: {
    answers: () => true, map: false,
    walk: (t, running) => ({ speed: t < 5 ? 0 : (t >= 480 && t < 492) ? 0 : running ? 2.4 : 1.4, heading: t < 660 ? 0 : Math.PI }),
  },
  // Answers yes, but the GPS is fog: contact is capped, clock fallbacks rule.
  fog: {
    answers: () => true, map: true,
    walk: (t, running) => ({ speed: t < 5 ? 0 : running ? 2.4 : 1.4, heading: 0, accuracy: 80 }),
  },
  // The ideal walker on the phone from the second field test, with footsteps.
  // Every yes is a short stop, so this is the profile the feet exist for.
  field: {
    answers: () => true, map: true,
    walk: (t, running) => ({ ...PROFILES_2.ideal.walk(t, running), ...FIELD_2, handling: true }),
  },
};

const CHAPTERS = {
  1: { run: runChapter1, seconds: LINE_SECONDS_1, profiles: PROFILES_1, variants: ['a', 'b'],
       order: ['scene 1', 'scene 2', 'scene 3', 'scene 4', 'scene 5', 'scene 6', 'scene 7', 'end'],
       targets: { 'scene 3': 210, 'scene 4': 285, 'scene 5': 405, 'scene 6': 495 }, window: 45 },
  2: { run: runChapter2, seconds: estimatedSeconds('stories/glimt/kapitel-2.json'), profiles: PROFILES_2, variants: ['a'],
       order: ['scene 1', 'scene 2', 'scene 3', 'scene 4', 'scene 5', 'scene 6', 'scene 7', 'scene 8', 'scene 9', 'end'],
       targets: { 'scene 2': 180, 'scene 3': 270, 'scene 4': 360 }, window: 60 },
};

function simulate(chapterNo, name, variant) {
  const ch = CHAPTERS[chapterNo];
  const profile = ch.profiles[name];
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let ended = false;
  let forcedStop = null;      // {from, to}: the walker answering a question
  let nextBump = 0;           // next handling bump, see `handling`
  let running = false;

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const world = { light: 'dark', rain: false, landmark: 'skog', landmarkCoord: null };
  if (chapterNo === 2 && profile.map) {
    // 700 m north of the start, straight ahead on heading 0.
    world.landmarkCoord = { lat: lat + 700 / 111320, lon };
    walk.setTarget({ latitude: world.landmarkCoord.lat, longitude: world.landmarkCoord.lon });
  }

  const ctx = {
    variant,
    world,
    state: () => walk.state(),
    log: msg => log.push(`${fmt(t)}  ${msg}  (contact ${walk.contact.value.toFixed(2)}, ${walk.tempo.band})`),
    hold: on => { walk.contact.hold = on; },
    play(id) {
      const dur = ch.seconds[id];
      if (dur === undefined) throw new Error(`unknown line ${id}`);
      log.push(`${fmt(t)}  ▶ ${id}`);
      return waiter.until(() => false, { timeout: dur }).then(() => {
        if (chapterNo !== 2) return;
        if (QUESTIONS_2.has(id) && profile.answers(id)) {
          forcedStop = id === 's9-1' ? { from: t + 2, to: Infinity } : { from: t + 2, to: t + 8 };
        }
        if (id === 's7-1' && profile.answers(id)) running = true;
        if (id === 's7-up' || id === 's7-noup') running = false;
      });
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => waiter.until(() => false, { timeout: s }).then(() => {}),
    playQuiet(id) { log.push(`${fmt(t)}  ▶ ${id} (quiet)`); return Promise.resolve(); },
  };

  const done = ch.run(ctx).then(() => { ended = true; }, err => { log.push(`ERROR ${err.message}`); ended = true; });

  // Drive the clock: one GPS fix per second, four ticks per second, and let
  // the microtask queue drain between ticks so awaits inside the chapter
  // script get to run.
  return (async () => {
    while (!ended && t < 20 * 60) {
      const p = chapterNo === 1 ? profile(t) : profile.walk(t, running);
      let { speed, heading, accuracy = 8, every = 1, doppler = true, jitter = 0, phone = null,
        steps = false, handling = false, quietAfter = null } = p;
      if (forcedStop && t >= forcedStop.from && t < forcedStop.to) speed = 0;
      // The accelerometer at 50 Hz over the quarter second up to this tick.
      // `handling`: while standing, the phone is bumped every 0.8-1.6 s.
      // `quietAfter`: from then on the steps barely reach the sensor.
      if (steps && !NO_STEPS) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          let m = simulatedMagnitude(u, speed);
          if (quietAfter !== null && u >= quietAfter) m = 9.81 + (m - 9.81) * 0.2;
          if (handling && speed === 0) {
            if (u >= nextBump + 0.15) nextBump = u + 0.8 + Math.random() * 0.8;
            if (u >= nextBump) m += 1.6;
          }
          walk.motion(u, m);
        }
      }
      // The walker moves every second; the phone reports every `every` s.
      if (Number.isInteger(t)) {
        const dLat = (speed * Math.cos(heading)) / 111320;
        const dLon = (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        lat += dLat; lon += dLon;
        if (t % every === 0) {
          const v = !doppler ? null : phone ? phone(speed) : speed + (speed ? (Math.random() - 0.5) * 0.2 : 0);
          const j = () => (Math.random() - 0.5) * 2 * jitter;
          walk.fix(t, {
            latitude: lat + j() / 111320,
            longitude: lon + j() / (111320 * Math.cos(lat * Math.PI / 180)),
            accuracy, speed: v,
          });
        }
      }
      const s = walk.tick(t);
      waiter.check(s);
      await Promise.resolve();
      await Promise.resolve();
      t = Math.round((t + 0.25) * 4) / 4;
    }
    await Promise.race([done, Promise.resolve()]);
    return { log, ended, t, walk };
  })();
}

// Manuscript target times (seconds) for the scenes that have a fixed earliest
// moment. With good GPS they must fire within a window after that moment,
// never before it. The fog profile is exempt: there the clock fallback rules.
function timingErrors(log, targets, window) {
  const errors = [];
  for (const [label, target] of Object.entries(targets)) {
    const line = log.find(l => l.includes(label) && !l.includes('▶'));
    if (!line) { errors.push(`${label} missing`); continue; }
    const [m, s] = line.trim().split(/\s+/)[0].split(':').map(Number);
    const t = m * 60 + s;
    if (t < target || t > target + window) errors.push(`${label} at ${line.trim().split(/\s+/)[0]}, wanted ${target}-${target + window} s`);
  }
  return errors;
}

// Chapter 2: a yes must be logged for every question the profile answered,
// and a no for every one it did not. Otherwise the answer mechanic could
// silently read every stop as walking on.
function answerErrors(log, profile) {
  const errors = [];
  const want = profile.answers() ? 'yes' : 'no';
  for (const scene of ['scene 1', 'scene 2', 'scene 3', 'scene 6']) {
    const lines = log.filter(l => l.includes(`${scene}: `));
    if (!lines.some(l => l.includes(`: ${want}`))) errors.push(`${scene} never answered ${want}`);
  }
  return errors;
}

// ---------- episode 1 ----------

const EPISODE = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episod-1.json'), 'utf8'));
const E_SECONDS = EPISODE.seconds || {};
const E_CUE = (EPISODE.cues && EPISODE.cues['s2-3'] && EPISODE.cues['s2-3'].trettio) || 0;
const E_CREDITS = (EPISODE.credits && EPISODE.credits.seconds) || 0;

// What a walker does when a line is heard: `[when, from, to]`, a stop from
// `from` to `to` seconds after the line's 'start' or 'end'. A list of them
// for more than one stop.
const ANSWER = ['end', 2, 12];
// s after her first plea that the hesitating walker walks again: the phone
// sees the move before her second plea, not yet as walking. GPS takes about
// two and a half seconds to see a walker move. Measured 20/10: the episode
// without its check (v35) fails from 7 to 8 s and passes at 6.75 and below;
// from 8 s the episode with the check fails too, so 7.25 sits in the middle.
const HESITATES = 7.25;

const END_STOP = { 's4-all': ['end', 3, Infinity] };
const out = (speed = 1.4, turn = 330) => t => ({ speed: t < 5 ? 0 : speed, heading: t < turn ? 0 : Math.PI });

// `has`: lines that must be heard. `not`: lines that must not. `twice`:
// lines said again after an interruption. `lamps`: how many times the lamp
// lights. `memory`: what episode 2 is told. `breath: false`: the walker goes
// on at the end, so no breath under the hum. `walksAt`: like `stops`, but
// `[when, after]` ends a stop that is going on, `after` seconds from the
// line's 'start' or 'end'. `skips`: log lines this walker never reaches.
const EPISODE_WALKERS = {
  // Never stops, not even at the end: every no-branch, and the end on the clock.
  never: {
    walk: out(), stops: {},
    has: ['s0-no1', 's0-no2', 's1-walk', 's1-q2-no', 's2-count', 's2-ask', 's2-no', 's3-dark', 's3-dry', 's3-near', 's3-skog',
      's4-ok', 's4-back', 's4-never-1', 's4-never-no', 's4-all'],
    not: ['s0-yes1-a', 's0-yes2', 's1-q2-yes', 's2-count-stop', 's2-lamp-1', 's2-lamp-2', 's4-lamp-2', 's4-ok-lamp',
      's4-onward', 's4-yes', 's4-never-yes-1', 'r-hjalp'],
    lamps: 0, breath: false, memory: { svarade: false, misstanke: false },
  },
  // Stops every time she asks, and at the end.
  asked: {
    walk: out(), stops: { 's0-ask1': ANSWER, 's0-yes1-b': ANSWER, 's1-q2': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes1-b', 's0-yes2', 's1-q2-yes', 's2-ask', 'x-avvikelse', 's2-lamp-plea', 's2-lamp-mine', 's2-lamp-1', 's4-ok-lamp', 's4-yes'],
    not: ['s0-no1', 's0-no2', 's1-q2-no', 's2-no', 's2-lamp-plea2', 's2-lamp-2', 's4-ok', 's4-lamp-2', 's4-never-1'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Sees her but walks on when she asks "hör du mig?", then stops when she
  // asks at the tree: she learns there that the walker hears her.
  deaf: {
    walk: out(), stops: { 's0-ask1': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes1-b', 's0-no2', 's2-lamp-mine', 's2-lamp-1', 's2-lamp-2', 's4-yes'],
    not: ['s0-no1', 's0-yes2', 's2-no', 's4-never-1'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Stops by themselves: among the trees in scene 2 and when she gets up in
  // scene 4. Never when she asks.
  own: {
    walk: out(), stops: { 's2-5': ['start', 1, 14], 's4-2': ['start', 2, 15], ...END_STOP },
    has: ['s0-no2', 's2-5', 's2-6', 's2-lamp-1', 's4-lamp-1', 's4-lamp-2', 's4-never-1', 's4-never-no'],
    not: ['s2-ask', 's2-no', 's2-lamp-mine', 's2-lamp-2', 's4-ok', 's4-3', 's4-yes'],
    lamps: 2, memory: { svarade: false, misstanke: true },
  },
  // Stops just as she steps off the gravel: the lamp cuts her first line
  // among the trees short, and she says it again afterwards.
  early: {
    walk: out(), stops: { 's2-4': ['start', 14, 32], ...END_STOP },
    has: ['s2-lamp-1', 's2-6'], not: ['s2-ask', 's2-lamp-2'], twice: ['s2-5'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Runs all the way, and never turns: the end is away from the start.
  runner: {
    walk: out(2.8, Infinity), stops: END_STOP,
    has: ['s1-run', 's4-ok', 's4-onward', 's4-never-no'],
    not: ['s1-walk', 's4-back'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Turns back at 5:30 and walks home slowly, too slowly to count as
  // approaching. She must not say they walk away from the start.
  'slow-home': {
    walk: t => ({ speed: t < 5 ? 0 : t < 330 ? 1.4 : 0.7, heading: t < 330 ? 0 : Math.PI }),
    stops: END_STOP,
    has: ['s4-ok', 's4-never-no'],
    not: ['s4-onward', 's4-back'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks on at every question, stops when she asks at the tree.
  late: {
    walk: out(), stops: { 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-no2', 's1-q2-no', 's2-lamp-mine', 's2-lamp-1', 's2-lamp-2', 's4-ok-lamp', 's4-yes'], not: ['s2-no', 's4-ok', 's4-never-1'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Only stops the last time she asks.
  last: {
    walk: out(), stops: { 's4-never-1': ANSWER, ...END_STOP },
    has: ['s0-no2', 's2-no', 's4-never-yes-1', 's4-never-yes-2'], not: ['s4-never-no', 's4-yes'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops where a stop costs nothing: when she asks if she is seen, while she
  // says she stands still in scene 2, while she sits, when she is back on the
  // gravel. No lamp, and nothing she says is cut short.
  harmless: {
    walk: out(), stops: { 's0-ask1': ANSWER, 's2-2': ['start', 1, 6], 's3-1': ['start', 1, 12], 's4-ok': ['start', 0, 9], ...END_STOP },
    has: ['s0-yes1-a', 's0-no2', 's2-count', 's2-no', 's4-ok', 's4-yes'], not: ['r-hjalp', 's2-count-stop'],
    lamps: 0, cuts: 0, memory: { svarade: true, misstanke: false },
  },
  // Stands still for forty-seven seconds while she sits under the tree: the
  // snäcka asks, she rests, and the line it cut is said again.
  rests: {
    walk: out(), stops: { 's3-1': ['start', 8, 55], ...END_STOP },
    has: ['r-hjalp', 'r-vilar'], twice: ['s3-skog'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands still through her count: she asks the walker to walk, the snäcka
  // does ask, and she starts over.
  stands: {
    walk: out(), stops: { 's2-1': ['end', 0, 45], ...END_STOP },
    has: ['r-hjalp', 'r-vilar', 's2-count-stop', 's2-count', 's2-4'], twice: ['s2-2'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stops for a few seconds while she counts under her breath: she tells the
  // walker to walk, and the last numbers still fall on the half minute.
  counted: {
    walk: out(), stops: { 's2-count': ['start', 4, 9], ...END_STOP },
    has: ['s2-count', 's2-count-stop', 's2-3', 's2-4'], not: ['r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same stop, long enough to pass the half minute: she says the last
  // numbers once the walker walks, late.
  'counted-long': {
    walk: out(), stops: { 's2-count': ['start', 4, 24], ...END_STOP },
    has: ['s2-count-stop', 's2-3', 's2-4'], not: ['r-hjalp'], lateCount: true,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stops among the trees by themselves and stays: she pleads twice, and is
  // back on the gravel in scene 4 knowing the lamp saw one of the three.
  stays: {
    walk: out(), stops: { 's2-5': ['start', 1, 40], ...END_STOP },
    has: ['x-avvikelse', 's2-lamp-plea', 's2-lamp-plea2', 's2-lamp-1', 's4-ok-lamp'], not: ['s2-ask', 's2-lamp-mine', 's4-ok'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Stands at a kerb from early in her first question and forty seconds on,
  // then walks: a stop that began before she asked is no answer, and while
  // she walks her round it is nothing to the snäcka either.
  kerb: {
    walk: out(), stops: { 's0-ask1': ['start', 5, 45], ...END_STOP },
    has: ['s0-no1', 's4-never-1'], not: ['s0-yes1-a', 'r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same kerb, a shorter wait, and then the stop she asked for.
  again: {
    walk: out(), stops: { 's0-ask1': [['start', 3, 15], ['start', 20, 30]], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops on the word and walks again a few seconds later, on the feet.
  quick: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['start', 16.4, 20.4], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops a second before her window closes, on GPS (twenty seconds after the
  // line). The phone knows it a few seconds later, after the window: it is
  // still her answer, for the stop began inside it.
  closing: {
    walk: out(), stops: { 's0-ask1': ['end', 19, 30], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // The same on the feet, whose window is ten seconds.
  'closing-feet': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 9.25, 20], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // And a stop that begins once the window has closed is no answer.
  'closed-feet': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 11, 20], ...END_STOP },
    has: ['s0-no1'], not: ['s0-yes1-a'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // A red light between scene 1 and 2: forty-two seconds still while she walks.
  light: {
    walk: out(), stops: { 's1-3': ['end', 2, 44], ...END_STOP },
    has: ['s2-no'], not: ['r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // A red light in the credits: the song goes dull, nothing else happens.
  song: {
    walk: out(), stops: { 's0-no2': ['end', 20, 50], ...END_STOP },
    has: ['s1-walk', 's2-no'], not: ['r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Home and standing once she is back on the gravel: the last time she
  // asks, a walker who already stood there has not answered.
  home: {
    walk: out(), stops: { 's4-ok': ['end', 0, Infinity] },
    has: ['s4-never-1', 's4-never-no'], not: ['s4-never-yes-1', 's4-yes'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks on when she asks at the tree, and stops a moment later, while she
  // is still out there.
  after: {
    walk: out(), stops: { 's2-no': ['end', 3, 15], ...END_STOP },
    has: ['s2-ask', 's2-no', 'x-avvikelse', 's2-lamp-1'], not: ['s2-lamp-mine', 's2-lamp-2', 's4-yes'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Stops a moment before she would ask at the tree. The stop shows as the
  // lamp before she has asked for anything, so it is not her answer.
  brink: {
    walk: out(), stops: { 's2-6': ['start', 4.5, 22], ...END_STOP },
    has: ['s2-6', 'x-avvikelse', 's2-lamp-1'], not: ['s2-ask', 's2-no', 's2-lamp-2', 's4-yes'],
    lamps: 1, cuts: 0, memory: { svarade: false, misstanke: false },
  },
  // A stop that shows in the moment between her line and her hand on the
  // trunk: after the lamp she still reaches out and touches it.
  pat: {
    walk: out(), stops: { 's2-5': ['start', 4.5, 25], ...END_STOP },
    has: ['s2-5', 's2-6', 'x-avvikelse', 's2-lamp-1'], not: ['s2-ask', 's2-lamp-2'],
    lamps: 1, cuts: 0, memory: { svarade: false, misstanke: false },
  },
  // Sits down on a bench for twelve minutes while she sits under the tree,
  // on the field phone: the feet say so, and the story waits. The snäcka
  // asks three times and then lets her be.
  sits: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's3-1': ['start', 8, 8 + 12 * 60], ...END_STOP },
    has: ['r-vilar', 's4-ok'], twice: ['s3-skog'], reserves: 3,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands so long that scene 4 stops waiting. Someone who stood there all
  // along has not stopped: no lamp, and no suspicion for episode 2.
  gone: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's3-1': ['start', 8, 8 + 21 * 60], ...END_STOP },
    has: ['s4-ok'], not: ['s4-lamp-2'], twice: ['s3-skog'], reserves: 3, logs: ['scene 4: the walker stands'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same long stand on GPS alone, which cannot be trusted on a stop:
  // scene 4 gives up after the short wait, and still lights no lamp.
  stalls: {
    walk: out(), stops: { 's3-1': ['start', 8, 8 + 12 * 60], ...END_STOP },
    has: ['r-vilar', 's4-ok'], not: ['s4-lamp-2'], twice: ['s3-skog'], logs: ['scene 4: the walker stands'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Waits at a kerb through her question and shifts their weight just after
  // it: the phone may see a new stop, but nobody walked, so it is no answer.
  shuffle: {
    seed: 3,
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's0-ask1': [['start', 3, 13.7], ['start', 15.1, 40]], ...END_STOP },
    has: ['s0-no1'], not: ['s0-yes1-a', 'r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Terrible GPS all the way (80 m), steps on: the contact is capped at half,
  // and scene 1 must still come straight after the credits.
  fog: {
    walk: t => ({ ...out()(t), accuracy: 80, steps: true }), stops: END_STOP,
    has: ['s1-walk', 's2-no'], afterCredits: 15,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The walker who stops when asked, on the field phone: a fix every six
  // seconds, a wandering speed, and the feet deciding moving or still.
  field: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's0-ask1': ANSWER, 's0-yes1-b': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes2', 'x-avvikelse', 's2-lamp-mine', 's2-lamp-1', 's4-yes'], not: ['s2-lamp-2', 's4-lamp-2'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Stops among the trees, hears her plead, and walks again a moment before
  // she would plead the second time: the phone already sees the walker move,
  // so she does not plead again (v35).
  hesitates: {
    walk: out(), stops: { 's2-5': ['start', 1, Infinity], ...END_STOP }, walksAt: { 's2-lamp-plea': ['end', HESITATES] },
    has: ['x-avvikelse', 's2-lamp-plea', 's2-lamp-1'], not: ['s2-ask', 's2-lamp-mine', 's2-lamp-plea2'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Walks on after her last line and stops only later, outside the window:
  // she fades out, with no breath under the hum.
  'late-end': {
    walk: out(), stops: { 's4-all': ['end', 25, Infinity] },
    has: ['s4-all'], breath: false,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks out along winding streets and never turns: only half of each step
  // points away from the start. She still says the walker goes away.
  winding: {
    walk: t => ({ speed: t < 5 ? 0 : 1.3, heading: (Math.floor(t / 20) % 2 ? 1 : -1) * Math.PI / 3 }), stops: END_STOP,
    has: ['s4-onward'], not: ['s4-back'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // A phone that never reads the walker move (no speed, no steps, every fix
  // too poor to use). What it hears is not the point: the count must not wait
  // for steps that never come, and the episode must end.
  // `loose`: only the order, the lines it must hear and that it ends are
  // checked. It takes over half an hour, all of it waiting: `limit`.
  blind: {
    walk: t => ({ ...out()(t), accuracy: 200, doppler: false }), stops: {},
    has: ['s2-count-stop', 's2-3', 's4-all'], skips: ['scene 2: she counts'], loose: true, limit: 60 * 60,
  },
};

// Every light, weather and landmark, each on a walker who never stops.
const EPISODE_WORLDS = [
  { light: 'dark', rain: true, landmark: 'bro' },
  { light: 'light', rain: false, landmark: 'vatten' },
  { light: 'light', rain: true, landmark: 'berg' },
  { light: 'dark', rain: false, landmark: 'kyrkogard' },
];
for (const w of EPISODE_WORLDS) {
  EPISODE_WALKERS[`world-${w.landmark}`] = {
    walk: out(), stops: END_STOP, world: w,
    has: [`s3-${w.light}`, w.rain ? 's3-rain' : 's3-dry', `s3-${w.landmark}`],
    lamps: 0, memory: { svarade: false, misstanke: false },
  };
}

// A small seeded generator (mulberry32). A walker with `seed` gets the same
// bumps and the same wandering GPS every run, so a case that hangs on them
// is a case and not a coin toss.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateEpisode(name) {
  const profile = EPISODE_WALKERS[name];
  const random = Math.random;
  if (profile.seed !== undefined) Math.random = seeded(profile.seed);
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  const played = [];          // {id, t, side}
  const sideCalls = [];       // {t, what, args}
  const stops = [];           // {from, to}
  let memory = null;
  let cuts = 0;
  const credited = [];        // when the credits started
  const truth = [];           // {t, d, acc}: where the walker really is, m from the start, and the fix's accuracy
  let current = null;
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let ended = false;
  let nextBump = 0;

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const react = (id, when) => {
    const r = profile.stops[id];
    for (const [at, from, to] of !r ? [] : Array.isArray(r[0]) ? r : [r]) {
      if (at === when) stops.push({ from: t + from, to: t + to });
    }
    const w = (profile.walksAt || {})[id];
    if (w && w[0] === when) for (const st of stops) if (st.from <= t + w[1] && st.to > t + w[1]) st.to = t + w[1];
  };
  const sound = (id, mark) => {
    const dur = E_SECONDS[id];
    if (dur === undefined) throw new Error(`unknown line ${id}`);
    log.push(`${fmt(t)}  ▶ ${id}${mark}`);
    played.push({ id, t, side: !!mark });
    react(id, 'start');
    const me = { cut: false };
    return { me, done: waiter.until(() => me.cut, { timeout: dur }).then(() => { react(id, 'end'); }) };
  };
  const call = what => (...args) => { sideCalls.push({ t, what, args }); };

  const ctx = {
    variant: 'a',
    world: { light: 'dark', rain: false, landmark: 'skog', landmarkCoord: null, ...(profile.world || {}) },
    state: () => walk.state(),
    log: msg => log.push(`${fmt(t)}  ${msg}  (contact ${walk.contact.value.toFixed(2)}, ${walk.tempo.band})`),
    hold: on => { walk.contact.hold = on; },
    play(id) {
      const { me, done } = sound(id, '');
      current = me;
      return done.then(() => { if (current === me) current = null; });
    },
    cut() { if (current) { current.cut = true; cuts++; log.push(`${fmt(t)}  cut`); } },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => waiter.until(() => false, { timeout: s }).then(() => {}),
    seconds: id => E_SECONDS[id] || 0,
    cue: (id, word) => ((EPISODE.cues || {})[id] || {})[word] || 0,
    remember: facts => { memory = { ...facts }; },
    credits() {
      log.push(`${fmt(t)}  ▶ förtexter`);
      credited.push(t);
      return waiter.until(() => false, { timeout: E_CREDITS }).then(() => {});
    },
    side: {
      walk: call('walk'), other: call('other'), hand: call('hand'), tone: call('tone'),
      bell: call('bell'), lift: call('lift'), pin: call('pin'), fade: call('fade'), breath: call('breath'),
      say: (id, kind) => sound(id, ` (her side, ${kind})`).done,
    },
  };

  const done = runEpisode1(ctx).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });

  // As simulate() above, but the microtask queue is drained to the bottom
  // between ticks: the episode's helpers are several awaits deep, and her
  // half minute is checked to the tick.
  return (async () => {
    while (!ended && t < (profile.limit || 40 * 60)) {
      let { speed, heading, accuracy = 8, every = 1, doppler = true, jitter = 0, phone = null,
        steps = false, handling = false } = profile.walk(t);
      if (stops.some(st => t >= st.from && t < st.to)) speed = 0;
      if (steps && !NO_STEPS) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          let m = simulatedMagnitude(u, speed);
          if (handling && speed === 0) {
            if (u >= nextBump + 0.15) nextBump = u + 0.8 + Math.random() * 0.8;
            if (u >= nextBump) m += 1.6;
          }
          walk.motion(u, m);
        }
      }
      if (Number.isInteger(t)) {
        lat += (speed * Math.cos(heading)) / 111320;
        lon += (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        truth.push({ t, acc: accuracy, d: Math.hypot((lat - 59.38) * 111320, (lon - 13.5) * 111320 * Math.cos(lat * Math.PI / 180)) });
        if (t % every === 0) {
          const v = !doppler ? null : phone ? phone(speed) : speed + (speed ? (Math.random() - 0.5) * 0.2 : 0);
          const j = () => (Math.random() - 0.5) * 2 * jitter;
          walk.fix(t, {
            latitude: lat + j() / 111320,
            longitude: lon + j() / (111320 * Math.cos(lat * Math.PI / 180)),
            accuracy, speed: v,
          });
        }
      }
      waiter.check(walk.tick(t));
      await new Promise(r => setImmediate(r));
      t = Math.round((t + 0.25) * 4) / 4;
    }
    await Promise.race([done, Promise.resolve()]);
    Math.random = random;
    return { log, ended, t, played, sideCalls, memory, cuts, credited, truth };
  })();
}

const E_ORDER = ['scene 0: does the walker see her', 'credits', 'scene 1', 'scene 2', 'scene 2: she stands still',
  'scene 2: she counts', 'scene 2: off the gravel', 'scene 3', 'scene 4', 'scene 4: the end', 'end'];
const logTime = line => { const [m, s] = line.trim().split(/\s+/)[0].split(':').map(Number); return m * 60 + s; };

function episodeProblems(name, run) {
  const p = EPISODE_WALKERS[name];
  const problems = [];
  const { log, played, sideCalls, memory } = run;
  const count = id => played.filter(x => x.id === id).length;
  const at = label => { const l = log.find(x => x.includes(label) && !x.includes('▶')); return l ? logTime(l) : null; };

  const order = E_ORDER.filter(x => !(p.skips || []).includes(x));
  let pos = 0;
  for (const line of log) if (pos < order.length && line.includes(order[pos]) && !line.includes('▶')) pos++;
  if (pos !== order.length) problems.push(`reached ${order[pos]} (${pos}/${order.length})`);
  if (log.some(l => l.includes('ERROR'))) problems.push('the script threw');

  for (const id of p.has || []) if (!count(id)) problems.push(`${id} never heard`);
  for (const id of p.not || []) if (count(id)) problems.push(`${id} heard`);
  if (p.loose) return problems;
  for (const id of p.twice || []) if (count(id) !== 2) problems.push(`${id} heard ${count(id)} times, wanted 2`);
  // Said once, unless the walker's profile says a line comes again.
  for (const id of new Set(played.map(x => x.id))) {
    const allowed = (p.twice || []).includes(id) ? 2 : id === 'x-avvikelse' ? p.lamps : id === 'r-hjalp' || id === 'r-vilar' ? 3 : 1;
    if (count(id) > allowed) problems.push(`${id} heard ${count(id)} times`);
  }
  if (count('x-avvikelse') !== p.lamps) problems.push(`the lamp lit ${count('x-avvikelse')} times, wanted ${p.lamps}`);
  if (p.reserves !== undefined && count('r-hjalp') !== p.reserves) problems.push(`the snäcka asked ${count('r-hjalp')} times, wanted ${p.reserves}`);
  for (const want of p.logs || []) if (!log.some(l => l.includes(want))) problems.push(`the log never says "${want}"`);
  if (p.cuts !== undefined && run.cuts !== p.cuts) problems.push(`${run.cuts} lines cut short, wanted ${p.cuts}`);

  // The lamp only between her stepping off the gravel and scene 3, and in
  // scene 4 before she is back on the gravel. Whatever the profile expects,
  // a lamp anywhere else is wrong.
  const off = at('scene 2: off the gravel'), s3 = at('scene 3'), s4 = at('scene 4'), s4end = at('scene 4: the end');
  for (const x of played.filter(x => x.id === 'x-avvikelse')) {
    const ok = (off !== null && x.t >= off && (s3 === null || x.t <= s3)) || (s4 !== null && x.t >= s4 && (s4end === null || x.t <= s4end));
    if (!ok) problems.push(`the lamp lit at ${fmt2(x.t)}, where a stop is harmless`);
  }

  // The end comes soon after she is back on the gravel, also for a walker far
  // from the start: never a minute of hum after a line that sounds like an end.
  const back = played.filter(x => ['s4-ok', 's4-ok-lamp', 's4-lamp-2'].includes(x.id)).pop();
  if (back && s4end !== null && s4end - (back.t + E_SECONDS[back.id]) > 26) {
    problems.push(`the end came ${Math.round(s4end - back.t - E_SECONDS[back.id])} s after ${back.id}, wanted at most 25`);
  }
  // And sooner for a walker nearly back. Read from where the simulated walker
  // really is 15 s after that line, not from what the phone made of it: under
  // 250 m from the start and more than 60 m closer than 45 s before, on a
  // phone whose fixes are good enough to be read at all (50 m, as Walk.fix).
  if (back && s4end !== null) {
    const backEnd = back.t + E_SECONDS[back.id];
    const dist = when => { let d = null; for (const p of run.truth) { if (p.t <= when) d = p.d; } return d; };
    const near = dist(backEnd + 15), before = dist(backEnd - 30);
    const readable = run.truth.filter(p => p.t >= backEnd - 30 && p.t <= backEnd + 15).every(p => p.acc <= 50);
    if (readable && near !== null && before !== null && near < 250 && before - near > 60) {
      run.nearlyBack = true;
      if (s4end - backEnd > 17) problems.push(`nearly back (${Math.round(near)} m) and the end came ${Math.round(s4end - backEnd)} s after ${back.id}, wanted about 15`);
    }
  }

  // The credits once, after scene 0's last line and before scene 1, and
  // nothing of hers while the song plays.
  const scene1 = at('scene 1');
  if (run.credited.length !== 1) problems.push(`the credits played ${run.credited.length} times`);
  else {
    const c = run.credited[0];
    // The log is read back in whole seconds, so a second's grace.
    if (scene1 !== null && scene1 < c + E_CREDITS - 1) problems.push(`scene 1 began at ${fmt2(scene1)}, inside the credits`);
    const over = played.find(x => x.t > c && x.t < c + E_CREDITS);
    if (over) problems.push(`${over.id} plays over the credits`);
    if (p.afterCredits !== undefined && scene1 !== null && scene1 - (c + E_CREDITS) > p.afterCredits) {
      problems.push(`scene 1 came ${fmt2(scene1 - c - E_CREDITS)} after the credits`);
    }
    const s0last = played.filter(x => x.id.startsWith('s0-')).pop();
    if (!s0last || s0last.t > c) problems.push('the credits came before scene 0 was over');
  }

  // From her last step to "trettio": half a minute, on the last count she made.
  const stood = log.filter(l => l.includes('she stands still')).map(logTime).pop();
  const counting = played.filter(x => x.id === 's2-3').pop();
  if (stood === undefined || !counting) problems.push('she never counted');
  else {
    const half = counting.t + E_CUE - stood;
    // A walker who stood through the half minute hears it once they walk.
    if (p.lateCount ? half < 29 : Math.abs(half - 30) > 1) problems.push(`"trettio" came ${half.toFixed(1)} s after she stopped, wanted 30`);
  }

  // Her side. The tone never left on, and after the lamp at the tree she
  // does not take another step until scene 4: that is what makes a second
  // stop harmless there.
  let tone = false;
  for (const c of sideCalls) if (c.what === 'tone') tone = !!c.args[0];
  if (tone) problems.push('the lamp tone was left on');
  // The lamp's tone is the first one on her side; calls are read in their
  // order, since her step off the gravel can fall in the lamp's own second.
  const lamp2 = at('scene 2: lamp');
  if (lamp2 !== null && s4 !== null) {
    const tone2 = sideCalls.findIndex(c => c.what === 'tone' && c.args[0]);
    const step = sideCalls.slice(tone2 + 1).find(c => c.what === 'walk' && c.args[0] && c.t < s4);
    if (step) problems.push(`she walks (${step.args[0]}) at ${fmt2(step.t)}, after the lamp and before scene 4`);
  }
  // The shift's steps are taken away before the end, and the breath comes once.
  const others = sideCalls.filter(c => c.what === 'other');
  if (others.length && others[others.length - 1].args[0] !== null) problems.push('the other steps are left walking');
  // The breath under the hum is for a walker who stops at the end; one who
  // goes on hears her fade out. The profile says which, not the log.
  const wantBreath = p.breath === false ? 0 : 1;
  const breaths = sideCalls.filter(c => c.what === 'breath').length;
  if (breaths !== wantBreath) problems.push(`the breath at the end ${breaths} times, wanted ${wantBreath}`);
  const endsStanding = log.some(l => /^\s*\d+:\d\d {2}end {2}\(/.test(l));
  const endsGoingOn = log.some(l => l.includes('end: the walker goes on'));
  if (wantBreath ? !endsStanding : !endsGoingOn) problems.push(`the end is logged as ${endsStanding ? 'standing' : endsGoingOn ? 'going on' : 'neither'}, wanted ${wantBreath ? 'standing' : 'going on'}`);
  const stoodCall = sideCalls.find(c => c.what === 'walk' && c.args[0] === null);
  if (!stoodCall) problems.push('her steps never stop');
  if (!sideCalls.some(c => c.what === 'bell')) problems.push('no bell');
  if (sideCalls.filter(c => c.what === 'hand').length !== 1) problems.push(`her hand on the tree ${sideCalls.filter(c => c.what === 'hand').length} times`);

  if (!memory) problems.push('nothing remembered for episode 2');
  else {
    for (const [k, v] of Object.entries(p.memory)) if (memory[k] !== v) problems.push(`memory ${k} is ${memory[k]}, wanted ${v}`);
    if (!memory.klar) problems.push('memory not marked as walked to the end');
  }
  return problems;
}
const fmt2 = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Every line in the episode file is heard by some walker, has a length the
// script can count on, and has its file on disk.
function coverageProblems(heard) {
  const problems = [];
  for (const id of Object.keys(EPISODE.lines)) {
    if (!heard.has(id)) problems.push(`${id} is in the episode file and no walker hears it`);
    if (!(E_SECONDS[id] > 0)) problems.push(`${id} has no measured length (run scripts/check_glimt_audio.py)`);
    if (!existsSync(join(ROOT, 'audio/glimt/vega', EPISODE.id, `${id}.mp3`))) problems.push(`${id}.mp3 is not rendered`);
  }
  for (const [name, sfx] of Object.entries(EPISODE.sfx || {})) {
    if (!existsSync(join(ROOT, 'audio/glimt/side', sfx.file))) problems.push(`her side: ${sfx.file} is missing`);
    if (sfx.steps && !(sfx.slices && sfx.slices.length >= 4)) problems.push(`her side: ${name} is not cut into steps`);
  }
  if (!(E_CUE > 0)) problems.push('no measured cue for "trettio" in s2-3');
  for (const id of ['s0-ask1', 's0-yes1-b', 's0-no1']) {
    if (!(((EPISODE.cues || {})[id] || {})['last:nu'] > 0)) problems.push(`no measured cue for the last "nu" in ${id}`);
  }
  if (!(E_CREDITS > 60)) problems.push('the credits have no length');
  // The song itself is only in the private copy, which puts it under this name.
  if (!EPISODE.credits.file) problems.push('the credits have no file name for the private copy');
  // Nor are the licensed sounds in this repo: not the bed, the riser or a song.
  for (const dir of ['bed', 'fx', 'music']) {
    if (existsSync(join(ROOT, 'audio/glimt', dir))) problems.push(`audio/glimt/${dir} is in the public tree`);
  }
  problems.push(...soundProblems());
  return problems;
}

// Every sound file in the repo is one the repo can account for: a line some
// story file names, a sound of her side an episode names, or one of the old
// voice samples. Anything else (a song, a master, a mix with the bed) fails by
// name, wherever it lies (code review 19/10, Lägre 7: the folder check only
// knew three folders).
const SOUND = /\.(mp3|opus|ogg|oga|wav|flac|m4a|m4b|mp4|aac|aif|aiff|aifc|caf|wma|mka|mkv|weba|webm|3gp|amr)$/i;
const FROZEN = new Set([
  ...[1, 2, 3, 4].map(n => `audio/pilgrimsvagen/scene-${n}.mp3`),
  ...['demi2', 'elin', 'elin-assured', 'karin', 'maria', 'stil-1-torr', 'stil-2-nara', 'stil-3-magisk'].map(n => `rostprov/${n}.mp3`),
]);
// What the repo holds, which is what reaches GitHub and Pages. Untracked files
// are left out on purpose: a sound someone is working on in the shared tree
// would turn the suite red for everyone until it is named or moved, and the
// suite runs in a clean worktree before every merge anyway.
function repoFiles() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    // Not a checkout (an archive copy): then every file here is the repo's.
    const out = [];
    const walk = (rel) => {
      for (const d of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(r); else out.push(r);
      }
    };
    walk('');
    return out;
  }
}
function soundProblems() {
  const known = new Set(FROZEN);
  for (const f of readdirSync(join(ROOT, 'stories/glimt')).filter(f => f.endsWith('.json'))) {
    const story = JSON.parse(readFileSync(join(ROOT, 'stories/glimt', f), 'utf8'));
    for (const id of Object.keys(story.lines || {})) known.add(`audio/glimt/vega/${story.id}/${id}.mp3`);
    for (const sfx of Object.values(story.sfx || {})) known.add(`audio/glimt/side/${sfx.file}`);
  }
  const files = repoFiles().filter(f => SOUND.test(f));
  const strays = files.filter(f => !known.has(f)).map(f => `${f} is a sound no story file names`);
  return files.length ? strays : ['found no sound files at all, so the check read nothing'];
}

async function episodeMain(onlyProfile) {
  let failures = 0;
  const heard = new Set();
  let nearlyBack = 0;
  for (const name of Object.keys(EPISODE_WALKERS)) {
    if (onlyProfile && onlyProfile !== name) continue;
    const run = await simulateEpisode(name);
    run.played.forEach(x => heard.add(x.id));
    console.log(`\n=== episode 1 / ${name} — ${run.ended ? 'ended at ' + Math.round(run.t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
    console.log(run.log.join('\n'));
    const problems = episodeProblems(name, run);
    if (run.nearlyBack) nearlyBack++;
    if (!run.ended) problems.unshift('did not end');
    if (problems.length) failures++;
    console.log(problems.length ? `FAIL: ${problems.join('; ')}` : 'OK: the right branches, the lamp only where it should, half a minute');
  }
  if (!onlyProfile) {
    const problems = coverageProblems(heard);
    if (!nearlyBack) problems.push('no walker was nearly back at the end, so the sooner end is untested');
    if (problems.length) failures++;
    console.log(`\n=== episode 1 / every line`);
    console.log(problems.length ? `FAIL: ${problems.join('; ')}` : `OK: all ${Object.keys(EPISODE.lines).length} lines heard by some walker, measured and rendered`);
  }
  return failures;
}

async function main() {
  const episodeOnly = process.argv[2] === 'e1';
  const onlyChapter = process.argv[2] && !episodeOnly ? parseInt(process.argv[2], 10) : null;
  const onlyProfile = process.argv[3];
  let failures = 0;
  for (const [no, ch] of Object.entries(CHAPTERS)) {
    if (episodeOnly) break;
    if (onlyChapter && onlyChapter !== Number(no)) continue;
    for (const name of Object.keys(ch.profiles)) {
      if (onlyProfile && onlyProfile !== name) continue;
      for (const variant of ch.variants) {
        const { log, ended, t } = await simulate(Number(no), name, variant);
        console.log(`\n=== chapter ${no} / ${name} / variant ${variant.toUpperCase()} — ${ended ? 'ended at ' + Math.round(t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
        console.log(log.join('\n'));
        let pos = 0;
        for (const line of log) {
          if (pos < ch.order.length && line.includes(ch.order[pos])) pos++;
        }
        const problems = name === 'fog' ? [] : timingErrors(log, ch.targets, ch.window);
        if (Number(no) === 2) problems.push(...answerErrors(log, ch.profiles[name]));
        if (Number(no) === 1 && STOPS_1.has(name) && !log.some(l => l.includes('scene 2: walker stopped'))) {
          problems.push('scene 2 never saw the walker stop');
        }
        const ok = ended && pos === ch.order.length && !log.some(l => l.startsWith('ERROR')) && problems.length === 0;
        if (!ok) failures++;
        console.log(ok ? 'OK: all scenes in order and on time'
          : `FAIL: reached ${pos}/${ch.order.length}${problems.length ? '; ' + problems.join('; ') : ''}`);
      }
    }
  }
  if (!onlyChapter) failures += await episodeMain(episodeOnly ? onlyProfile : null);
  process.exit(failures ? 1 : 0);
}

main();
