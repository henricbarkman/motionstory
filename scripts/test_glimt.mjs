#!/usr/bin/env node
// Runs a Glimt chapter against the contact engine with a simulated walker
// and a fake clock. No audio, no DOM. Prints the scene log with timestamps
// and checks that every scene fired in order and, for the scenes with a
// fixed earliest moment, on time.
//
//   node scripts/test_glimt.mjs               # both chapters, all profiles
//   node scripts/test_glimt.mjs 2             # chapter 2
//   node scripts/test_glimt.mjs 2 stubborn    # one profile

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter } from '../glimt/engine.js';
import { runChapter1 } from '../glimt/chapter1.js';
import { runChapter2 } from '../glimt/chapter2.js';

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

// Walker profiles: speed (m/s) as a function of t, plus a heading so the
// distance to start is real. Each returns {speed, heading, accuracy?, every?,
// doppler?}: `every` is seconds between fixes (default 1), `doppler: false`
// means the phone reports no speed of its own.
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
};

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
      let { speed, heading, accuracy = 8, every = 1, doppler = true } = p;
      if (forcedStop && t >= forcedStop.from && t < forcedStop.to) speed = 0;
      // The walker moves every second; the phone reports every `every` s.
      if (Number.isInteger(t)) {
        const dLat = (speed * Math.cos(heading)) / 111320;
        const dLon = (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        lat += dLat; lon += dLon;
        if (t % every === 0) {
          const v = doppler ? speed + (speed ? (Math.random() - 0.5) * 0.2 : 0) : null;
          walk.fix(t, { latitude: lat, longitude: lon, accuracy, speed: v });
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

async function main() {
  const onlyChapter = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const onlyProfile = process.argv[3];
  let failures = 0;
  for (const [no, ch] of Object.entries(CHAPTERS)) {
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
        const ok = ended && pos === ch.order.length && !log.some(l => l.startsWith('ERROR')) && problems.length === 0;
        if (!ok) failures++;
        console.log(ok ? 'OK: all scenes in order and on time'
          : `FAIL: reached ${pos}/${ch.order.length}${problems.length ? '; ' + problems.join('; ') : ''}`);
      }
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
