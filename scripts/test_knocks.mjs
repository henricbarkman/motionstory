#!/usr/bin/env node
// Unit cases for the knock detector in glimt/engine.js: what counts as a
// double knock and what does not. The sensor is a flat 9.81 at 50 Hz with a
// one-sample spike per knock; settle() runs four times a second like the
// walk's tick.
//
//   node scripts/test_knocks.mjs

import { Knocks } from '../glimt/engine.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

// Feeds `seconds` of sensor with spikes at `knocks` (seconds), muted over
// `mute` = [from, to] if given. Returns the detector.
function run(knocks, { seconds = 8, height = 8, mute = null } = {}) {
  const k = new Knocks();
  const hits = knocks.map(t => Math.round(t * 50));
  for (let i = 0; i <= seconds * 50; i++) {
    const t = i / 50;
    if (mute && Math.abs(t - mute[0]) < 1e-9) k.mute(mute[1]);
    k.push(t, 9.81 + (hits.includes(i) ? height : 0));
    if (i % 12 === 0) k.settle(t);
  }
  return k;
}

const doubles = k => k.history.length;

check(doubles(run([2])) === 0, 'one knock is not a double');
check(doubles(run([2, 2.3])) === 1, 'two knocks 0.3 s apart are a double');
check(doubles(run([2, 2.3, 2.6])) === 1, 'three quick knocks are one double');
check(doubles(run([2, 2.3, 2.6, 2.9])) === 0, 'four quick knocks are a rhythm, not a double');
check(doubles(run([2, 3.5])) === 0, 'two knocks 1.5 s apart are two singles');
check(doubles(run([2, 2.3, 4.5, 4.8])) === 2, 'a retry after a pause counts again');
check(doubles(run([1.2, 2.1, 2.4])) === 0, 'a pair right after a knock is not alone');
check(doubles(run([2, 2.04])) === 0, 'a bounce inside the gap is one knock');
check(doubles(run([2, 2.3], { height: 2 })) === 0, 'spikes below the threshold do not count');
check(run([2, 2.3], { height: 2 }).spikes.length === 2, 'but they are logged as spikes');

// Steps: a loud heel strike every half second for ten seconds.
const steps = [];
for (let t = 1; t < 11; t += 0.5) steps.push(t);
check(doubles(run(steps, { seconds: 13 })) === 0, 'twenty steady heel strikes give no double');
// Walk, stop, then knock: the knock has its quiet and counts.
check(doubles(run([...steps, 13, 13.3], { seconds: 15 })) === 1, 'a double after the steps stop counts');

// Muted (the phone vibrating): nothing counts, spikes are still logged.
const muted = run([2, 2.3], { mute: [1.5, 3] });
check(doubles(muted) === 0 && muted.count === 0 && muted.spikes.length === 2, 'muted knocks are logged but not counted');

// Settled by the tick alone: the double lands without a knock after it.
const k = run([2, 2.3], { seconds: 3.5 });
check(k.lastDoubleAt() > 2.2 && k.lastDoubleAt() < 2.4, `the tick closes the group (${k.lastDoubleAt()})`);
// Not before the pair window has passed.
check(doubles(run([2, 2.3], { seconds: 2.9 })) === 0, 'no double before the window closes');

// A gap in the sensor (backgrounded tab) does not make a spike out of the jump.
const gap = new Knocks();
gap.push(0, 9.81); gap.push(0.02, 9.81); gap.push(5, 30); gap.push(5.02, 9.81); gap.push(5.04, 9.81);
check(gap.spikes.length === 0, 'the first sample after a gap is not judged against the old one');

process.exit(failures ? 1 : 0);
