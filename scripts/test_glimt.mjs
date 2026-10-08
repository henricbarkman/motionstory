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

import { readFileSync, existsSync } from 'node:fs';
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
const E_CUE = (EPISODE.cues && EPISODE.cues['s3-3'] && EPISODE.cues['s3-3'].trettio) || 0;

// What a walker does when a line is heard: `[when, from, to]`, a stop from
// `from` to `to` seconds after the line's 'start' or 'end'. A list of them
// for more than one stop.
const ANSWER = ['end', 2, 12];
const END_STOP = { 's6-all': ['end', 3, Infinity] };
const out = (speed = 1.4, turn = 330) => t => ({ speed: t < 5 ? 0 : speed, heading: t < turn ? 0 : Math.PI });

// `has`: lines that must be heard. `not`: lines that must not. `twice`:
// lines said again after an interruption. `lamps`: how many times the lamp
// lights. `memory`: what episode 2 is told.
const EPISODE_WALKERS = {
  // Never stops, not even at the end: every no-branch, and the end on the clock.
  never: {
    walk: out(), stops: {},
    has: ['s1-walk', 's2-no', 's3-ask', 's3-no', 's4-dark', 's4-dry', 's4-skog', 's5-hon-walk', 's5-ok-walk',
      's6-back', 's6-never-1', 's6-never-no', 's6-all', 's6-other'],
    not: ['s2-yes-1', 's3-lamp-1', 's3-lamp-2', 's5-lamp-sten', 's6-yes', 's6-never-yes-1', 'r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stops every time she asks, and at the end.
  asked: {
    walk: out(), stops: { 's2-1': ANSWER, 's3-ask': ANSWER, ...END_STOP },
    has: ['s2-yes-1', 's2-yes-2', 's3-ask', 'x-avvikelse', 's3-lamp-plea', 's3-lamp-1', 's5-hon-walk', 's6-yes'],
    not: ['s2-no', 's3-no', 's3-lamp-2', 's5-lamp-sten', 's6-never-1'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Stops by themselves: among the trees in scene 3 and when the other woman
  // comes in scene 5. Never when she asks.
  own: {
    walk: out(), stops: { 's3-5': ['start', 1, 14], 's5-1': ['start', 14, 28], ...END_STOP },
    has: ['s2-no', 's3-5', 's3-6', 's3-lamp-1', 's5-hon-fraga', 's5-lamp-sten', 's5-lamp-after', 's6-never-1', 's6-never-no'],
    not: ['s3-ask', 's3-no', 's3-lamp-2', 's5-hon-walk', 's5-ok-walk', 's5-2', 's6-yes'],
    lamps: 2, memory: { svarade: false, misstanke: true },
  },
  // Stops just as she steps off the gravel: the lamp cuts her first line
  // among the trees short, and she says it again afterwards.
  early: {
    walk: out(), stops: { 's3-4': ['start', 14, 32], ...END_STOP },
    has: ['s3-lamp-1', 's3-6'], not: ['s3-ask', 's3-lamp-2'], twice: ['s3-5'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Runs all the way.
  runner: {
    walk: out(2.8, 300), stops: END_STOP,
    has: ['s1-run', 's5-hon-run', 's5-ok-run', 's6-never-no'],
    not: ['s1-walk', 's5-hon-walk', 's5-ok-walk'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks on in scene 2, stops when she asks at the tree.
  late: {
    walk: out(), stops: { 's3-ask': ANSWER, ...END_STOP },
    has: ['s2-no', 's3-lamp-1', 's3-lamp-2', 's6-yes'], not: ['s3-no', 's6-never-1'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Only stops the last time she asks.
  sixth: {
    walk: out(), stops: { 's6-never-1': ANSWER, ...END_STOP },
    has: ['s2-no', 's3-no', 's6-never-yes-1', 's6-never-yes-2'], not: ['s6-never-no', 's6-yes'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops where a stop costs nothing: when she asks in scene 2, while she
  // counts, while she sits, after the other woman has passed. No lamp, and
  // nothing she says is cut short.
  harmless: {
    walk: out(), stops: { 's2-1': ANSWER, 's3-2': ['start', 1, 10], 's4-1': ['start', 1, 12], 's5-ok-walk': ['start', 0, 9], ...END_STOP },
    has: ['s2-yes-1', 's3-no', 's5-hon-walk', 's6-yes'], not: ['r-hjalp'],
    lamps: 0, cuts: 0, memory: { svarade: true, misstanke: false },
  },
  // Stands still for forty seconds while she sits under the tree: the
  // snäcka asks, she rests, and the line it cut is said again.
  rests: {
    walk: out(), stops: { 's4-1': ['start', 8, 55], ...END_STOP },
    has: ['r-hjalp', 'r-vilar'], twice: ['s4-skog'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands still through her count: the snäcka does ask, and she counts again.
  stands: {
    walk: out(), stops: { 's3-1': ['end', 0, 45], ...END_STOP },
    has: ['r-hjalp', 'r-vilar', 's3-4'], twice: ['s3-2', 's3-3'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands at a kerb from early in her question and forty seconds on, then
  // walks: a stop that began before she asked is no answer, and while she
  // walks her round it is nothing to the snäcka either.
  kerb: {
    walk: out(), stops: { 's2-1': ['start', 5, 45], ...END_STOP },
    has: ['s2-no', 's6-never-1'], not: ['s2-yes-1', 'r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same kerb, a shorter wait, and then the stop she asked for.
  again: {
    walk: out(), stops: { 's2-1': [['start', 5, 26], ['start', 34, 44]], ...END_STOP },
    has: ['s2-yes-1', 's2-yes-2', 's6-yes'], not: ['s2-no'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops on the word and walks again before she has finished the line.
  quick: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's2-1': ['start', 17.5, 21.5], ...END_STOP },
    has: ['s2-yes-1', 's2-yes-2', 's6-yes'], not: ['s2-no'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // A red light between scene 2 and 3: forty seconds still while she walks.
  light: {
    walk: out(), stops: { 's2-no': ['end', 2, 44], ...END_STOP },
    has: ['s3-no'], not: ['r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Home and standing from the bell on: the last time she asks, a walker
  // who already stood there has not answered.
  home: {
    walk: out(), stops: { 's6-1': ['start', 0, Infinity] },
    has: ['s6-never-1', 's6-never-no', 's6-other'], not: ['s6-never-yes-1', 's6-yes'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks on when she asks at the tree, and stops a moment later, while she
  // is still out there.
  after: {
    walk: out(), stops: { 's3-no': ['end', 3, 15], ...END_STOP },
    has: ['s3-ask', 's3-no', 'x-avvikelse', 's3-lamp-1'], not: ['s3-lamp-2', 's6-yes'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Stops a moment before she would ask at the tree. The stop shows as the
  // lamp before she has asked for anything, so it is not her answer.
  brink: {
    walk: out(), stops: { 's3-6': ['start', 4.5, 22], ...END_STOP },
    has: ['s3-6', 'x-avvikelse', 's3-lamp-1'], not: ['s3-ask', 's3-no', 's3-lamp-2', 's6-yes'],
    lamps: 1, cuts: 0, memory: { svarade: false, misstanke: false },
  },
  // A stop that shows in the moment between her line and her hand on the
  // trunk: after the lamp she still reaches out and touches it.
  pat: {
    walk: out(), stops: { 's3-5': ['start', 4.5, 25], ...END_STOP },
    has: ['s3-5', 's3-6', 'x-avvikelse', 's3-lamp-1'], not: ['s3-ask', 's3-lamp-2'],
    lamps: 1, cuts: 0, memory: { svarade: false, misstanke: false },
  },
  // Sits down on a bench for twelve minutes while she sits under the tree,
  // on the field phone: the feet say so, and the story waits. The snäcka
  // asks three times and then lets her be.
  sits: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's4-1': ['start', 8, 8 + 12 * 60], ...END_STOP },
    has: ['r-vilar', 's5-hon-walk'], twice: ['s4-skog'], reserves: 3,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands so long that scene 5 stops waiting. Someone who stood there all
  // along has not stopped: no lamp, and no suspicion for episode 2.
  gone: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's4-1': ['start', 8, 8 + 21 * 60], ...END_STOP },
    has: ['s5-hon-walk'], not: ['s5-lamp-sten'], twice: ['s4-skog'], reserves: 3, logs: ['scene 5: the walker stands'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same long stand on GPS alone, which cannot be trusted on a stop:
  // scene 5 gives up after the short wait, and still lights no lamp.
  stalls: {
    walk: out(), stops: { 's4-1': ['start', 8, 8 + 12 * 60], ...END_STOP },
    has: ['r-vilar', 's5-hon-walk'], not: ['s5-lamp-sten'], twice: ['s4-skog'], logs: ['scene 5: the walker stands'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Waits at a kerb through her question and shifts their weight just after
  // it: the phone sees a new stop, but nobody walked, so it is no answer.
  // Whether the phone sees it hangs on the bumps, hence the seed: with this
  // one the stop was taken as her answer before `ask` asked for steps first.
  shuffle: {
    seed: 3,
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's2-1': [['start', 5, 24], ['start', 25.4, 50]], ...END_STOP },
    has: ['s2-no'], not: ['s2-yes-1', 'r-hjalp'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The walker who stops when asked, on the field phone: a fix every six
  // seconds, a wandering speed, and the feet deciding moving or still.
  field: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's2-1': ANSWER, 's3-ask': ANSWER, ...END_STOP },
    has: ['s2-yes-1', 'x-avvikelse', 's3-lamp-1', 's6-yes'], not: ['s3-lamp-2', 's5-lamp-sten'],
    lamps: 1, memory: { svarade: true, misstanke: false },
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
    has: [`s4-${w.light}`, w.rain ? 's4-rain' : 's4-dry', `s4-${w.landmark}`],
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
    side: {
      walk: call('walk'), other: call('other'), hand: call('hand'), tone: call('tone'),
      bell: call('bell'), lift: call('lift'), pin: call('pin'), fade: call('fade'),
      say: (id, kind) => sound(id, ` (her side, ${kind})`).done,
    },
  };

  const done = runEpisode1(ctx).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });

  // As simulate() above, but the microtask queue is drained to the bottom
  // between ticks: the episode's helpers are several awaits deep, and her
  // half minute is checked to the tick.
  return (async () => {
    while (!ended && t < 40 * 60) {
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
    return { log, ended, t, played, sideCalls, memory, cuts };
  })();
}

const E_ORDER = ['scene 1', 'scene 2', 'scene 3', 'scene 3: she stands still', 'scene 3: she counts',
  'scene 3: off the gravel', 'scene 4', 'scene 5', 'scene 6', 'end'];
const logTime = line => { const [m, s] = line.trim().split(/\s+/)[0].split(':').map(Number); return m * 60 + s; };

function episodeProblems(name, run) {
  const p = EPISODE_WALKERS[name];
  const problems = [];
  const { log, played, sideCalls, memory } = run;
  const count = id => played.filter(x => x.id === id).length;
  const at = label => { const l = log.find(x => x.includes(label) && !x.includes('▶')); return l ? logTime(l) : null; };

  let pos = 0;
  for (const line of log) if (pos < E_ORDER.length && line.includes(E_ORDER[pos]) && !line.includes('▶')) pos++;
  if (pos !== E_ORDER.length) problems.push(`reached ${E_ORDER[pos]} (${pos}/${E_ORDER.length})`);
  if (log.some(l => l.includes('ERROR'))) problems.push('the script threw');

  for (const id of p.has || []) if (!count(id)) problems.push(`${id} never heard`);
  for (const id of p.not || []) if (count(id)) problems.push(`${id} heard`);
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

  // The lamp only between her stepping off the gravel and scene 4, and in
  // scene 5. Whatever the profile expects, a lamp anywhere else is wrong.
  const off = at('scene 3: off the gravel'), s4 = at('scene 4'), s5 = at('scene 5'), s6 = at('scene 6');
  for (const x of played.filter(x => x.id === 'x-avvikelse')) {
    const ok = (off !== null && x.t >= off && (s4 === null || x.t <= s4)) || (s5 !== null && x.t >= s5 && (s6 === null || x.t <= s6));
    if (!ok) problems.push(`the lamp lit at ${fmt2(x.t)}, where a stop is harmless`);
  }

  // From her last step to "trettio": half a minute, on the last count she made.
  const stood = log.filter(l => l.includes('she stands still')).map(logTime).pop();
  const counting = played.filter(x => x.id === 's3-3').pop();
  if (stood === undefined || !counting) problems.push('she never counted');
  else {
    const half = counting.t + E_CUE - stood;
    if (Math.abs(half - 30) > 1) problems.push(`"trettio" came ${half.toFixed(1)} s after she stopped, wanted 30`);
  }

  // Her side. The tone never left on, and after the lamp at the tree she
  // does not take another step until scene 5: that is what makes a second
  // stop harmless there.
  let tone = false;
  for (const c of sideCalls) if (c.what === 'tone') tone = !!c.args[0];
  if (tone) problems.push('the lamp tone was left on');
  const lamp3 = at('scene 3: lamp');
  if (lamp3 !== null && s5 !== null) {
    const step = sideCalls.find(c => c.what === 'walk' && c.args[0] && c.t > lamp3 && c.t < s5);
    if (step) problems.push(`she walks (${step.args[0]}) at ${fmt2(step.t)}, after the lamp and before scene 5`);
  }
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
  if (!(E_CUE > 0)) problems.push('no measured cue for "trettio" in s3-3');
  return problems;
}

async function episodeMain(onlyProfile) {
  let failures = 0;
  const heard = new Set();
  for (const name of Object.keys(EPISODE_WALKERS)) {
    if (onlyProfile && onlyProfile !== name) continue;
    const run = await simulateEpisode(name);
    run.played.forEach(x => heard.add(x.id));
    console.log(`\n=== episode 1 / ${name} — ${run.ended ? 'ended at ' + Math.round(run.t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
    console.log(run.log.join('\n'));
    const problems = episodeProblems(name, run);
    if (!run.ended) problems.unshift('did not end');
    if (problems.length) failures++;
    console.log(problems.length ? `FAIL: ${problems.join('; ')}` : 'OK: the right branches, the lamp only where it should, half a minute');
  }
  if (!onlyProfile) {
    const problems = coverageProblems(heard);
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
