#!/usr/bin/env node
// Unit cases for the jump reader in glimt/engine.js (Jumps, Hoppet): what is
// a jump and what is not, and that a landing is no knock. The pocket is the
// lab simulation's (scripts/test_lab.mjs): a step wave, a heel strike per
// step, noise, at 50 Hz, ticked four times a second like the walk.
//
//   node scripts/test_jumps.mjs

import { Walk, Jumps, cadencePace, JUMP_DEAF } from '../glimt/engine.js';
import { hopAt as hop } from './sim_pocket.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

let seed = 11;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const hopAt = (t, t0, air, opts) => hop(t, t0, air, { ...opts, random: rand });
const cadenceFor = v => { let c = 60; while (c < 220 && cadencePace(c) < v) c++; return c; };

// `seconds` of a walker at `speed` (0 stands), with `hops` [{t, air, ...}],
// `knocks` [{t, height}] one sample each, and `override(t)` for anything else
// (null leaves the pocket). Returns the walk and the jumps read as they were
// read (the tick they showed on).
function walkWith({ seconds = 60, speed = 1.4, hops = [], knocks = [], override = null, read = true, every = 12 } = {}) {
  const walk = new Walk();
  if (!read) walk.jumps.push = () => null;
  const cadence = speed > 0.3 ? cadenceFor(speed) : 0;
  let phase = 0, stepNo = -1, hard = 1;
  const seen = [];
  let last = -Infinity, shown = 0;
  for (let i = 0; i <= seconds * 50; i++) {
    const t = i / 50;
    phase += cadence / 60 / 50;
    let m = 9.81 + (rand() - 0.5) * 0.3;
    if (cadence) {
      m += (speed > 2 ? 6 : 3) * Math.sin(2 * Math.PI * phase);
      if (Math.floor(phase) !== stepNo) { stepNo = Math.floor(phase); hard = 0.6 + rand() * 0.8; }
      const dp = ((phase % 1) + 1.25) % 1 - 0.5, dt = dp * 60 / cadence;
      const [h, sigma] = speed > 2 ? [10, 0.02] : [4, 0.025];
      m += hard * h * Math.exp(-(dt * dt) / (2 * sigma * sigma));
    }
    for (const h of hops) { const x = hopAt(t, h.t, h.air, h); if (x !== null) m = x; }
    const o = override && override(t);
    if (o !== null && o !== undefined) m = o;
    for (const k of knocks) if (Math.round(k.t * 50) === i) m += k.height;
    walk.motion(t, m);
    if (i % every === 0) {
      const s = walk.tick(t);
      shown = Math.max(shown, walk.knocks.history.length);
      if (s.lastJumpAt > last) { last = s.lastJumpAt; seen.push(walk.jumps.history[walk.jumps.history.length - 1]); }
    }
  }
  return { walk, seen, shown };
}
const f2 = x => x.toFixed(2);
const longest = walk => walk.jumps.falls.reduce((a, f) => Math.max(a, f.air), 0);

// Walking and jogging, nothing else: no jump.
{
  const { walk } = walkWith({ seconds: 120 });
  check(walk.jumps.count === 0, `two minutes walking are no jump (longest fall ${f2(longest(walk))} s)`);
  const run = walkWith({ seconds: 120, speed: 3.0 }).walk;
  check(run.jumps.count === 0, `two minutes of this sim's jog are no jump either (longest fall ${f2(longest(run))} s; a real run's is not known)`);
}

// Hops of 5 and 10 cm walking: read, with the right time in the air, on the
// landing's first sample.
{
  const { walk, seen } = walkWith({ hops: [{ t: 20, air: 0.20 }, { t: 40, air: 0.29 }] });
  const [a, b] = walk.jumps.history;
  check(walk.jumps.count === 2, `a 5 cm and a 10 cm hop walking are two jumps (${walk.jumps.count})`);
  check(a && Math.abs(a.air - 0.20) < 0.03 && b && Math.abs(b.air - 0.29) < 0.03, `with their time in the air (${a && f2(a.air)}, ${b && f2(b.air)})`);
  check(a && a.t - (20 + a.air) < 0.05, `read as the landing hits (${a && f2(a.t - 20 - 0.2)} s after it)`);
  check(a && a.landing >= 30, `and the landing's height is kept (${a && a.landing.toFixed(0)})`);
  check(seen.length === 2, 'state.lastJumpAt tells each on the next tick');
}

// A hop from standing, and the lowest a hop can be.
{
  const { walk } = walkWith({ speed: 0, hops: [{ t: 10, air: 0.22 }] });
  check(walk.jumps.count === 1, `a hop from standing is a jump (${walk.jumps.count})`);
  const low = walkWith({ hops: [{ t: 20, air: 0.19 }] }).walk;
  check(low.jumps.count === 1, `so is a skip of 4,5 cm, 0,19 s in the air (${low.jumps.count})`);
}

// What is no jump: a dip as long as the gait's longest (0,134 s in the nine
// recordings), and a fall that does not land (the phone lowered in a hand,
// back to gravity over half a second, never over 15).
{
  const dip = walkWith({ hops: [{ t: 20, air: 0.14 }] }).walk;
  check(dip.jumps.count === 0, `0,14 s in the air is a gait's dip, no jump (${dip.jumps.count})`);
  check(dip.jumps.falls.some(f => Math.abs(f.air - 0.14) < 0.03), 'but the fall is kept for the log');
  const lowered = walkWith({ speed: 0, override: t => t >= 10 && t < 10.3 ? 2 : t >= 10.3 && t < 10.8 ? 2 + (t - 10.3) * 15.6 : null }).walk;
  check(lowered.jumps.count === 0, `a fall that never lands is no jump (${lowered.jumps.count})`);
  const late = walkWith({ speed: 0, override: t => t >= 10 && t < 10.3 ? 2 : t >= 10.3 && t < 10.7 ? 9.81 : t >= 10.7 && t < 10.72 ? 40 : null }).walk;
  check(late.jumps.count === 0, `nor one whose blow comes 0,4 s after it (${late.jumps.count})`);
  // A gap in the samples ends a fall: what the phone felt meanwhile is not known.
  const j = new Jumps();
  j.push(0, 9.8); j.push(0.02, 2); j.push(0.04, 2); j.push(0.3, 2); j.push(0.32, 30);
  check(j.count === 0, `a fall across a gap in the samples is no jump (${j.count})`);
}

// The landing is no knock. Walking, the landing (35) and the step after it
// (22, a quarter second on) are a pair of blows harder than his knocks; the
// push-off before is a third. Standing, the bar is 3.
{
  for (const [label, speed] of [['walking', 1.4], ['standing', 0]]) {
    const hops = [{ t: 20, air: 0.22 }, { t: 35, air: 0.25, landing: 45, second: 30 }];
    const { walk, shown } = walkWith({ speed, hops, seconds: 45 });
    const near = h => walk.knocks.countBetween(h.t - 1, h.t + h.air + 1.5);
    check(walk.jumps.count === 2, `${label}: both hops read (${walk.jumps.count})`);
    check(walk.knocks.history.length === 0, `${label}: no double knock from a landing (${walk.knocks.history.map(f2).join(', ') || 'none'})`);
    check(hops.every(h => near(h) === 0), `${label}: no knock at all around a hop (${hops.map(near).join(', ')})`);
    check(shown === 0, `${label}: not even for a moment, mid-flight (${shown})`);
    // The same walk without the jump reader: the landings are doubles.
    const deaf = walkWith({ speed, hops, seconds: 45, read: false }).walk;
    check(deaf.knocks.history.length > 0, `${label}: without the jump reader the landings are double knocks (${deaf.knocks.history.length})`);
  }
}

// A double knocked just before a high hop (the hands on the phone as he
// pushes off) closes its group mid-flight. The knocks wait for the landing,
// which forgets it, so it never shows, not even between two ticks.
{
  for (const [label, speed, h] of [['walking', 1.4, 30], ['standing', 0, 8]]) {
    const knocks = [{ t: 19.6, height: h }, { t: 19.85, height: h }];
    const { walk, shown } = walkWith({ speed, hops: [{ t: 20.05, air: 0.45 }], knocks, seconds: 30, every: 1 });
    check(walk.jumps.count === 1 && shown === 0, `${label}: a push-off double never shows during a long flight (${walk.jumps.count} jumps, shown ${shown})`);
  }
}

// A soft landing, under the landing bar: no jump, but still a flight, and
// the push-off and the landing are no knock either.
{
  for (const [label, speed] of [['walking', 1.4], ['standing', 0]]) {
    const { walk } = walkWith({ speed, hops: [{ t: 20, air: 0.24, landing: 12, second: 3 }], seconds: 30 });
    check(walk.jumps.count === 0 && walk.jumps.flights === 1, `${label}: a soft landing is a flight, not a jump (${walk.jumps.count} jumps, ${walk.jumps.flights} flights)`);
    check(walk.knocks.history.length === 0 && walk.knocks.countBetween(19, 21.5) === 0, `${label}: and no knock around it (${walk.knocks.countBetween(19, 21.5)})`);
  }
}

// Sparse samples (a throttled sensor, 12 Hz): the air is the last sample
// under the bar and a little, not the whole interval after it.
{
  const j = new Jumps();
  for (let t = 0; t < 1; t += 0.08) j.push(t, 9.8);
  const t0 = 1.04;
  j.push(t0, 2); j.push(t0 + 0.08, 2); j.push(t0 + 0.16, 2);
  const got = j.push(t0 + 0.24, 30);
  check(got && got.air < 0.21, `sparse samples do not stretch the air (${got && f2(got.air)} s, the interval said 0.24)`);
}

// The longest fall that was no jump outlives the ten minutes `falls` keeps.
{
  const j = new Jumps();
  j.push(0, 9.8); j.push(0.02, 2);
  for (let i = 1; i <= 8; i++) j.push(0.02 + i * 0.02, 2);
  for (let t = 0.2; t < 700; t += 0.02) j.push(t, 9.8);
  j.push(700, 2); j.push(700.02, 2); j.push(700.04, 9.8);
  check(j.falls.every(f => f.t > 1) && Math.abs(j.longestFall() - 0.18) < 0.03, `an early long fall is still the longest after ten minutes (${f2(j.longestFall())} s)`);
}

// Which jumps nobody asked for: one taken as an answer, and one a skip's
// second within a second of it, are not; one long after is; while a
// question is open, none after it is.
{
  const j = new Jumps();
  j.history = [{ t: 10 }, { t: 10.6 }, { t: 20 }, { t: 30 }];
  check(j.unasked([10]).map(x => x.t).join() === '20,30', `an answer and its second skip are asked for (${j.unasked([10]).map(x => x.t).join()})`);
  check(j.unasked([10], 25).map(x => x.t).join() === '20', 'a jump after an open question is not counted as stray');
}

// Deaf for JUMP_DEAF only: a double knocked three seconds after a landing
// standing is heard.
{
  const { walk } = walkWith({ speed: 0, hops: [{ t: 10, air: 0.22 }], knocks: [{ t: 13.5, height: 8 }, { t: 13.8, height: 8 }] });
  check(JUMP_DEAF <= 1.5 && walk.knocks.history.some(d => d > 13 && d < 15), `a double three seconds after a landing is heard (${walk.knocks.history.map(f2).join(', ') || 'none'})`);
  check(walk.state().knocks === 2, `and the count of knocks leaves out the hop's (${walk.state().knocks})`);
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall jump cases ok');
