#!/usr/bin/env node
// Unit cases for the knock detector in glimt/engine.js: what counts as a
// double knock and what does not. The sensor is a flat 9.81 at 50 Hz with a
// one-sample spike per knock; settle() runs four times a second like the
// walk's tick.
//
//   node scripts/test_knocks.mjs

import { Knocks, Sway, Walk, simulatedMagnitude, buzzReading } from '../glimt/engine.js';
import { labHelpers, knockPattern, buzzWords } from '../glimt/lab.js';

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
// decides which bar applies. `runFrom`: from then on the walker runs, 170
// steps a minute on a wave twice as high. `bumps`: a hand landing on the
// pocket at those times, 1.6 over 0.15 s (the lab simulation's handling). The
// bands the ticks saw come back as `walk.bands`.
function pocket({ knocks = [], stillFrom = Infinity, seconds = 40, seed = 7, bigEvery = 0, runFrom = Infinity, bumps = [] } = {}) {
  let r = seed; const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const walk = new Walk();
  const HZ = 60;
  let phase = 0, stepNo = -1;
  walk.bands = [];
  for (let i = 0; i <= seconds * HZ; i++) {
    const u = i / HZ;
    let m = 9.81 + (rand() - 0.5) * 0.3;
    if (u < stillFrom) {
      phase += (u < runFrom ? 118 : 170) / 60 / HZ;
      m += (u < runFrom ? 3 : 6) * Math.sin(2 * Math.PI * phase);
      if (Math.floor(phase) !== stepNo) {
        stepNo = Math.floor(phase);
        m += bigEvery && stepNo % bigEvery === 0 ? 17 + rand() * 28 : 4 + rand() * 8;
      }
    }
    for (const b of bumps) if (u >= b && u < b + 0.15) m += 1.6;
    for (const k of knocks) if (Math.round(k.t * HZ) === i) m += k.height;
    walk.motion(u, m);
    if (i % 15 === 0 && i > 0) walk.bands.push({ t: u, band: walk.tick(u).band });
  }
  return walk;
}
{
  const w = pocket();
  check(w.knocks.history.length === 0, `heel strikes of 4-12 walking make no double (${w.knocks.history.length})`);
  check(w.knocks.count === 0, `nor a single knock (${w.knocks.count})`);
}
// And a double heard on the move goes when a run begins right after it: the
// band trails the feet, so a run's first strikes are judged as walking.
{
  const knocks = [{ t: 14.5, height: 20 }, { t: 14.7, height: 40 }];
  const strolling = pocket({ knocks, seconds: 25 });
  check(strolling.knocks.history.length === 1, `a double with one hard blow is kept by a walker who walks on (${strolling.knocks.history.length})`);
  const sprinting = pocket({ knocks, seconds: 25, runFrom: 15 });
  const began = sprinting.bands.find(b => b.band === 'run');
  check(!!began && began.t - 14.7 < 6 && sprinting.knocks.history.length === 0,
    `and taken back when a run begins inside the cadence window (run read from ${began ? began.t.toFixed(2) : '-'}, ${sprinting.knocks.history.length} doubles)`);
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
// With a hand landing on the pocket a third of a second before them. The
// bump is read as a step, and with the first two knocks that is a rhythm of
// 150 steps a minute: a run, and running mutes knocks. The third was lost in
// nine of a hundred walks on the lab simulation's field phone (2026-10-06).
// A phone that does not sway is not running.
{
  const knocks = [15, 15.45, 15.9].map(t => ({ t, height: 8 }));
  const w = pocket({ stillFrom: 10, seconds: 25, knocks, bumps: [14.6] });
  const ran = w.bands.filter(b => b.band === 'run' && b.t > 14 && b.t < 18);
  check(ran.length > 0, `a hand on the pocket just before them makes the feet read a run (${ran.length} ticks, from ${ran.length ? ran[0].t.toFixed(2) : '-'})`);
  check(w.knocks.countBetween(14, 17) === 3, `and the three knocks all count still (${w.knocks.countBetween(14, 17)})`);
  check(w.knocks.history.some(d => d > 15.8 && d < 16), `as one answer (${w.knocks.history.map(d => d.toFixed(2)).join(', ') || 'none'})`);
}
// Standing is something the sway has to have seen. A sensor with nothing to
// tell yet is neither walking nor standing, so a run read from the GPS in
// that moment mutes as it did.
{
  const flat = new Sway(), gait = new Sway(), fresh = new Sway();
  for (let i = 0; i <= 120; i++) { flat.push(i / 60, 9.81); gait.push(i / 60, 9.81 + 3 * Math.sin(2 * Math.PI * 2 * i / 60)); }
  for (let i = 0; i < 10; i++) fresh.push(i / 60, 9.81);
  check(flat.standingAt(2) && !flat.walkingAt(2), 'a phone seen lying flat stands, and does not walk');
  check(gait.walkingAt(2) && !gait.standingAt(2), 'one swaying with a gait walks, and does not stand');
  check(!fresh.walkingAt(0.2) && !fresh.standingAt(0.2), 'a sensor ten samples old says neither');
  // Held over the phone's own buzz: what stood before it stands, either way.
  flat.hold(2, 3); gait.hold(2, 3);
  check(flat.standingAt(3.9) && !flat.walkingAt(3.9), 'standing before a buzz is standing right after it');
  check(gait.walkingAt(3.9) && !gait.standingAt(3.9), 'walking before a buzz is walking right after it');
  check(!flat.standingAt(4.2) && !gait.walkingAt(4.2), 'and the held verdict runs out a good second after');
}
// A real run mutes knocks as before: the phone sways. Two hard blows that
// are a double walking are nothing running.
{
  const knocks = [{ t: 30, height: 20 }, { t: 30.2, height: 40 }];
  const walking = pocket({ knocks });
  check(walking.knocks.countBetween(29.9, 30.4) === 2, `two hard blows walking are knocks (${walking.knocks.countBetween(29.9, 30.4)})`);
  const running = pocket({ knocks, runFrom: 15 });
  const around = running.bands.filter(b => b.t > 29 && b.t < 31);
  check(around.length > 0 && around.every(b => b.band === 'run'), `the same blows in a run, 170 steps a minute (${around.filter(b => b.band === 'run').length} of ${around.length} ticks read run)`);
  check(running.knocks.countBetween(29.9, 30.4) === 0 && running.knocks.history.length === 0, `are not, the run mutes them (${running.knocks.countBetween(29.9, 30.4)} knocks, ${running.knocks.history.length} doubles)`);
}
// A run read from the GPS mutes as before, however still the phone lies:
// that is wheels, and a road's bumps are sharp. Only a run the feet read is
// doubted when the phone does not sway.
{
  const rolling = speed => {
    const walk = new Walk();
    for (let i = 0; i <= 30 * 60; i++) {
      const u = i / 60;
      if (i % 60 === 0) walk.fix(u, { latitude: 59.38 + speed * u / 111320, longitude: 13.5, accuracy: 5, speed });
      walk.motion(u, 9.81 + (i === 1200 || i === 1218 ? 8 : 0));
      if (i % 15 === 0 && i > 0) walk.tick(u);
    }
    return walk;
  };
  const parked = rolling(0), riding = rolling(4);
  check(parked.knocks.countBetween(19.9, 20.4) === 2, `two knocks on a phone lying still count (${parked.knocks.countBetween(19.9, 20.4)})`);
  check(riding.state().band === 'run' && riding.state().paceSource === 'gps', `at 4 m/s on the GPS, with no feet, the band reads a run (${riding.state().band}, ${riding.state().paceSource})`);
  check(riding.knocks.countBetween(19.9, 20.4) === 0, `and the same knocks are muted, though the phone lies still (${riding.knocks.countBetween(19.9, 20.4)})`);
}

// Hon knackar with a motor the sensor feels. Standing, she buzzes twice at
// 15 s (180 ms on, 320 off), through the lab's own vibrate(), and the motor
// throws every other sample up and every other down by `shake` while it runs.
// One real motor has been recorded since (scripts/recordings/knackar-
// 2026-10-06.json): at most 0.6 between samples. Five stays, a hostile guess
// for motors nobody has measured. A real motor also starts late and
// rings on: `lag` and `ring`, in seconds. The walker knocks back twice,
// lightly, from `after` seconds past her last buzz as it was asked for.
// `guard`: 'buzz' is what the lab does, 'mute' only keeps the knock detector
// deaf (the sway and the feet still see the motor), 'none' neither. `gait`
// is a walker who never stopped (a step wave of that height all through, and
// no knocks back), `strike` a heel strike that long after the detector hears
// again.
function answered({ shake = 5, after = 0.7, guard = 'buzz', seed = 7, lag = 0, ring = 0, gait = 0, strike = null, fidget = 0 } = {}) {
  let r = seed; const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const walk = new Walk();
  const HZ = 60, pattern = knockPattern(2);
  // The stretches the motor runs, as asked from 15 s, and when her last ends.
  const asked = [];
  for (let i = 0, t = 15; i < pattern.length; t += (pattern[i] + (pattern[i + 1] || 0)) / 1000, i += 2) asked.push([t, t + pattern[i] / 1000]);
  const end = asked[asked.length - 1][1];
  let u = 0;
  const lab = labHelpers(walk, { now: () => u, vibrateImpl: () => true });
  // When the lab takes the motor to have stopped: asked of a walk of its own,
  // so the guards that leave the lab out are held to the same moment.
  const probe = labHelpers(new Walk(), { now: () => 15, vibrateImpl: () => true });
  probe.vibrate(pattern);
  const over = probe.buzzOver();
  const on = asked.map(([a, b]) => [a + lag, b + lag]);
  const knocks = gait ? [] : [end + after, end + after + 0.45];
  // stale: the longest the feet went without a sample while the motor ran;
  // at15: the sway's spread and the cadence as the buzz is asked for.
  let up = false, stale = 0, at15 = null;
  for (let i = 0; i <= 25 * HZ; i++) {
    u = i / HZ;
    if (i === 15 * HZ) at15 = { spread: walk.sway._spread(15), cadence: walk.steps.cadence(15) };
    if (i === 15 * HZ) { if (guard === 'buzz') lab.vibrate(pattern); else if (guard === 'mute') walk.knocks.mute(over); }
    let m = 9.81 + (rand() - 0.5) * 0.3 + gait * Math.sin(2 * Math.PI * 2 * u);
    if (u < 15) m += fidget * Math.sin(2 * Math.PI * u);   // once a second: slower than any gait
    const run = on.find(([a, b]) => u >= a && u < b + ring);
    if (run) { up = !up; const amp = u < run[1] ? shake : shake * (1 - (u - run[1]) / ring); m += up ? amp : -amp; }
    for (const k of knocks) if (Math.round(k * HZ) === i) m += 8;
    if (strike !== null && Math.round((over + strike) * HZ) === i) m += 8;
    walk.motion(u, m);
    if (u >= 15 && u < over) stale = Math.max(stale, u - walk.steps.lastT);
    if (i % 15 === 0 && i > 0) walk.tick(u);
  }
  return {
    walk, pattern, over, end, stale, at15, heard: walk.knocks.countBetween(over, 25), before: walk.knocks.countBetween(14, over),
    steps: walk.steps.times.filter(t => t >= 15 && t < over).length,
  };
}
{
  const a = answered();
  check(Math.abs(a.over - (a.end + 0.5)) < 0.01, `the lab takes the motor to have stopped half a second after her last buzz (${a.over.toFixed(2)}, last buzz ends ${a.end.toFixed(2)})`);
  check(a.heard === 2 && a.before === 0, `two knocks answered 0.7 s after her buzz both count, the motor's shake does not (${a.heard} heard, ${a.before} from the motor)`);
  check(a.walk.knocks.history.length === 0 || a.walk.knocks.history.every(d => d > a.over), `and the motor makes no double of its own (${a.walk.knocks.history.map(d => d.toFixed(2)).join(', ') || 'none'})`);
  // What each guard is there for: the same walk without it goes wrong.
  const noSway = answered({ guard: 'mute' });
  check(noSway.heard === 1, `with the motor left in the sway the first knock back is held to the walking bar and lost (${noSway.heard} heard)`);
  const none = answered({ guard: 'none' });
  check(none.before > 0, `with no mute the motor's shake counts as knocks (${none.before})`);
  // A motor the sensor does not feel, or an answer later than the sway
  // trails: nothing to guard against, and nothing lost.
  check(answered({ shake: 0 }).heard === 2, 'a motor the sensor does not feel changes nothing');
  check(answered({ after: 1.4 }).heard === 2, 'nor does an answer a good second later');
  // The margin after her last buzz, and its price.
  check(answered({ after: 0.55 }).heard === 2, 'an answer from half a second after the buzz counts in full');
  check(answered({ after: 0.4 }).heard === 1, `one sooner loses its first knock to the motor's margin (${answered({ after: 0.4 }).heard} heard)`);
  // A motor that starts late and rings on (review, 2026-10-06): with a
  // quarter second's margin its tail was a knock nobody knocked.
  for (const [shake, lag, ring] of [[10, 0.15, 0.2], [5, 0.2, 0.25], [12, 0.1, 0.3]]) {
    const late = answered({ shake, lag, ring });
    check(late.heard === 2 && late.before === 0, `a motor ${lag} s late that rings on for ${ring} s (shake ${shake}) adds no knock (${late.heard} heard)`);
  }
  // The motor is not feet either: each buzz rose like a step.
  const hard = answered({ shake: 10 });
  check(hard.steps === 0 && hard.heard === 2, `the buzz is not counted as steps (${hard.steps} steps while it ran, ${hard.heard} heard)`);
  check(answered({ shake: 10, guard: 'mute' }).steps > 0, `left alone a hard motor is (${answered({ shake: 10, guard: 'mute' }).steps} steps)`);
  check(hard.stale < 0.02 && hard.walk.sensorShare(15, hard.over) === 1, `and the feet are given a sample all through it, so the sensor counts as live (${hard.stale.toFixed(2)} s without)`);
  // A walker who never stopped: the sway is blind while the motor runs, and
  // the verdict from before stands, so a heel strike right after the buzz
  // meets the walking bar. Judged standing it was a knock (review).
  const strolling = answered({ gait: 3, strike: 0.17 });
  check(strolling.heard === 0, `a heel strike right after the buzz, walking, is no knock (${strolling.heard} heard)`);
  const stoodStruck = answered({ gait: 0, strike: 0.17, after: 5 });
  check(stoodStruck.walk.knocks.countBetween(stoodStruck.over, stoodStruck.over + 1) === 1, 'the same blow from a walker who stood still is one');
  // And the sway takes over again once it has been seen: a walker who stood
  // through the buzz and walks off after it is walking a good second later.
  check(a.walk.sway.standingAt(a.over + 0.2) && !a.walk.sway.walkingAt(a.over + 0.2), 'standing before the buzz, standing right after it');
  check(strolling.walk.sway.walkingAt(strolling.over + 0.2) && !strolling.walk.sway.standingAt(strolling.over + 0.2), 'walking before the buzz, walking right after it');
  // Standing, shifting from foot to foot as the buzz begins: the sway is
  // over a gait's, the feet are not going. Held as walking, her prompt first
  // knock met the walking bar and was lost (review, 2026-10-06).
  const fidgeting = answered({ fidget: 2 });
  check(fidgeting.at15.spread > 1 && fidgeting.at15.cadence === 0, `a walker standing and shifting about sways like a gait, with no steps (spread ${fidgeting.at15.spread.toFixed(2)}, ${fidgeting.at15.cadence} steps a minute)`);
  check(fidgeting.heard === 2, `and both knocks back count (${fidgeting.heard} heard)`);
  // A buzz with a time that is no number (a pattern of nothing) mutes nothing.
  const odd = new Walk();
  odd.buzz(15, NaN);
  check(odd.knocks.mutedUntil === -Infinity && odd.buzzUntil === -Infinity && odd.sway.held === null, 'a buzz until no time mutes nothing');

  // The reading of that buzz, for the log: restless while the motor runs,
  // quiet between and before. Samples jump by twice the shake.
  const seen = a.walk.buzzSeen(a.pattern, 15);
  check(seen.on > 8 && seen.on < 11 && seen.off < 0.3 && seen.before < 0.3 && seen.n >= 10, `the sensor's reading of the buzz: ${seen.before.toFixed(2)} before, ${seen.on.toFixed(2)} while it ran, ${seen.off.toFixed(2)} between (${seen.n} steps)`);
  const flat = answered({ shake: 0 }).walk.buzzSeen(a.pattern, 15);
  check(Math.abs(flat.on - flat.off) < 0.08 && flat.on < 0.3, `a phone that never buzzed reads the same while and between (${flat.on.toFixed(2)}, ${flat.off.toFixed(2)})`);
  // A late motor lands in the pauses; against the level before it shows
  // wherever it landed.
  const lateSeen = answered({ shake: 5, lag: 0.2, ring: 0.25 }).walk.buzzSeen(a.pattern, 15);
  check(lateSeen.off > lateSeen.on && Math.max(lateSeen.on, lateSeen.off) > 10 * lateSeen.before, `a motor 0.2 s late reads as between, and still far over the level before (${lateSeen.before.toFixed(2)} before, ${lateSeen.on.toFixed(2)}, ${lateSeen.off.toFixed(2)})`);
  check(buzzWords({ before: 0.02, on: 2.99, off: 0.01, n: 20 }) === 'sensorn 0,02 före, 2,99 under surren, 0,01 emellan', 'the reading in the log\'s words');
  check(buzzWords({ before: null, on: 2.99, off: 0.01, n: 20 }) === 'sensorn 2,99 under surren, 0,01 emellan', 'without a level before when the sensor had not started');
  check(buzzWords({ before: 0.02, on: 2.99, off: 0.01, n: 5 }) === 'sensorn gav för få värden' && buzzWords(null) === 'sensorn gav för få värden', 'and nothing from too few samples');
}
// buzzReading by itself: which samples count as while and as between.
{
  // Samples half a step off the round times, so none sits on a window's edge.
  const flatAt = (from, to, hz = 100) => Array.from({ length: Math.round((to - from) * hz) }, (_, i) => ({ t: from + (i + 0.5) / hz, m: 9.81 }));
  const pattern = [200, 300, 200];
  // One jump of 2 inside the first buzz, one of 4 in the pause, one of 8
  // right as the motor starts and one as it stops: the last two are neither.
  const s = flatAt(0, 2);
  const jump = (t, by) => { for (const x of s) if (x.t >= t) x.m += by; };
  jump(0.02, 8); jump(0.1, 2); jump(0.25, 8); jump(0.4, 4);
  const r = buzzReading(s, pattern, 0);
  const steps = (mean, n) => Math.round(mean * n * 100) / 100;
  check(r.on !== null && r.off !== null, 'a flat trace with jumps gives a reading');
  // While: [0.05, 0.2] and [0.55, 0.7], 15 samples each, so 14 steps each.
  // Between: [0.3, 0.5], 19 steps, and after the last: [0.8, 1.1], 29 steps.
  const whileN = 28, betweenN = 48;
  check(steps(r.on, whileN) === 2, `only the jump inside a buzz counts as while it ran (sum ${steps(r.on, whileN)})`);
  check(steps(r.off, betweenN) === 4, `only the jump inside a pause counts as between (sum ${steps(r.off, betweenN)})`);
  check(r.n === whileN, `n is the fewer of the two counts (${r.n})`);
  // The level before: the 0.4 s up to the moment it was asked for. This
  // trace begins at zero, so there is none; one that begins a second
  // earlier has it, and a jump further back than that is not in it.
  check(r.before === null, 'no samples before the buzz, no level before');
  const earlier = flatAt(-1, 2);
  for (const x of earlier) { if (x.t >= -0.5) x.m += 3; if (x.t >= -0.2) x.m += 6; }
  const e = buzzReading(earlier, pattern, 0);
  check(steps(e.before, 39) === 6, `only the jump inside the moment before counts as before (sum ${steps(e.before, 39)})`);
  // A sample right on a window's end belongs to what comes next: the motor's
  // first sample, at the moment the buzz was asked for, is not the level before.
  const onEdge = Array.from({ length: 301 }, (_, i) => ({ t: (i - 100) / 100, m: 9.81 + (i >= 100 ? 8 : 0) }));
  const edge = buzzReading(onEdge, pattern, 0);
  check(edge.before === 0, `a jump at the very moment it was asked for is not in the level before (${edge.before})`);
  // Too little to read: no samples, or a sensor that went quiet.
  const none = buzzReading([], pattern, 0);
  check(none.on === null && none.off === null && none.n === 0, 'no samples, no reading');
  // Long buzzes, so each holds several samples either way: at twenty a
  // second they are neighbours, at five a second (a sensor that stutters)
  // the step between two says nothing about the motor.
  const long = [1000, 1000, 1000];
  const dense = buzzReading(flatAt(0, 5, 20), long, 0);
  const sparse = buzzReading(flatAt(0, 5, 5), long, 0);
  check(dense.n > 10 && sparse.n === 0, `samples a fifth of a second apart are not neighbours (${sparse.n} steps, ${dense.n} at twenty a second)`);
  // The walk keeps what a reading needs and no more.
  const walk = new Walk();
  for (let i = 0; i <= 60 * 50; i++) walk.motion(i / 50, 9.81);
  check(walk.recent[0].t >= 39.99 && walk.recent[walk.recent.length - 1].t === 60, `the walk keeps the last twenty seconds of samples (${walk.recent[0].t.toFixed(2)} to ${walk.recent[walk.recent.length - 1].t})`);
  walk.motion(60.02, NaN);
  check(walk.recent[walk.recent.length - 1].t === 60, 'and not a sample that is no number');
}

process.exit(failures ? 1 : 0);
