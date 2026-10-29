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
//   node scripts/test_glimt.mjs e1en          # episode 1 in English, the same walkers
//   GLIMT_LUFT=2 node scripts/test_glimt.mjs e1en   # ... with its pauses twice as long (?luft=2)
//
// Episode 1 has more to get wrong than scene order: which stop lights the
// lamp, which branch each walker hears, and that her half minute is a half
// minute. Its walkers react to what she says (see EPISODE_WALKERS).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter, simulatedMagnitude } from '../glimt/engine.js';
import { runChapter1 } from '../glimt/chapter1.js';
import { runChapter2 } from '../glimt/chapter2.js';
import { runEpisode1, SV as EPISODE_SV, EN as EPISODE_EN, withAir } from '../glimt/episod1.js';
import { breakAt, BREAK_LEAD, BREAK_FADE } from '../glimt/audio.js';
import { Listener, LISTEN_YES } from '../glimt/listen.js';
import { Bag, STORIES } from '../glimt/bag.js';
import { haversine } from '../glimt/engine.js';
import { REACH, PEAK_REACH } from '../glimt/world.js';

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
      // `handling`: while standing, the phone is bumped every 0.95-1.75 s, or,
      // given a list of gaps, at those gaps in turn.
      // `quietAfter`: from then on the steps barely reach the sensor.
      if (steps && !NO_STEPS) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          let m = simulatedMagnitude(u, speed);
          if (quietAfter !== null && u >= quietAfter) m = 9.81 + (m - 9.81) * 0.2;
          if (handling && speed === 0) {
            if (u >= nextBump + 0.15) nextBump = nextHandlingBump(handling, u);
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

// `e1en`: the English episode, its file and its words (EN in episod1.js),
// walked by the same walkers. What they expect of the Swedish words is read
// across to the English below (brokeSaid).
const ENGLISH = process.argv[2] === 'e1en';
// GLIMT_LUFT: the English pauses at that many times their length, as ?luft=
// gives them in the app (withAir). Unset, the standard.
const LUFT = process.env.GLIMT_LUFT ? Number(process.env.GLIMT_LUFT) : 1;
const E_OPTS = ENGLISH ? withAir(EPISODE_EN, LUFT) : EPISODE_SV;
const E_WORDS = E_OPTS.words;
const EPISODE_SV_FILE = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episod-1.json'), 'utf8'));
const EPISODE = ENGLISH ? JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-1.json'), 'utf8')) : EPISODE_SV_FILE;
const E_SECONDS = EPISODE.seconds || {};
const E_CUE = (EPISODE.cues && EPISODE.cues['s2-3'] && EPISODE.cues['s2-3'][E_WORDS.thirty]) || 0;
// The end after she is back on the gravel: at most END_GAP, and END_SOON for
// a walker nearly back, plus the log's whole seconds and a tick.
const E_CREDITS = (EPISODE.credits && EPISODE.credits.seconds) || 0;
const E_BREAKS = EPISODE.breaks || {};
// The seven questions answered by a stop (question() in episod1.js). In
// English she says "Now." after each (E_OPTS.now, v46), and a walker answers
// after that: what a walker does at a question's 'end' is done when her now
// has been said, as she asked in her first question.
const QUESTIONS = ['s0-ask1', 's0-again1', 's0-yes1-b', 's0-no1', 's0-again2', 's1-q2', 's1-again'];
const E_NOW = E_OPTS.now || null;
// The walkers name where a go line ends by its Swedish words; in English the
// same pause by its place among the line's pauses (the last when the English
// has fewer).
function brokeSaid(id, sv) {
  if (!ENGLISH) return sv;
  const i = ((EPISODE_SV_FILE.breaks || {})[id] || []).findIndex(b => b.said === sv);
  const en = E_BREAKS[id] || [];
  return i < 0 || !en.length ? sv : en[Math.min(i, en.length - 1)].said;
}

// What a walker does when a line is heard: `[when, from, to]`, a stop from
// `from` to `to` seconds after the line's 'start' or 'end'. A list of them
// for more than one stop.
const ANSWER = ['end', 2, 12];
// Handling the phone while standing, measured: the step detector's steps
// during the credits of Henric's walk 23/10 (version 38), 2:27.7-2:32.5, the
// phone turned over in his hand with the walker standing (gps 0.2-0.6 km/h).
// Faster and more uneven than the random bumps. No two gaps in a row under
// 0.9 s, where his first steps after standing came 0.42-0.77 s apart. (The
// steps just before, 0.82-0.93 s apart, came while he still walked slowly
// with the phone in his hand, gps 3.3-3.9 km/h: not handling.)
const HANDLED_2310 = [0.68, 0.93, 0.58, 1.32, 0.38, 0.92];
let bumpIndex = 0;
function nextHandlingBump(handling, u) {
  if (!Array.isArray(handling)) return u + 0.8 + Math.random() * 0.8;
  const gap = handling[bumpIndex++ % handling.length];
  return u - 0.15 + gap;
}
// s after her first plea that the hesitating walker walks again: the phone
// sees the move before her second plea, not yet as walking. GPS takes about
// two and a half seconds to see a walker move. Measured 20/10: the episode
// without its check (v35) fails from 7 to 8 s and passes at 6.75 and below;
// from 8 s the episode with the check fails too, so 7.25 sits in the middle.
const HESITATES = 7.25;

const END_STOP = { 's4-all': ['end', 3, Infinity] };
const out = (speed = 1.4, turn = 330) => t => ({ speed: t < 5 ? 0 : speed, heading: t < turn ? 0 : Math.PI });

// The map's answer in a walk: `kind` every 300 m for 1.8 km round the start,
// so a walker anywhere on a walk has one within reach when she speaks in
// scene 3 (landmarksNear: at most 212 m off the grid, plus the fix). The
// Swedish episode's landmark is the world's `landmark`, as before.
const LAT0 = 59.38, LON0 = 13.5;
const north = m => LAT0 + m / 111320;
const east = m => LON0 + m / (111320 * Math.cos(LAT0 * Math.PI / 180));
const town = kind => {
  const found = [];
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) found.push({ name: kind, lat: north(300 * i), lon: east(300 * j) });
  return found;
};
const WOODS = town('skog');
// The Swedish guesses where the phone read nothing (world.js, orGuess).
const GUESS = { light: 'light', rain: false, landmark: 'bro' };
// Every landmark clip, for walkers that must hear none of them.
const LANDMARK_LINES = ['s3-near', ...STORIES.map(st => st.line)];

// `has`: lines that must be heard. `not`: lines that must not. `twice`:
// lines said again after an interruption. `lamps`: how many times the lamp
// lights. `memory`: what episode 2 is told. `breath: false`: the walker goes
// on at the end, so no breath under the hum. `walksAt`: like `stops`, but
// `[when, after]` ends a stop that is going on, `after` seconds from the
// line's 'start' or 'end'. `bumps`: like `walksAt`, one bump of the phone
// `after` seconds from the line's 'start' or 'end', as a handled phone gives
// (v40). `skips`: log lines this walker never reaches.
// `broke`: lines that end early, at the pause after the words given, for the
// walker went (v40). `whole`: lines said to their end. `skipped`: lines not
// said at all, the walker going already. `voiceAfterStop`: at most this long
// from the stop to the go line that answers it. `noAfterLine`: at most this
// long from the end of a question to her no.
// `en`: what is different for this walker in English (e1en), where its
// Swedish timing sat on an edge the English takes move: the same walk, moved
// to the same side of the edge.
// `known`: a failure found and not yet fixed, said every run. It fails the
// suite once the walker passes, so the mark comes off with the fix, and
// always when the episode throws, hangs or skips a scene. `knownProblems`:
// its problems word for word; any other change to them fails too.
const EPISODE_WALKERS = {
  // Never stops, not even at the end: every no-branch, and the end on the clock.
  never: {
    walk: out(), stops: {}, noAfterLine: 25,
    has: ['s0-no1', 's0-no2', 's1-walk', 's1-q2-no', 's2-count', 's2-ask', 's2-no', 's3-dark', 's3-dry', 's3-near', 's3-skog',
      's4-ok', 's4-back', 's4-never-1', 's4-never-no', 's4-all'],
    not: ['s0-yes1-a', 's0-yes2', 's1-q2-yes', 's2-count-stop', 's2-lamp-1', 's2-lamp-2', 's4-lamp-2', 's4-ok-lamp',
      's4-onward', 's4-yes', 's4-never-yes-1', 'r-hjalp'],
    lamps: 0, breath: false, memory: { svarade: false, misstanke: false },
  },
  // A listen (?lyssna) nobody touches: the walker of listen.js, which walks
  // and stops by itself only where the chapter's LISTEN_YES says. In English
  // that is "Can you hear me?" (Henric 29/10): it walks through "Can you see
  // me?", a no, stops after her now at s0-no1, a yes, walks on after her go,
  // heard whole, and every later question is a no. The Swedish has no yes.
  // On the feet, as a listen is: the page makes up steps and fixes (startSim).
  listen: {
    walk: t => ({ ...out()(t), steps: true }), stops: {}, listen: true, voiceAfterStop: 2.5,
    has: ['s0-no1', 's0-no2', 's1-q2-no', 's2-no', 's4-never-1', 's4-never-no'],
    not: ['s0-yes1-a', 's0-yes2', 's0-go2', 's4-yes', 'x-stod'],
    lamps: 0, breath: false, memory: { svarade: false, misstanke: false },
    en: {
      has: ['s0-no1', 's0-go2', 's0-yes2', 's0-yes2-aside', 's1-q2-no', 's2-no', 's4-yes'],
      not: ['s0-yes1-a', 's0-no2', 'x-stod', 'x-ga-igen', 's1-q2-yes', 's4-never-1'],
      whole: ['s0-go2'], logs: ['scene 0: no', 'scene 0: yes, hears her'],
      memory: { svarade: true, misstanke: false },
    },
  },
  // The same, but the listener taps Stop 0.4 s after her now, as she asks,
  // when the walker has already stopped by itself and the button says Walk:
  // the tap keeps it standing (TAP_HOLD), and the answer is still a yes.
  'listen-tap': {
    walk: t => ({ ...out()(t), steps: true }), stops: {}, listen: true, listenTap: 0.4,
    has: ['s0-no1', 's0-no2'], not: ['s0-yes2', 's4-yes'],
    lamps: 0, breath: false, memory: { svarade: false, misstanke: false },
    en: {
      has: ['s0-no1', 's0-go2', 's0-yes2', 's4-yes'], not: ['s0-no2', 'x-ga-igen', 's4-never-1'],
      whole: ['s0-go2'], logs: ['scene 0: yes, hears her'],
      memory: { svarade: true, misstanke: false },
    },
  },
  // Stops every time she asks, and at the end.
  asked: {
    walk: out(), stops: { 's0-ask1': ANSWER, 's0-yes1-b': ANSWER, 's1-q2': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes1-b', 's0-yes2', 's1-q2-yes', 's2-ask', 'x-avvikelse', 's2-lamp-plea', 's2-lamp-mine', 's2-lamp-1', 's4-ok-lamp', 's4-yes',
      's0-go1', 's0-go2', 's1-go'],
    not: ['s0-no1', 's0-no2', 's1-q2-no', 's2-no', 's2-lamp-plea2', 's2-lamp-2', 's4-ok', 's4-lamp-2', 's4-never-1'],
    // Ten seconds standing: each go line to its end, and her "Gå." once more
    // four seconds on, ended there as the walker goes (no wait before the go
    // line since v40, so it comes while the walker still stands).
    whole: ['s0-go1', 's0-go2', 's1-go'], broke: { 'x-ga-igen': 'Gå.' },
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
    // Jessica's s2-2 is 7.1 s, not 8.8 (29/10): the same stop, earlier, so
    // the walk seen again before she starts counting.
    en: { stops: { 's0-ask1': ANSWER, 's2-2': ['start', 0.5, 4.5], 's3-1': ['start', 1, 12], 's4-ok': ['start', 0, 9], ...END_STOP } },
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
    // The English count is 10 s, not 14: the same stop, earlier in it. GPS
    // sees it about 6.5 s on, and her "go" takes 3.5 more: a stop later than
    // half a second into the English count makes "thirty" late. Her go ends
    // about at the last numbers' time even so, and how far past depends on
    // where scene 2 falls between two of the walker's fixes (once a second):
    // 30.9 s in v47, 31.1 once v48's breaths moved it a quarter second. So a
    // second and a half here: every stop from 0 to 1 s in and 5.25 to 6.5 s
    // long gave 31.1.
    en: { stops: { 's2-count': ['start', 0.5, 5.5], ...END_STOP }, countSlack: 1.5 },
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same stop, long enough to pass the half minute: she says the last
  // numbers once the walker walks, late.
  'counted-long': {
    walk: out(), stops: { 's2-count': ['start', 4, 24], ...END_STOP },
    en: { stops: { 's2-count': ['start', 1.5, 24], ...END_STOP } },
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
  // Stops on the word, before her now, for two and a half seconds, and walks
  // on: in Swedish that is the yes (the window opens at "ser"), in English
  // it is no answer, for she said she would say now first and the window
  // opens there (v46). Before v46 the English heard a yes here too. The stop
  // is short on purpose: one that stays on until the band sees it, about two
  // seconds after the last step and so after her now, is a yes in English
  // too, as at every question (the band's stop counts from when it is seen).
  eager: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['start', 14.5, 17.0], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1', 'x-stod'],
    en: { has: ['s0-no1', 's0-no2'], not: ['s0-yes1-a', 'x-stod'], memory: { svarade: false, misstanke: false } },
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops as she begins "Are you alone?", the one question with no word to
  // open at, for two and a half seconds, and walks on. In Swedish the window
  // opens as the line starts and that is a yes; in English it is shut until
  // her now, and the stop is over by then: a no (v46).
  'alone-early': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's1-q2': ['start', 0.2, 2.7], ...END_STOP },
    has: ['s1-q2-yes'], not: ['s1-q2-no', 'x-stod'],
    en: { has: ['s1-q2-no'], not: ['s1-q2-yes', 'x-stod'], memory: { svarade: false, misstanke: false } },
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Henric's walk 23/10 (version 38): stops about a second after the question
  // for two and a half seconds, long enough for the feet to call it still,
  // and walks on before the band is sure. Until v40 the step gap was the yes,
  // heard as he walked on, and no "gå" for someone already going. Since v40
  // the feet call it two seconds after his last step, while he stands: she
  // says she saw him, and as he walks on she stops at the pause before "gå".
  'walks-on': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 1.0, 3.5], 's0-yes1-b': ['end', 1.0, 3.5], 's1-q2': ['end', 1.0, 3.5], ...END_STOP },
    has: ['s0-yes1-a', 's0-yes2', 's1-q2-yes', 's0-go1', 's0-go2', 's1-go'], not: ['s0-no1', 'x-ga-igen'],
    broke: { 's0-go1': 'Där försvann du.', 's0-go2': 'Där! Ja.', 's1-go': 'Där. Okej.' }, voiceAfterStop: 2.0,
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stops for the yes and stands, then goes half a second into her second go
  // line: the first is said to its end, the second ends after "Där! Ja.".
  // At the tree too, on the feet: the lamp is the answer there, read by the
  // band, so that window keeps its ten seconds.
  'goes-mid': {
    walk: t => ({ ...out()(t), steps: true }),
    stops: { 's0-ask1': ['end', 1.0, 7], 's0-yes1-b': ['end', 1.0, 60], 's2-ask': ANSWER, ...END_STOP },
    walksAt: { 's0-go2': ['start', 0.5] },
    has: ['s0-yes1-a', 's0-yes2', 's0-go1', 's0-go2', 's2-lamp-mine'], not: ['s0-no1', 'x-ga-igen', 's2-no'],
    whole: ['s0-go1'], broke: { 's0-go2': 'Där! Ja.' }, voiceAfterStop: 2.0,
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // Stands for her second "gå" and shifts the phone once, 0.8 s into it, then
  // walks half a second after it: one bump is no walk, so the line is said
  // to its end. (Until the review of v40 one step ended it, and a walker
  // handling the phone never heard "Gå nu, gå.")
  bumped: {
    walk: t => ({ ...out()(t), steps: true }),
    stops: { 's0-ask1': ['end', 1.0, 7], 's0-yes1-b': ['end', 1.0, 60], ...END_STOP },
    walksAt: { 's0-go2': ['end', 0.5] }, bumps: { 's0-go2': ['start', 0.8] },
    has: ['s0-yes1-a', 's0-yes2', 's0-go1', 's0-go2'], not: ['s0-no1', 'x-ga-igen'],
    whole: ['s0-go1', 's0-go2'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // As goes-mid, but the walker stands through her second go line and turns
  // the phone over from its first word, as Henric did in the credits on 23/10
  // (HANDLED_2310). Two of those bumps come closer than STRIDE: to her that is
  // two steps, so the line ends after "Där! Ja.". And the band reads the
  // bumps as a gait (as `handled`), so her "Gå." does not come either. The
  // cost of ending a go line on two steps, see `standing` in episod1.js:
  // three steps would say it whole here, and fail `walks-on`.
  'handled-go': {
    walk: t => ({ ...out()(t), steps: true }),
    stops: { 's0-ask1': ['end', 1.0, 7], 's0-yes1-b': ['end', 1.0, 60], ...END_STOP },
    handlesAt: { 's0-go2': ['start', 0, 8] },
    has: ['s0-yes1-a', 's0-yes2', 's0-go1', 's0-go2'], not: ['s0-no1', 'x-ga-igen'],
    whole: ['s0-go1'], broke: { 's0-go2': 'Där! Ja.' },
    // The English pause after "There! Yes." is over at 1.82 s, before the
    // two close bumps (2.2 s): "Go now, go." has no pause, so it is said whole.
    en: { whole: ['s0-go1', 's0-go2'], broke: {} },
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // Stands a little over a second at each question: the step gap is shorter
  // than FEET_STOP, so it is no answer.
  pause: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 0.3, 1.4], 's0-no1': ['end', 0.3, 1.4], ...END_STOP },
    has: ['s0-no1', 's0-no2'], not: ['s0-yes1-a', 's0-yes2', 'x-stod'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks on through her first question while the page gets no motion for
  // five seconds (the screen off a moment): a quiet sensor is no stop.
  hidden: {
    walk: t => ({ ...out()(t), steps: !(t >= 54.5 && t < 59.5) }), stops: END_STOP,
    has: ['s0-no1', 's0-no2'], not: ['s0-yes1-a', 's0-yes2', 'x-stod'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Walks all the way, and the page gets no motion for a moment where a stop
  // would show: two seconds while she counts, and two as she walks among the
  // trees. When the sensor comes back the band starts over and calls the
  // walker still until three steps; that is no stop. Until v40 it lit the lamp
  // and cut her count short (the feasibility review, 24/10: 11 of 12 such gaps).
  blinks: {
    walk: t => ({ ...out()(t), steps: true }), stops: END_STOP,
    hidesAt: { 's2-count': ['start', 1, 3], 's2-5': ['start', 2, 4] },
    has: ['s2-count', 's2-ask', 's2-no', 's4-ok'], not: ['s2-count-stop', 's2-lamp-plea', 's2-lamp-1'],
    // The count is cut where she thinks the walker stopped, even when "gå" is
    // then skipped for a walker going again: no line may be cut.
    cuts: 0, lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same while she waits at the tree for the stop she asked for.
  'blinks-tree': {
    walk: t => ({ ...out()(t), steps: true }), stops: END_STOP,
    hidesAt: { 's2-ask': ['end', 2, 4] },
    has: ['s2-ask', 's2-no', 's4-ok'], not: ['s2-lamp-mine', 's2-lamp-1'],
    cuts: 0, lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // And five seconds as she runs for the gravel in scene 4, where a lamp
  // would tell episode 2 of a suspicion the walker never caused.
  'blinks-4': {
    walk: t => ({ ...out()(t), steps: true }), stops: END_STOP,
    hidesAt: { 's4-2': ['start', 1, 6] },
    has: ['s4-ok'], not: ['s4-lamp-1', 's4-lamp-2'],
    cuts: 0, lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stops for a moment and walks on, a second and a half on the feet, at each
  // question. Henric's walk 21/10 heard a no: the band needs three seconds.
  brief: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 0.3, 1.8], 's0-yes1-b': ['end', 0.3, 1.8], 's1-q2': ['end', 0.5, 2.0], ...END_STOP },
    // A stop of a second and a half leaves a step gap of FEET_STOP to the
    // floating point, two seconds after the line ends. Longer, the feet see
    // the stop while the walker still stands, and the go line comes. So a
    // stop this short is a coin toss on a phone too. On Paula's English
    // takes (v41) it rounded under and heard a no; on Jessica's (v45) it
    // rounds over, as in Swedish.
    has: ['s0-yes1-a', 's0-yes2', 's1-q2-yes', 's4-yes'], not: ['s0-no1', 's0-no2', 's1-q2-no', 's0-go1', 's0-go2', 's1-go'],
    // The yes comes with the step that ends the gap: going again, so her go
    // line is not said at all.
    skipped: ['s0-go1', 's0-go2', 's1-go'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // A hesitation, not a stop: under a second standing, a gap shorter than
  // FEET_STOP. That is still a no, five seconds and a step after the line.
  hesitant: {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 0.3, 0.9], 's0-no1': ['end', 0.3, 0.9], ...END_STOP },
    has: ['s0-no1', 's0-no2'], not: ['s0-yes1-a', 's0-yes2', 'x-stod'], noAfterLine: 6,
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The brief stop on GPS alone: without the feet there is no gap to read,
  // and the band cannot see a stop that short.
  'brief-gps': {
    walk: out(), stops: { 's0-ask1': ['end', 0.3, 1.8], ...END_STOP },
    has: ['s0-no1'], not: ['s0-yes1-a', 'x-stod'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // Stands at a light from before she asks until well after the window: that
  // is no answer. She says so, asks again once the walker walks, and this
  // time the walker stops, and stands on past her "gå" until she says it twice.
  stood: {
    walk: out(), stops: { 's0-ask1': ['start', 5, 80], 's0-again1': ['end', 0.3, 14], ...END_STOP },
    has: ['x-stod', 's0-again1', 's0-go1', 'x-ga-igen', 's0-yes1-a'], not: ['s0-no1'],
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
  // The same on the feet, whose window is five seconds (ten until v40).
  'closing-feet': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 4.25, 20], ...END_STOP },
    has: ['s0-yes1-a', 's4-yes'], not: ['s0-no1'],
    lamps: 0, memory: { svarade: true, misstanke: false },
  },
  // And a stop that begins once the window has closed is no answer.
  'closed-feet': {
    walk: t => ({ ...out()(t), steps: true }), stops: { 's0-ask1': ['end', 6, 20], ...END_STOP },
    has: ['s0-no1'], not: ['s0-yes1-a'],
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // The same late stop by a slow walker, 72 steps a minute: steps further
  // apart than STRIDE, so no quick no when the window closes, and her no
  // waits for the band. The feet see the stop two seconds after the last
  // step, before she has said no, and it is still no answer.
  'closed-slow': {
    walk: t => ({ ...out(0.6)(t), steps: true }), stops: { 's0-ask1': ['end', 6, 20], ...END_STOP },
    has: ['s0-no1'], not: ['s0-yes1-a'],
    // The edge (yes before, no after) is at 6 s on the Swedish line and 6.5
    // on the English, where the slow steps fall half a step later.
    en: { stops: { 's0-ask1': ['end', 7, 20], ...END_STOP } },
    lamps: 0, memory: { svarade: false, misstanke: false },
  },
  // A red light between scene 1 and 2: forty-two seconds still while she walks.
  light: {
    walk: out(), stops: { 's1-3': ['end', 2, 44], ...END_STOP },
    has: ['s2-no', 's2-count'], not: ['r-hjalp', 's2-count-stop'],
    // In English the tree follows six seconds after scene 1 (v49; four until
    // then): GPS has seen the stop by then, so scene 2 waits for the walker
    // as in Swedish. With four it opened on a stop not yet seen, and she
    // stood through the count asking them to go (as 'counted-long' still does).
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
    // On Jessica's takes (29/10) GPS sees a stop 3 s after her no only once
    // scene 3 has opened, where sitting is harmless: the same stop, sooner.
    en: { stops: { 's2-no': ['end', 1, 15], ...END_STOP } },
    has: ['s2-ask', 's2-no', 'x-avvikelse', 's2-lamp-1'], not: ['s2-lamp-mine', 's2-lamp-2', 's4-yes'],
    lamps: 1, memory: { svarade: false, misstanke: false },
  },
  // Stops a moment before she would ask at the tree. The stop shows as the
  // lamp before she has asked for anything, so it is not her answer.
  brink: {
    walk: out(), stops: { 's2-6': ['start', 4.5, 22], ...END_STOP },
    // Jessica's s2-6 is 6.3 s, not 8.6 (29/10): 4.5 s in is seen after the
    // question has begun. The same moment before she asks, sooner.
    en: { stops: { 's2-6': ['start', 3, 22], ...END_STOP } },
    has: ['s2-6', 'x-avvikelse', 's2-lamp-1'], not: ['s2-ask', 's2-no', 's2-lamp-2', 's4-yes'],
    lamps: 1, cuts: 0, memory: { svarade: false, misstanke: false },
  },
  // A stop that shows in the moment between her line and her hand on the
  // trunk: after the lamp she still reaches out and touches it.
  pat: {
    walk: out(), stops: { 's2-5': ['start', 5.0, 25], ...END_STOP },
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
    // Standing for ten seconds with the phone handled, so she says gå: the
    // bumps are no walk to her. Since v40 two steps at a gait's pace end a go
    // line at its next pause, and the bumps never come that close: each go
    // line is said whole.
    has: ['s0-yes1-a', 's0-yes2', 'x-avvikelse', 's2-lamp-mine', 's2-lamp-1', 's4-yes', 's0-go1', 's0-go2'], not: ['s2-lamp-2', 's4-lamp-2'],
    whole: ['s0-go1', 's0-go2'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // The field walker with the bumps fixed (seed 4): while it stands for her,
  // three bumps make the band say walk just after her window closes. That is
  // no walk, so no quick no: three steps at a gait's pace are wanted too
  // (v40; without them 8 of 25 seeds heard a no here).
  'field-held': {
    seed: 4,
    walk: t => ({ ...out()(t), ...FIELD_2, handling: true }), stops: { 's0-ask1': ANSWER, 's0-yes1-b': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes2', 'x-avvikelse', 's2-lamp-mine', 's2-lamp-1', 's4-yes', 's0-go1', 's0-go2'], not: ['s2-lamp-2', 's4-lamp-2'],
    lamps: 1, memory: { svarade: true, misstanke: false },
  },
  // The same walker, handling the phone as Henric did during the credits on
  // 23/10: the bumps come at the measured gaps, faster and more uneven than
  // the random ones. Standing ten seconds, so she still says gå.
  // `known`: it fails, in version 38 as in 39, and not on "going". The band
  // counts any three steps at 70 a minute or more as walking, and these
  // bumps come at 75: a stop with the phone in hand is never seen, so every
  // question is a no and the lamp never lights. That is the simulation's
  // finding, not the field's: the gaps repeat evenly here, so the band never
  // settles. In the real credits it went back and forth, still 2:23-2:29.5
  // and 2:36.5-2:39.5, moving in between, so a stop there would likely have
  // been seen. On the walk he did not handle the phone at the questions.
  // Left standing until the band can tell bumps from a gait.
  handled: {
    walk: t => ({ ...out()(t), ...FIELD_2, handling: HANDLED_2310 }), stops: { 's0-ask1': ANSWER, 's0-yes1-b': ANSWER, 's2-ask': ANSWER, ...END_STOP },
    has: ['s0-yes1-a', 's0-yes2', 'x-avvikelse', 's2-lamp-mine', 's2-lamp-1', 's4-yes', 's0-go1', 's0-go2'], not: ['s2-lamp-2', 's4-lamp-2'],
    lamps: 1, memory: { svarade: true, misstanke: false },
    known: 'the band reads the measured handling as a gait, so the stop is never seen',
    knownProblems: ['s0-yes1-a never heard', 's0-yes2 never heard', 'x-avvikelse never heard', 's2-lamp-mine never heard',
      's2-lamp-1 never heard', 's4-yes never heard', 's0-go1 never heard', 's0-go2 never heard', 'the lamp lit 0 times, wanted 1',
      'the breath at the end 0 times, wanted 1', 'the end is logged as going on, wanted standing', 'memory svarade is false, wanted true'],
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

  // v52, Henric 29/10: "Inte hitta på något. Om hon inte kan se så spara
  // replikerna om landmärket till en gång när hon kan se." In English she
  // says only what the phone read; the Swedish episode still guesses.
  // The map never answered (five walks of six until v23): in English no
  // landmark and no "And there's something near you", scene 3 ends on the
  // weather, and episode 2 is told of no place.
  'no-map': {
    walk: out(), stops: END_STOP,
    world: { landmark: null, found: [], landmarkAnswered: 'fel', guess: GUESS },
    has: ['s3-dark', 's3-dry', 's3-near', 's3-bro'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-dark', 's3-dry'], not: LANDMARK_LINES, told: null, memory: { svarade: false, misstanke: false, landmark: null },
      logs: ['scene 3: the bag: nothing read near the walker'], endsOn: 's3-dry' },
  },
  // The map found a bridge near where the walk began, and the walker has
  // walked off: 500 m away by scene 3. Until v52 she named it anyway.
  'left-behind': {
    walk: t => ({ speed: t < 5 ? 0 : 1.4, heading: 0 }), stops: END_STOP,
    world: { landmark: 'bro', found: [{ name: 'bro', lat: north(-200), lon: LON0 }], guess: GUESS },
    has: ['s3-near', 's3-bro'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-dry'], not: LANDMARK_LINES, told: null, memory: { svarade: false, misstanke: false, landmark: null }, endsOn: 's3-dry' },
  },
  // Woods everywhere, and the woods' story heard on an earlier walk: not
  // told again, nor anything else. The Swedish episode has no bag.
  'heard-it': {
    walk: out(), stops: END_STOP, heard: ['woods'],
    has: ['s3-near', 's3-skog'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-dry'], not: LANDMARK_LINES, told: null, logs: ['every story about it heard'], endsOn: 's3-dry' },
  },
  // A bridge and water everywhere, the bridge's story heard: she tells the
  // water's, and the bag keeps it.
  'heard-one': {
    walk: out(), stops: END_STOP, heard: ['bridge'],
    world: { landmark: 'vatten', found: [...town('bro'), ...town('vatten')] },
    has: ['s3-near', 's3-vatten'], not: ['s3-bro'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-near', 's3-vatten'], not: ['s3-bro'], told: 'water', memory: { svarade: false, misstanke: false, landmark: 'vatten' } },
  },
  // The first lookup found nothing near the start; the second, at scene 2,
  // finds woods all round: in English she tells the woods.
  'found-later': {
    walk: out(), stops: END_STOP,
    world: { found: [] }, later: WOODS,
    has: ['s3-near', 's3-skog'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-near', 's3-skog'], told: 'woods', memory: { svarade: false, misstanke: false, landmark: 'skog' }, logs: ['kartan igen: '] },
  },
  // The woods' clip never comes (a dropped connection while it loads):
  // "And there's something near you." and then nothing, so the woods stay
  // in the bag for another walk and episode 2 is told of no place.
  'lost-story': {
    walk: out(), stops: END_STOP, lost: ['s3-skog'],
    has: ['s3-near'], not: ['s3-skog'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-near'], not: ['s3-skog'], told: null, memory: { svarade: false, misstanke: false, landmark: null },
      logs: ['scene 3: s3-skog did not play (no sound), woods stays in the bag'] },
  },
  // No position all walk, so neither the sun nor the weather nor the map
  // was read: in English scene 3 is her sitting down and nothing she sees.
  'unread': {
    walk: out(), stops: END_STOP,
    world: { light: null, rain: null, landmark: null, found: [], guess: GUESS },
    has: ['s3-light', 's3-dry', 's3-near', 's3-bro'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s3-1'], not: ['s3-light', 's3-dark', 's3-rain', 's3-dry', ...LANDMARK_LINES], told: null, endsOn: 's3-1' },
  },
  // Stands from her last words before the credits until well past scene 1's
  // wait: the phone never reads the walker moving with the line clear, so in
  // English she does not say "You're walking" (v52). Swedish as v40.
  'stands-through-1': {
    walk: out(), stops: { 's0-no2': ['end', 0, E_CREDITS + 200], ...END_STOP },
    has: ['s1-walk', 's1-2'],
    lamps: 0, memory: { svarade: false, misstanke: false },
    en: { has: ['s1-2'], not: ['s1-walk', 's1-run'], logs: ['scene 1: the phone has not read the walker moving'] },
  },
};

// Every light, weather and landmark, each on a walker who never stops. The
// map has the landmark all round the walk (town).
const EPISODE_WORLDS = [
  { light: 'dark', rain: true, landmark: 'bro' },
  { light: 'light', rain: false, landmark: 'vatten' },
  { light: 'light', rain: true, landmark: 'berg' },
  { light: 'dark', rain: false, landmark: 'kyrkogard' },
];
for (const w of EPISODE_WORLDS) {
  EPISODE_WALKERS[`world-${w.landmark}`] = {
    walk: out(), stops: END_STOP, world: { ...w, found: town(w.landmark) },
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

// A walker as it walks in the language under test.
const walker = name => (ENGLISH && EPISODE_WALKERS[name].en ? { ...EPISODE_WALKERS[name], ...EPISODE_WALKERS[name].en } : EPISODE_WALKERS[name]);

function simulateEpisode(name, E = E_OPTS) {
  const profile = walker(name);
  const random = Math.random;
  if (profile.seed !== undefined) Math.random = seeded(profile.seed);
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  const said = [];            // {msg, t}: the log lines with their exact time
  const played = [];          // {id, t, side}
  const sideCalls = [];       // {t, what, args}
  const stops = [];           // {from, to}
  let memory = null;
  let cuts = 0;
  const skipped = [];         // {id, t}: lines not said, the walker already going
  const credited = [];        // when the credits started
  const truth = [];           // {t, d, acc, lat, lon}: where the walker really is, m from the start, and the fix's accuracy
  // The stories heard (bag.js): those the walker heard before, then this walk's.
  const bag = new Bag(null);
  for (const id of profile.heard || []) bag.add(id);
  const world = { light: 'dark', rain: false, landmark: 'skog', landmarkCoord: null, found: WOODS, ...(profile.world || {}) };
  let current = null;
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let ended = false;
  let nextBump = 0;
  bumpIndex = 0;
  const bumpAt = [];          // single bumps (`bumps`), when they come
  const handles = [];         // {from, to}: the phone handled as measured (`handlesAt`)
  const hides = [];           // {from, to}: no motion samples, the page hidden (`hidesAt`)

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const react = (id, when) => {
    const r = profile.stops[id];
    for (const [at, from, to] of !r ? [] : Array.isArray(r[0]) ? r : [r]) {
      if (at === when) stops.push({ from: t + from, to: t + to });
    }
    const w = (profile.walksAt || {})[id];
    if (w && w[0] === when) for (const st of stops) if (st.from <= t + w[1] && st.to > t + w[1]) st.to = t + w[1];
    const bp = (profile.bumps || {})[id];
    if (bp && bp[0] === when) bumpAt.push(t + bp[1]);
    const hd = (profile.handlesAt || {})[id];
    if (hd && hd[0] === when) handles.push({ from: t + hd[1], to: t + hd[2] });
    const hi = (profile.hidesAt || {})[id];
    if (hi && hi[0] === when) hides.push({ from: t + hi[1], to: t + hi[2] });
  };
  let asked = null;            // the question her now (E_NOW) ends, in English
  // A listen's walker (`listen`): app.js tells it each of her lines that ends,
  // and stands or walks as it answers.
  const listener = profile.listen ? new Listener(LISTEN_YES[ENGLISH ? 'episode1en' : 'episod1'] || [], E_NOW) : null;
  const listenAfter = id => {
    const next = listener.ended(id, t);
    if (next === 'stop') {
      stops.push({ from: t, to: Infinity });
      if (profile.listenTap !== undefined) tapAt = t + profile.listenTap;
    }
    if (next === 'walk') for (const st of stops) if (st.to === Infinity) st.to = t;
  };
  // A tap on the button (`listenTap`): Walk while it stands, Stop while it
  // walks, unless the listener keeps it standing.
  let tapAt = null;
  const tap = () => {
    if (!listener.tapped(t)) { log.push(`${fmt(t)}  tap: kept standing`); return; }
    const open = stops.find(st => st.to === Infinity);
    if (open) open.to = t; else stops.push({ from: t, to: Infinity });
    log.push(`${fmt(t)}  tap: ${open ? 'walk' : 'stop'}`);
  };
  const sound = (id, mark) => {
    const dur = E_SECONDS[id];
    if (dur === undefined) throw new Error(`unknown line ${id}`);
    log.push(`${fmt(t)}  ▶ ${id}${mark}`);
    const entry = { id, t, side: !!mark };
    played.push(entry);
    react(id, 'start');
    // `endAt`: breakOff ended it at a pause, so it is over then, not at its end.
    const me = { id, cut: false, t0: t, endAt: null, entry };
    const ended = () => {
      if (listener && !mark) listenAfter(id);
      if (E_NOW && QUESTIONS.includes(id)) { asked = id; return; }
      react(id, 'end');
      if (id === E_NOW && asked) { react(asked, 'end'); asked = null; }
    };
    return { me, done: waiter.until(s => me.cut || (me.endAt !== null && s.t >= me.endAt), { timeout: dur }).then(ended) };
  };
  const call = what => (...args) => { sideCalls.push({ t, what, args }); };

  const ctx = {
    variant: 'a',
    world,
    state: () => walk.state(),
    position: () => walk.position(),
    bag,
    // As app.js at the start of scene 2: the map again, where the walker is
    // now. `later`: what it finds then that the first lookup did not.
    lookAround: () => {
      if (!profile.later) return;
      world.found = [...world.found, ...profile.later];
      log.push(`${fmt(t)}  kartan igen: ${profile.later.length} nya`);
    },
    log: msg => { said.push({ msg, t }); log.push(`${fmt(t)}  ${msg}  (contact ${walk.contact.value.toFixed(2)}, ${walk.tempo.band})`); },
    hold: on => { walk.contact.hold = on; },
    play(id, opts = {}) {
      // `lost`: a clip that never came, as app.js: logged, no sound, nothing back.
      if ((profile.lost || []).includes(id)) {
        log.push(`${fmt(t)}  replik saknas: ${id}`);
        return Promise.resolve(undefined);
      }
      if (opts.unless && opts.unless(walk.state())) {
        log.push(`${fmt(t)}  – ${id}: the walker is going, not said`);
        skipped.push({ id, t });
        return Promise.resolve('skipped');
      }
      const { me, done } = sound(id, '');
      current = me;
      return done.then(() => { if (current === me) current = null; return me.endAt !== null ? 'break' : 'ended'; });
    },
    cut() { if (current) { current.cut = true; cuts++; log.push(`${fmt(t)}  cut`); } },
    // As app.js and audio.js: the first pause it can still reach, or none.
    breakOff(id) {
      if (!current || current.id !== id) return false;
      const into = t + BREAK_LEAD - current.t0;
      const b = breakAt(E_BREAKS[id], into);
      if (b) {
        current.endAt = current.t0 + b.at + BREAK_FADE;
        current.entry.broke = b.said;
        current.entry.brokeAt = b.at;
        log.push(`${fmt(t)}  ‖ ${id}: ends after "${b.said}" (${b.at.toFixed(2)} s in)`);
      } else {
        current.entry.late = into;
        log.push(`${fmt(t)}  ${id}: no pause left, said to its end`);
      }
      return true;
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => waiter.until(() => false, { timeout: s }).then(() => {}),
    seconds: id => E_SECONDS[id] || 0,
    cue: (id, word) => ((EPISODE.cues || {})[id] || {})[word] || 0,
    remember: facts => { memory = { ...facts }; },
    // As app.js: `under`, the song starts under that line, at its cue word,
    // once the line has started; it is credited from then.
    async credits({ under = null, word = null } = {}) {
      if (under) {
        await waiter.until(() => played.some(x => x.id === under), { timeout: (E_SECONDS[under] || 0) + 20 });
        const line = played.find(x => x.id === under);
        const at = line ? line.t + (word ? ((EPISODE.cues || {})[under] || {})[word] || 0 : 0) : t;
        if (at > t) await waiter.until(() => false, { timeout: at - t });
      }
      log.push(`${fmt(t)}  ▶ förtexter${under ? ` (under ${under})` : ''}`);
      credited.push(t);
      return waiter.until(() => false, { timeout: E_CREDITS }).then(() => {});
    },
    side: {
      walk: call('walk'), other: call('other'), hand: call('hand'), tone: call('tone'),
      bell: call('bell'), lift: call('lift'), pin: call('pin'), fade: call('fade'), breath: call('breath'),
      say: (id, kind) => sound(id, ` (her side, ${kind})`).done,
    },
  };

  const done = runEpisode1(ctx, E).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });

  // As simulate() above, but the microtask queue is drained to the bottom
  // between ticks: the episode's helpers are several awaits deep, and her
  // half minute is checked to the tick.
  return (async () => {
    while (!ended && t < (profile.limit || 40 * 60)) {
      let { speed, heading, accuracy = 8, every = 1, doppler = true, jitter = 0, phone = null,
        steps = false, handling = false } = profile.walk(t);
      if (stops.some(st => t >= st.from && t < st.to)) speed = 0;
      if (handles.some(h => t >= h.from && t < h.to)) handling = HANDLED_2310;
      if (hides.some(h => t >= h.from && t < h.to)) steps = false;
      if (steps && !NO_STEPS) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          let m = simulatedMagnitude(u, speed);
          if (handling && speed === 0) {
            if (u >= nextBump + 0.15) nextBump = nextHandlingBump(handling, u);
            if (u >= nextBump) m += 1.6;
          }
          if (bumpAt.some(b => u >= b && u < b + 0.15)) m += 1.6;
          walk.motion(u, m);
        }
      }
      if (Number.isInteger(t)) {
        lat += (speed * Math.cos(heading)) / 111320;
        lon += (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        truth.push({ t, acc: accuracy, lat, lon, d: Math.hypot((lat - 59.38) * 111320, (lon - 13.5) * 111320 * Math.cos(lat * Math.PI / 180)) });
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
      if (tapAt !== null && t >= tapAt) { tapAt = null; tap(); }
      waiter.check(walk.tick(t));
      await new Promise(r => setImmediate(r));
      t = Math.round((t + 0.25) * 4) / 4;
    }
    await Promise.race([done, Promise.resolve()]);
    Math.random = random;
    return { log, said, ended, t, played, sideCalls, memory, cuts, credited, truth, skipped, stops, E, bag, world, heardBefore: profile.heard || [] };
  })();
}

const E_ORDER = ['scene 0: does the walker see her', 'credits', 'scene 1', 'scene 2', 'scene 2: she stands still',
  'scene 2: she counts', 'scene 2: off the gravel', 'scene 3', 'scene 4', 'scene 4: the end', 'end'];
const logTime = line => { const [m, s] = line.trim().split(/\s+/)[0].split(':').map(Number); return m * 60 + s; };

// The count in English, a second a number (v49, Henric 29/10: "räknar för
// fort ... I slutet saktar hon ner jättemycket"; v48 went 0.56 s a number to
// twenty-six and 1.5 s from there to thirty). The cue of every number in the
// two counting lines is measured from the files (check_glimt_audio.py), so
// these read the takes, not a number written down beside them.
// s a number may fall off its second in a walk: the sim moves in quarter
// seconds and ends a line on the tick after it (its waits start counting on
// the next tick), so the last numbers come about 0.6 s late here; the app
// plays them on the count's own end. v48 had twelve 3.5 s late and
// twenty-seven 1.6 s early.
const COUNT_SLACK = 0.75;
const COUNT_STEP = [0.85, 1.15];    // s from one number to the next, to thirty
const COUNT_AFTER_30 = [0.85, 1.4]; // after thirty, her [short pause] twice
const EN_N = Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((w, i) => [w, i]));
const EN_T = { twenty: 20, thirty: 30, forty: 40 };
function numberOf(word) {
  const [t, u] = word.split('-');
  return t in EN_T ? EN_T[t] + (u ? EN_N[u] : 0) : EN_N[t];
}
// The numbers in the files, in order, with where each falls on one clock: the
// count from 0, its last numbers after it and the episode's countBreath.
function countTimeline(story, countBreath) {
  const at = [];
  const count = story.cues['s2-count'] || {};
  for (const [w, c] of Object.entries(count)) at.push([numberOf(w), c]);
  const from = (story.seconds['s2-count'] || 0) + countBreath;
  for (const [w, c] of Object.entries(story.cues['s2-3'] || {})) at.push([numberOf(w), from + c]);
  return at.sort((x, y) => x[0] - y[0]);
}
function countProblems(story, countBreath) {
  const at = countTimeline(story, countBreath);
  const out = [];
  if (at.length !== 21 || at[0][0] !== 12 || at[20][0] !== 32) out.push(`the count's cues name ${at.map(x => x[0]).join(',')}, not every number from twelve to thirty-two`);
  for (let i = 1; i < at.length; i++) {
    const [n, t] = at[i];
    const step = t - at[i - 1][1];
    const [lo, hi] = n > 30 ? COUNT_AFTER_30 : COUNT_STEP;
    if (n !== at[i - 1][0] + 1 || step < lo || step > hi) out.push(`${at[i - 1][0]} to ${n}: ${step.toFixed(2)} s, wanted ${lo}-${hi}`);
  }
  return out;
}

// Her lines that may follow the one before with no breath, on purpose: her
// Now (the answer is read from the word), her answer to a stop or to a
// walker going again (the go lines, the lamp's pleas and what she says once
// the walker walks), the count and its last numbers, timed to the half
// minute, scene 4's run for the gravel, and her answer to the snäcka.
const TIGHT = new Set([E_NOW, 's0-go1', 's0-go2', 's1-go', 'x-ga-igen', 'x-stod', 's2-count', 's2-count-stop', 's2-3',
  's2-lamp-plea', 's2-lamp-plea2', 's2-lamp-mine', 's2-lamp-1', 's4-lamp-1', 's4-lamp-2', 's4-self', 's4-2', 'r-vilar']);
// ...except where one of them follows another of hers that is not an answer.
const AIRED = new Set(['s2-lamp-mine>s2-lamp-1']);
// The least silence between two of her lines (v48: "Allt är lite för rushed",
// Henric 29/10): the shortest breath, 0.8 s, less the tick the sim reads it on.
const MIN_AIR = 0.75;

// Where one of her lines runs into the one before: [prev, next, gap] for every
// pair under MIN_AIR (times the episode's luft, under 1) that is not tight by
// design. Over 1 the standard's least: where she is exposed a breath keeps the
// standard's length (breath() in episod1.js), and airMain checks the rest.
// A line cut short (the gap from its full length below zero) was cut by what
// the next one answers.
function crowded(run) {
  const out = [];
  const least = MIN_AIR * Math.min(run.E.luft ?? 1, 1);
  let prev = null;
  for (const x of run.played) {
    if (x.side) continue;
    if (prev) {
      const gap = x.t - (prev.t + (prev.brokeAt ?? E_SECONDS[prev.id]));
      const tight = TIGHT.has(x.id) && !AIRED.has(`${prev.id}>${x.id}`);
      if (gap >= 0 && gap < least && !tight) out.push([prev.id, x.id, gap]);
    }
    prev = x;
  }
  return out;
}

function episodeProblems(name, run) {
  const p = walker(name);
  const problems = [];
  const { log, played, sideCalls, memory } = run;
  const E_END = run.E.end;
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
  // Said once, unless the walker's profile says a line comes again. Her
  // "Gå." once more comes at most once for each yes (three in the episode).
  for (const id of new Set(played.map(x => x.id))) {
    const allowed = (p.twice || []).includes(id) ? 2 : id === 'x-avvikelse' ? p.lamps
      : id === E_NOW ? played.filter(x => QUESTIONS.includes(x.id)).length
      : id === 'r-hjalp' || id === 'r-vilar' || id === 'x-ga-igen' ? 3 : 1;
    if (count(id) > allowed) problems.push(`${id} heard ${count(id)} times`);
  }
  if (count('x-avvikelse') !== p.lamps) problems.push(`the lamp lit ${count('x-avvikelse')} times, wanted ${p.lamps}`);
  // Her now after every question, and nowhere else (v46).
  if (E_NOW) {
    const said = played.filter(x => !x.side);
    said.forEach((x, i) => {
      if (QUESTIONS.includes(x.id) && (said[i + 1] || {}).id !== E_NOW) problems.push(`${x.id} not followed by ${E_NOW}`);
      if (x.id === E_NOW && !QUESTIONS.includes((said[i - 1] || {}).id)) problems.push(`${E_NOW} after ${(said[i - 1] || {}).id}, not a question`);
    });
  }

  // In English no line of hers runs into the one before (v48).
  if (ENGLISH) {
    for (const [a, b, gap] of crowded(run)) problems.push(`${b} came ${gap.toFixed(2)} s after ${a}, wanted a breath`);
  }

  // The go lines (v40): ended at a pause, said whole, or not said at all.
  const lastOf = id => played.filter(x => x.id === id).pop();
  for (const [id, sv] of Object.entries(p.broke || {})) {
    const want = brokeSaid(id, sv);
    const x = lastOf(id);
    if (x && x.broke !== want) problems.push(x.broke ? `${id} ended after "${x.broke}", wanted after "${want}"` : `${id} said to its end, wanted it to end after "${want}"`);
  }
  for (const id of p.whole || []) { const x = lastOf(id); if (x && x.broke) problems.push(`${id} ended after "${x.broke}", wanted it whole`); }
  for (const id of p.skipped || []) if (!run.skipped.some(x => x.id === id)) problems.push(`${id} was not skipped`);
  // A line that ends early ends in silence, after a whole sentence.
  for (const x of played.filter(x => x.broke)) {
    if (!(E_BREAKS[x.id] || []).some(b => b.said === x.broke && x.brokeAt >= b.from && x.brokeAt + BREAK_FADE <= b.to)) {
      problems.push(`${x.id} ended at ${x.brokeAt.toFixed(2)} s, outside its pauses`);
    }
  }
  // How soon she answers (Henric 23/10: five seconds from his stop to her
  // voice, and 13.6 from the question to her no). Since v40 the go line
  // comes 1.5-1.75 s after the stop, so 2 s here: FEET_STOP 2.6 fails it.
  if (p.voiceAfterStop !== undefined) {
    for (const x of played.filter(x => ['s0-go1', 's0-go2', 's1-go'].includes(x.id))) {
      const st = run.stops.filter(st => st.from <= x.t).pop();
      if (!st) problems.push(`${x.id} with no stop before it`);
      else if (x.t - st.from > p.voiceAfterStop) problems.push(`${x.id} came ${(x.t - st.from).toFixed(2)} s after the stop, wanted at most ${p.voiceAfterStop}`);
    }
  }
  // A listen's own stop comes after the question, and in English after her
  // now: she promised to say it first (v46, v47).
  if (p.listen) {
    for (const st of run.stops) {
      const q = played.filter(x => !x.side && x.t <= st.from).pop();
      if (!q || !(E_NOW ? q.id === E_NOW : QUESTIONS.includes(q.id)) || st.from < q.t + E_SECONDS[q.id] - 0.25) {
        problems.push(`the listen stopped at ${fmt2(st.from)}, not after ${E_NOW || 'a question'} (${q ? q.id : 'nothing'})`);
      }
    }
  }
  if (p.noAfterLine !== undefined) {
    // From the end of the question, in English the end of her now after it.
    const questions = E_NOW ? [E_NOW] : QUESTIONS;
    for (const x of played.filter(x => ['s0-no1', 's0-no2', 's1-q2-no'].includes(x.id))) {
      const q = played.filter(y => questions.includes(y.id) && y.t < x.t).pop();
      const after = q ? x.t - q.t - E_SECONDS[q.id] : null;
      if (after === null || after > p.noAfterLine) problems.push(`${x.id} came ${after === null ? '?' : after.toFixed(2)} s after the question, wanted at most ${p.noAfterLine}`);
    }
  }
  if (p.reserves !== undefined && count('r-hjalp') !== p.reserves) problems.push(`the snäcka asked ${count('r-hjalp')} times, wanted ${p.reserves}`);
  for (const want of p.logs || []) if (!log.some(l => l.includes(want))) problems.push(`the log never says "${want}"`);
  if (p.cuts !== undefined && run.cuts !== p.cuts) problems.push(`${run.cuts} lines cut short, wanted ${p.cuts}`);

  // She never makes up what she sees (v52). In English: every landmark she
  // names is within reach of where the walker really is as she says it,
  // checked against the walker's true path and not the phone's fix;
  // "something near you" only right before one; a story told once, and one
  // the walker heard before never; and the bag keeps what she told.
  if (E_OPTS.bag) {
    // Her answer to the snäcka (the reserve) can come between, and the line
    // it broke off is then said again.
    const said = played.filter(x => !x.side && x.id !== 'r-vilar');
    said.forEach((x, i) => {
      const story = STORIES.find(st => st.line === x.id);
      // A story clip that never came (`lost`) leaves s3-near with nothing after it.
      const lostStory = (p.lost || []).some(id => STORIES.some(st => st.line === id));
      if (x.id === 's3-near' && !lostStory && !STORIES.some(st => st.line === (said[i + 1] || {}).id)) problems.push(`s3-near followed by ${(said[i + 1] || {}).id}, not a story`);
      if (story && ![x.id, 's3-near'].includes((said[i - 1] || {}).id)) problems.push(`${x.id} without s3-near before it`);
      if (!story) return;
      if (run.heardBefore.includes(story.id)) problems.push(`${story.id} told again, heard on an earlier walk`);
      const here = run.truth.filter(f => f.t <= x.t).pop();
      const reach = story.near === 'berg' ? PEAK_REACH : REACH;
      const real = here && run.world.found.some(f => f.name === story.near && f.lat !== null &&
        haversine({ latitude: here.lat, longitude: here.lon }, { latitude: f.lat, longitude: f.lon }) <= reach);
      if (!real) problems.push(`${x.id} at ${fmt2(x.t)}: no ${story.near} within ${reach} m of the walker`);
    });
    const told = STORIES.find(st => said.some(x => x.id === st.line));
    const tales = new Set(said.filter(x => STORIES.some(st => st.line === x.id)).map(x => x.id));
    if (tales.size > 1) problems.push(`${tales.size} stories in one walk (${[...tales]}), one at most`);
    if (told && !run.bag.has(told.id)) problems.push(`${told.id} told and not kept in the bag`);
    for (const id of Object.keys(run.bag.heard)) {
      if (!run.heardBefore.includes(id) && !(told && told.id === id)) problems.push(`${id} kept in the bag, never told`);
    }
    if (p.told !== undefined && (told ? told.id : null) !== p.told) problems.push(`told ${told ? told.id : 'nothing'}, wanted ${p.told || 'nothing'}`);
  }
  // Scene 3 ends on this line: the next of hers is scene 4's.
  if (p.endsOn) {
    const said = played.filter(x => !x.side);
    const i = said.findIndex(x => x.id === 's4-1');
    if (i < 1 || said[i - 1].id !== p.endsOn) problems.push(`scene 3 ended on ${i < 1 ? '?' : said[i - 1].id}, wanted ${p.endsOn}`);
  }

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
  if (back && s4end !== null && s4end - (back.t + E_SECONDS[back.id]) > E_END.gap + 1) {
    problems.push(`the end came ${Math.round(s4end - back.t - E_SECONDS[back.id])} s after ${back.id}, wanted at most ${E_END.gap}`);
  }
  // And sooner for a walker nearly back. Read from where the simulated walker
  // really is 15 s after that line, not from what the phone made of it: under
  // 250 m from the start and more than 60 m closer than 45 s before, on a
  // phone whose fixes are good enough to be read at all (50 m, as Walk.fix).
  if (back && s4end !== null) {
    const backEnd = back.t + E_SECONDS[back.id];
    const dist = when => { let d = null; for (const p of run.truth) { if (p.t <= when) d = p.d; } return d; };
    const near = dist(backEnd + E_END.soon), before = dist(backEnd + E_END.soon - 45);
    const readable = run.truth.filter(p => p.t >= backEnd + E_END.soon - 45 && p.t <= backEnd + E_END.soon).every(p => p.acc <= 50);
    if (readable && near !== null && before !== null && near < 250 && before - near > 60) {
      run.nearlyBack = true;
      if (s4end - backEnd > E_END.soon + 2) problems.push(`nearly back (${Math.round(near)} m) and the end came ${Math.round(s4end - backEnd)} s after ${back.id}, wanted about ${E_END.soon}`);
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
  // Read to the tick, not from the log's whole seconds: those add up to a
  // second, and a scene that begins later in its second fails a walker whose
  // count is on time (v46: her now in scenes 0 and 1 moved scene 2 by a
  // fraction of a second, and `counted` read 31.6).
  const stood = run.said.filter(l => l.msg.includes('she stands still')).map(l => l.t).pop();
  const counting = played.filter(x => x.id === 's2-3').pop();
  if (stood === undefined || !counting) problems.push('she never counted');
  else {
    const half = counting.t + E_CUE - stood;
    // A walker who stood through the half minute hears it once they walk.
    if (p.lateCount ? half < 29 : Math.abs(half - 30) > (p.countSlack ?? 1)) problems.push(`"${E_WORDS.thirty}" came ${half.toFixed(1)} s after she stopped, wanted 30`);
    // In English she counts the seconds as they pass (v49): where she counts
    // whole, each number up to thirty falls that many seconds after her stop.
    const cnt = played.filter(x => x.id === 's2-count').pop();
    if (ENGLISH && cnt && cnt.t > stood && !played.some(x => x.id === 's2-count-stop')) {
      for (const [id, x] of [['s2-count', cnt], ['s2-3', counting]]) {
        for (const [word, c] of Object.entries(EPISODE.cues[id] || {})) {
          const n = numberOf(word);
          const at = x.t + c - stood;
          if (n <= 30 && Math.abs(at - n) > COUNT_SLACK) problems.push(`"${word}" came ${at.toFixed(1)} s after she stopped, wanted ${n}`);
        }
      }
    }
  }

  // Her side. The tone never left on, and her own steps are never heard
  // (Henric 21/10): the shift's steps are the only steps on her side.
  let tone = false;
  for (const c of sideCalls) if (c.what === 'tone') tone = !!c.args[0];
  if (tone) problems.push('the lamp tone was left on');
  const step = sideCalls.find(c => c.what === 'walk' && c.args[0]);
  if (step) problems.push(`her steps (${step.args[0]}) at ${fmt2(step.t)}`);
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
  if (!(E_CUE > 0)) problems.push(`no measured cue for "${E_WORDS.thirty}" in s2-3`);
  // The windows open at the question's first word.
  for (const [id, word] of [['s0-ask1', E_WORDS.see], ['s0-yes1-b', E_WORDS.hear], ['s0-no1', E_WORDS.hear],
    ['s0-again1', E_WORDS.see], ['s0-again2', E_WORDS.hear], ['s1-again', E_WORDS.are], ['s2-ask', E_WORDS.stop],
    ['s4-never-1', E_WORDS.lastStop], ...(E_NOW ? [[E_NOW, E_WORDS.now]] : [])]) {
    // In English the questions' own windows open at her now instead, so its
    // cue is the one that counts there: without it the window opens at the
    // start of the take, before she says the word.
    if (!(((EPISODE.cues || {})[id] || {})[word] > 0)) problems.push(`no measured cue for "${word}" in ${id}`);
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
  if (ENGLISH) {
    const problems = countProblems(EPISODE, E_OPTS.countBreath);
    console.log(problems.length ? `FAIL: the count: ${problems.join('; ')}` : 'OK: the count, a second a number from twelve to thirty');
    if (problems.length) failures++;
  }
  const heard = new Set();
  let nearlyBack = 0;
  // GLIMT_TIMELINE=<file>: each walker's lines with their exact start and
  // length, and the scene marks, for measuring the silence between them.
  const timeline = {};
  for (const name of Object.keys(EPISODE_WALKERS)) {
    if (onlyProfile && onlyProfile !== name) continue;
    const run = await simulateEpisode(name);
    run.played.forEach(x => heard.add(x.id));
    timeline[name] = {
      lines: run.played.map(x => ({ id: x.id, t: x.t, side: x.side, seconds: E_SECONDS[x.id], brokeAt: x.brokeAt ?? null })),
      marks: run.said.map(x => ({ t: x.t, msg: x.msg })),
      credits: run.credited,
    };
    console.log(`\n=== episode 1${ENGLISH ? ' (en)' : ''} / ${name} — ${run.ended ? 'ended at ' + Math.round(run.t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
    console.log(run.log.join('\n'));
    const problems = episodeProblems(name, run);
    if (run.nearlyBack) nearlyBack++;
    if (!run.ended) problems.unshift('did not end');
    // A known walker still has to run the episode to its end: a crash or a
    // hang is never the known finding.
    const known = walker(name).known;
    const broken = problems.filter(x => x === 'did not end' || x === 'the script threw' || x.startsWith('reached '));
    if (known && !broken.length) {
      if (!problems.length) { failures++; console.log(`FAIL: passes now, take away its known (${known})`); continue; }
      // The known failure is locked to its problems, so a new one beside it
      // still fails the suite instead of hiding in the KNOWN line.
      const expected = walker(name).knownProblems || [];
      const added = problems.filter(x => !expected.includes(x));
      const gone = expected.filter(x => !problems.includes(x));
      if (added.length || gone.length) {
        failures++;
        console.log(`FAIL: the known failure changed (${known})${added.length ? `; new: ${added.join('; ')}` : ''}${gone.length ? `; no longer: ${gone.join('; ')}` : ''}`);
        continue;
      }
      console.log(`KNOWN: ${known} (${problems.join('; ')})`);
      continue;
    }
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
  if (process.env.GLIMT_TIMELINE) writeFileSync(process.env.GLIMT_TIMELINE, JSON.stringify(timeline, null, 1));
  return failures;
}

// ?luft= (v48): the English pauses from none to three times their length.
// The same walkers still get their branches and her half minute, the pause
// before "s1-2" follows the factor, her "Now." after a question keeps its
// breath (the answer window is counted from it), more air makes a longer
// walk, and the stretch where a stop lights the lamp (off the gravel to
// scene 3) is no longer than at the standard (review of v48).
const AIR_WALKERS = ['listen', 'asked'];
const AIR_FACTORS = [0, 0.5, 2, 3];

// From "off the gravel" to the lamp or scene 3, whichever is first: where a
// stop of the walker's lights the lamp. After it has lit there is no more to.
function exposedFor(run) {
  const from = run.said.find(x => x.msg === 'scene 2: off the gravel');
  const to = run.said.find(x => x.msg.startsWith('scene 2: lamp') || x.msg.startsWith('scene 3: '));
  return from && to ? to.t - from.t : null;
}

function gapBefore(run, id) {
  const lines = run.played.filter(x => !x.side);
  const i = lines.findIndex(x => x.id === id);
  if (i < 1) return null;
  const prev = lines[i - 1];
  return lines[i].t - (prev.t + (prev.brokeAt ?? E_SECONDS[prev.id]));
}

async function airMain() {
  let failures = 0;
  for (const name of AIR_WALKERS) {
    const base = await simulateEpisode(name, withAir(EPISODE_EN, 1));
    let prevLength = null;
    const exposed1 = exposedFor(base);
    for (const f of [...AIR_FACTORS.filter(x => x < 1), 1, ...AIR_FACTORS.filter(x => x > 1)]) {
      const run = f === 1 ? base : await simulateEpisode(name, withAir(EPISODE_EN, f));
      const problems = run.ended ? episodeProblems(name, run) : ['did not end'];
      // Heard, the pause is the breath and what the sim adds to every line
      // (its end up to half a second late, the waiter's 0.25 s ticks), so it
      // is measured against the same walker at luft 1.
      const want = EPISODE_EN.gaps['s1-2'] * (f - 1);
      const gap = gapBefore(run, 's1-2'), gap1 = gapBefore(base, 's1-2');
      if (gap === null || Math.abs(gap - gap1 - want) > 0.5) problems.push(`the pause before s1-2 was ${gap?.toFixed(2)} s, ${gap1?.toFixed(2)} at luft 1: wanted ${want.toFixed(2)} s more`);
      // Less than one of the waiter's ticks: a scaled breath (0.2 or 0.8 s) moves it a tick or two.
      const now = gapBefore(run, EPISODE_EN.now), now1 = gapBefore(base, EPISODE_EN.now);
      if (now === null || Math.abs(now - now1) > 0.2) problems.push(`the breath before "Now." was ${now?.toFixed(2)} s at luft ${f}, ${now1?.toFixed(2)} at 1`);
      if (prevLength !== null && !(run.t > prevLength)) problems.push(`luft ${f} made the walk ${Math.round(run.t)} s, no longer than ${Math.round(prevLength)} s`);
      const exposed = exposedFor(run);
      if (exposed === null || (f > 1 && exposed > exposed1 + 0.5)) problems.push(`she was exposed ${exposed?.toFixed(1)} s at luft ${f}, ${exposed1?.toFixed(1)} at 1`);
      prevLength = run.t;
      console.log(`\n=== episode 1 (en) at luft ${f} / ${name} — ${run.ended ? 'ended at ' + Math.round(run.t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
      if (problems.length) failures++;
      console.log(problems.length ? `FAIL: ${problems.join('; ')}` : `OK: the same branches, ${gap.toFixed(2)} s before s1-2, "Now." after ${now.toFixed(2)} s`);
    }
  }
  return failures;
}

async function main() {
  const episodeOnly = process.argv[2] === 'e1' || ENGLISH;
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
  if (ENGLISH && !onlyProfile && LUFT === 1) failures += await airMain();
  process.exit(failures ? 1 : 0);
}

main();
