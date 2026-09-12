#!/usr/bin/env node
// Runs chapter 1 against the contact engine with a simulated walker and a
// fake clock. No audio, no DOM. Prints the scene log with timestamps and
// checks that every scene fired in order.
//
//   node scripts/test_glimt.mjs            # all profiles
//   node scripts/test_glimt.mjs ideal      # one profile

import { Walk, Waiter } from '../glimt/engine.js';
import { runChapter1 } from '../glimt/chapter1.js';

const LINE_SECONDS = {
  s0: 16, s1a: 24, s1b: 24,
  's2a-stop-1': 4, 's2a-stop-2': 8, 's2a-resume': 5, 's2a-ask-1': 5, 's2a-ask-2': 10,
  's2b-stop-1': 7, 's2b-resume': 6, 's2b-ask-1': 5, 's2b-ask-2': 9,
  's3-1': 6, 's3-light': 5, 's3-dark': 5, 's3-2': 6, 's3-rain': 6, 's3-dry': 5,
  's4a-1': 9, 's4a-up': 8, 's4a-noup': 5, 's4b-1': 9, 's4b-up': 4, 's4b-noup': 6,
  s5: 16, 's6-vatten': 18, 's6-skog': 18, 's6-berg': 18, 's6-bro': 18, 's6-kyrkogard': 18,
  s7a: 20, s7b: 16, 's7-other': 3,
};

// Walker profiles: speed (m/s) as a function of t, plus a heading so the
// distance to start is real. Each returns {speed, heading}.
const PROFILES = {
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
};

function simulate(name, variant) {
  const profile = PROFILES[name];
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  let t = 0;
  let lat = 59.38, lon = 13.5;
  let playing = null;     // {until}
  let ended = false;

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const ctx = {
    variant,
    world: { light: 'dark', rain: false, landmark: 'skog' },
    state: () => walk.state(),
    log: msg => log.push(`${fmt(t)}  ${msg}  (contact ${walk.contact.value.toFixed(2)}, ${walk.tempo.band})`),
    hold: on => { walk.contact.hold = on; },
    play(id) {
      const dur = LINE_SECONDS[id];
      if (dur === undefined) throw new Error(`unknown line ${id}`);
      log.push(`${fmt(t)}  ▶ ${id}`);
      return waiter.until(() => false, { timeout: dur }).then(() => {});
    },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => waiter.until(() => false, { timeout: s }).then(() => {}),
    playQuiet(id) { log.push(`${fmt(t)}  ▶ ${id} (quiet)`); return Promise.resolve(); },
  };

  const done = runChapter1(ctx).then(() => { ended = true; }, err => { log.push(`ERROR ${err.message}`); ended = true; });

  // Drive the clock: one GPS fix per second, four ticks per second, and let
  // the microtask queue drain between ticks so awaits inside the chapter
  // script get to run.
  return (async () => {
    while (!ended && t < 20 * 60) {
      const { speed, heading, accuracy = 8 } = profile(t);
      if (Number.isInteger(t)) {
        const dLat = (speed * Math.cos(heading)) / 111320;
        const dLon = (speed * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        lat += dLat; lon += dLon;
        walk.fix(t, { latitude: lat, longitude: lon, accuracy, speed: speed + (Math.random() - 0.5) * 0.2 });
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

const order = ['scene 1', 'scene 2', 'scene 3', 'scene 4', 'scene 5', 'scene 6', 'scene 7', 'end'];

// Manuscript target times (seconds) for the scenes that have a fixed earliest
// moment. With good GPS they must fire within a window after that moment,
// never before it. The fog profile is exempt: there the clock fallback rules.
const TARGETS = { 'scene 3': 210, 'scene 4': 285, 'scene 5': 405, 'scene 6': 495 };
const WINDOW = 45;

function timingErrors(log) {
  const errors = [];
  for (const [label, target] of Object.entries(TARGETS)) {
    const line = log.find(l => l.includes(label) && !l.includes('▶'));
    if (!line) { errors.push(`${label} missing`); continue; }
    const [m, s] = line.trim().split(/\s+/)[0].split(':').map(Number);
    const t = m * 60 + s;
    if (t < target || t > target + WINDOW) errors.push(`${label} at ${line.trim().split(/\s+/)[0]}, wanted ${target}-${target + WINDOW} s`);
  }
  return errors;
}

async function main() {
  const only = process.argv[2];
  let failures = 0;
  for (const name of Object.keys(PROFILES)) {
    if (only && only !== name) continue;
    for (const variant of ['a', 'b']) {
      const { log, ended, t } = await simulate(name, variant);
      console.log(`\n=== ${name} / variant ${variant.toUpperCase()} — ${ended ? 'ended at ' + Math.round(t / 60 * 10) / 10 + ' min' : 'DID NOT END'}`);
      console.log(log.join('\n'));
      let pos = 0;
      for (const line of log) {
        if (pos < order.length && line.includes(order[pos])) pos++;
      }
      const timing = name === 'fog' ? [] : timingErrors(log);
      const ok = ended && pos === order.length && !log.some(l => l.startsWith('ERROR')) && timing.length === 0;
      if (!ok) failures++;
      console.log(ok ? 'OK: all scenes in order and on time'
        : `FAIL: reached ${pos}/${order.length}${timing.length ? '; ' + timing.join('; ') : ''}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
