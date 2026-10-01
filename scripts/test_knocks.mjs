#!/usr/bin/env node
// Unit cases for the knock detector in glimt/engine.js: what counts as a
// double knock and what does not. The sensor is a flat 9.81 at 50 Hz with a
// one-sample spike per knock; settle() runs four times a second like the
// walk's tick.
//
//   node scripts/test_knocks.mjs

import { Knocks, Walk, simulatedMagnitude } from '../glimt/engine.js';

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

// Running began: the doubles just before the band caught up are retracted.
const r = run([2, 2.3, 6, 6.3], { seconds: 8 });
r.retract(5);
check(r.history.length === 1 && r.lastDoubleAt() < 3, 'retract forgets the doubles after its time, keeps the earlier');

check((() => { const q = run([2, 2.3, 6, 6.3], { seconds: 8 }); q.retract(1, d => d > 5); return q.history.length === 1 && q.history[0] < 3; })(),
  'retract spares the doubles its test does not pick');

// Through the Walk: a double knocked standing still survives a run that
// starts four seconds later; the retraction is for doubles heard on the move.
{
  const walk = new Walk();
  const speedAt = u => u < 20 ? 1.4 : u < 30 ? 0 : 3.2;
  for (let i = 0; i <= 45 * 50; i++) {
    const u = i / 50;
    let m = simulatedMagnitude(u, speedAt(u));
    if (Math.abs(u - 26) < 1e-9 || Math.abs(u - 26.3) < 1e-9) m += 8;
    walk.motion(u, m);
    if (i % 12 === 0 && i > 0) walk.tick(u);
  }
  const s = walk.state();
  check(s.band === 'run', `the walker ended up running (${s.band})`);
  check(walk.knocks.history.some(d => d > 25.9 && d < 26.5), `the standing double is kept (${walk.knocks.history.map(d => d.toFixed(1)).join(', ') || 'none'})`);
}

// A gap in the sensor (backgrounded tab) does not make a spike out of the jump.
const gap = new Knocks();
gap.push(0, 9.81); gap.push(0.02, 9.81); gap.push(5, 30); gap.push(5.02, 9.81); gap.push(5.04, 9.81);
check(gap.spikes.length === 0, 'the first sample after a gap is not judged against the old one');

// A pocket like the first recorded one (2026-09-28): 118 steps a minute, a
// sharp heel strike of 4-12 on every step. Through the Walk, so the sway
// decides which bar applies.
function pocket({ knocks = [], stillFrom = Infinity, seconds = 40, seed = 7, bigEvery = 0 } = {}) {
  let r = seed; const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const walk = new Walk();
  const HZ = 60, cad = 118;
  let phase = 0, stepNo = -1;
  for (let i = 0; i <= seconds * HZ; i++) {
    const u = i / HZ;
    let m = 9.81 + (rand() - 0.5) * 0.3;
    if (u < stillFrom) {
      phase += cad / 60 / HZ;
      m += 3 * Math.sin(2 * Math.PI * phase);
      if (Math.floor(phase) !== stepNo) {
        stepNo = Math.floor(phase);
        m += bigEvery && stepNo % bigEvery === 0 ? 17 + rand() * 28 : 4 + rand() * 8;
      }
    }
    for (const k of knocks) if (Math.round(k.t * HZ) === i) m += k.height;
    walk.motion(u, m);
    if (i % 15 === 0 && i > 0) walk.tick(u);
  }
  return walk;
}
{
  const w = pocket();
  check(w.knocks.history.length === 0, `heel strikes of 4-12 walking make no double (${w.knocks.history.length})`);
  check(w.knocks.count === 0, `nor a single knock (${w.knocks.count})`);
}
// Brisk, as in Takten "fortare": now and then one strike of 17-45, over the
// walking bar. Single hard strikes are single knocks, never a double: the
// next step is further off than a double's 0.4 s.
{
  const w = pocket({ bigEvery: 5, seconds: 60 });
  check(w.knocks.history.length === 0, `a hard strike every fifth step makes no double (${w.knocks.history.length}, ${w.knocks.count} single knocks)`);
}
{
  const w = pocket({ knocks: [{ t: 20, height: 20 }, { t: 20.2, height: 40 }] });
  check(w.knocks.history.length === 1, `a double walking with one hard blow is heard (${w.knocks.history.length})`);
}
{
  const w = pocket({ knocks: [{ t: 20, height: 8 }, { t: 20.2, height: 8 }] });
  check(w.knocks.history.length === 0, 'a light double walking is not, the heel strikes are as hard');
}
// Turning round in labb 2 (2026-10-01): two heel strikes of 16.6 and 15.9,
// 0.14 s apart, over the walking bar both. Neither is hard.
{
  const w = pocket({ knocks: [{ t: 20, height: 17 }, { t: 20.14, height: 16 }] });
  check(w.knocks.history.length === 0, `two firm strikes close together are not a double (${w.knocks.history.length})`);
  check(w.knocks.countBetween(19.9, 20.3) === 2, `but both were knocks, so the walking bar did not decide it (${w.knocks.countBetween(19.9, 20.3)})`);
}
// The hard blow a sample or two after a softer one is the same knock
// (inside KNOCK_GAP); its height still counts for the double (review).
{
  const w = pocket({ knocks: [{ t: 20, height: 17 }, { t: 20.07, height: 40 }, { t: 20.3, height: 17 }] });
  check(w.knocks.history.length === 1, `a hard blow just after a soft one makes the double hard (${w.knocks.history.length})`);
}
// Standing, nothing changes: soft doubles count, as the bar there is low.
{
  const w = pocket({ stillFrom: 10, seconds: 25, knocks: [{ t: 15, height: 8 }, { t: 15.3, height: 8 }] });
  check(w.knocks.history.length === 1, `a soft double standing is still heard (${w.knocks.history.length})`);
}
// Hon knackar: standing, three light knocks back at a gait's spacing. Read
// as steps they once looked like walking and the third was lost.
{
  const w = pocket({ stillFrom: 10, seconds: 25, knocks: [15, 15.45, 15.9].map(t => ({ t, height: 8 })) });
  check(w.knocks.countBetween(14, 17) === 3, `three light knocks standing all count (${w.knocks.countBetween(14, 17)})`);
}

process.exit(failures ? 1 : 0);
