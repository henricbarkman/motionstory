#!/usr/bin/env node
// Unit cases for the step detector's impacts in glimt/engine.js: how hard
// each step landed, which Tassa compares before and after it asks for soft
// steps. The sensor is simulatedMagnitude at 50 Hz.
//
//   node scripts/test_steps.mjs

import { Steps, simulatedMagnitude } from '../glimt/engine.js';

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

process.exit(failures ? 1 : 0);
