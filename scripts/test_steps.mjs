#!/usr/bin/env node
// Unit cases for the step detector's impacts in glimt/engine.js: how hard
// each step landed, which Tassa compares before and after it asks for soft
// steps. The sensor is simulatedMagnitude at 50 Hz.
//
//   node scripts/test_steps.mjs

import { Steps, Walk, simulatedMagnitude } from '../glimt/engine.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

// Walks at 1.4 m/s from `from` for `seconds`; returns the time after.
function walk(s, from, seconds) {
  let u = from;
  for (; u < from + seconds; u += 0.02) s.push(u, simulatedMagnitude(u, 1.4));
  return u;
}

// A walk gives one impact per step, all about as hard.
{
  const s = new Steps();
  walk(s, 0, 10);
  const peaks = s.impacts.map(i => i.peak);
  check(peaks.length >= 12, `ten seconds of walking gives impacts (${peaks.length})`);
  check(Math.max(...peaks) < 2 * Math.min(...peaks), `and they are alike (${Math.min(...peaks).toFixed(2)} to ${Math.max(...peaks).toFixed(2)})`);
}

// The sensor goes quiet in the middle of a step, then the phone settles in
// the pocket with a bump. The bump is not that step's impact: a review
// found it written in, stamped with the step's time (2026-09-25).
{
  const s = new Steps();
  let u = walk(s, 0, 6);
  while (!s.peak) { s.push(u, simulatedMagnitude(u, 1.4)); u += 0.02; }
  const cut = s.peak.t;
  const normal = Math.max(...s.impacts.map(i => i.peak));
  u += 1.3;
  for (let k = 0; k < 3; k++, u += 0.02) s.push(u, 9.81);
  for (let k = 0; k < 5; k++, u += 0.02) s.push(u, 9.81 + 12);
  for (let k = 0; k < 100; k++, u += 0.02) s.push(u, 9.81);
  const kept = s.impacts.find(i => i.t === cut);
  check(!kept, `the step cut by the gap is dropped (${kept ? `kept at ${kept.peak.toFixed(2)}, walking ${normal.toFixed(2)}` : 'dropped'})`);
  const inflated = s.impacts.filter(i => i.peak > 1.5 * normal);
  check(inflated.length === 0, `no impact after the gap is the bump (${inflated.map(i => i.peak.toFixed(2)).join(', ') || 'none'})`);
}

// The rhythm guard. Henric's pocket (2026-09-28) gave a second peak about
// 0.28 s into many steps; counted, it read 118 steps a minute as 150-170
// and the walker as running. Here every other step carries such a bump.
{
  const walk = new Walk();
  let maxCad = 0, ran = false;
  for (let i = 0; i <= 40 * 50; i++) {
    const u = i / 50;
    // 1.3 m/s is 117 a minute in the simulation, and a step is read about
    // 0.15 into its wave, so 0.28 s after that is 0.70 of the way through.
    const phase = 117 / 60 * u;
    let m = simulatedMagnitude(u, 1.3);
    if (Math.floor(phase) % 2 === 0 && phase % 1 >= 0.68 && phase % 1 < 0.74) m += 12;
    walk.motion(u, m);
    if (i % 12 === 0 && i > 0) {
      const s = walk.tick(u);
      if (u > 10) { maxCad = Math.max(maxCad, s.cadence); ran = ran || s.band === 'run'; }
    }
  }
  check(maxCad < 135 && !ran, `a bump inside every other step does not add steps (cadence up to ${Math.round(maxCad)}, ${ran ? 'ran' : 'never ran'})`);
}

// And it must not lock out a real change of gait: an amble straight into a
// sprint once read as the amble's cadence for a whole minute, every other
// footfall rejected (review, 2026-09-28).
for (const [v0, v1] of [[0.85, 3.8], [0.7, 4.5]]) {
  const walk = new Walk();
  let runAt = null, cad = 0;
  for (let i = 0; i <= 50 * 50; i++) {
    const u = i / 50;
    walk.motion(u, simulatedMagnitude(u, u < 20 ? v0 : v1));
    if (i % 12 === 0 && i > 0) {
      const s = walk.tick(u);
      if (u > 20 && s.band === 'run' && runAt === null) runAt = u - 20;
      cad = s.cadence;
    }
  }
  check(runAt !== null && runAt < 8 && cad > 180, `an amble at ${v0} m/s into a sprint at ${v1} reads as running (after ${runAt === null ? 'never' : runAt.toFixed(1) + ' s'}, cadence ${Math.round(cad)})`);
}

process.exit(failures ? 1 : 0);
