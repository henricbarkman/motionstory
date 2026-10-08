#!/usr/bin/env node
// Unit cases for glimt/herside.js on the strict Web Audio stand-in: what her
// side starts, what stops it, and that nothing is left sounding or ticking
// when the walk is over.
//
//   node scripts/test_herside.mjs

import { HerSide, SilentSide } from '../glimt/herside.js';
import { makeClock, FakeAudioContext } from './fake_audio.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

// A clip of `n` steps, one every 0.6 s, each a short burst at its own level.
function clip(audio, n, levels = []) {
  const buf = audio.createBuffer(1, Math.floor(audio.sampleRate * n * 0.6), audio.sampleRate);
  const d = buf.getChannelData(0);
  const slices = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * 0.6 * audio.sampleRate);
    for (let k = 0; k < 400; k++) d[from + k] = (levels[i] ?? 0.3) * (k % 2 ? 1 : -1);
    slices.push([i * 0.6, 0.55]);
  }
  return { buf, slices };
}

function rig() {
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const side = new HerSide({ ctx: audio, master: audio.createGain() }, clock);
  for (const name of ['grus', 'mjukt', 'harda']) {
    const { buf, slices } = clip(audio, 8);
    side.setSound(name, buf, slices);
  }
  side.setSound('hand', clip(audio, 2).buf);
  const run = s => clock.advance(clock.time + s, () => audio.update());
  const startedSince = n => audio.started.length - n;
  return { clock, audio, side, run, startedSince };
}

// The hum is there from the start, under the voice, and comes forward when
// the walker stands still, when a line is pinned, and a notch when lifted.
{
  const { audio, side, run } = rig();
  run(1);
  check(audio.playing.size === 4, `the hum is four sources from the first second (${audio.playing.size})`);
  const under = side.out.gain.value;
  side.setPresence(1);
  const forward = side.out.gain.value;
  side.setPresence(0);
  side.lift(true);
  const lifted = side.out.gain.value;
  side.lift(false);
  side.pin(true);
  const pinned = side.out.gain.value;
  side.pin(false);
  check(under > 0 && under < lifted && lifted < forward, `under ${under} < lifted ${lifted} < forward ${forward}`);
  check(pinned === forward && side.out.gain.value === under, 'a pin holds it forward, and lets go');
}

// Her steps come at the pace asked for and stop when she does.
{
  const { audio, side, run, startedSince } = rig();
  run(0.5);
  let n = audio.started.length;
  side.walk('grus', { rate: 120 });
  run(10);
  const steps = startedSince(n);
  check(steps >= 18 && steps <= 22, `ten seconds at 120 a minute is about twenty steps (${steps})`);
  side.walk(null);
  run(0.3);
  n = audio.started.length;
  run(5);
  check(startedSince(n) === 0, `no step after she stops (${startedSince(n)})`);
  check(audio.playing.size === 4, `and only the hum is left (${audio.playing.size} playing)`);
}

// A surface whose clip has not loaded yet: the loop runs and makes no sound,
// and the steps are there once the clip is.
{
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const side = new HerSide({ ctx: audio, master: audio.createGain() }, clock);
  const run = s => clock.advance(clock.time + s, () => audio.update());
  side.walk('grus', { rate: 100 });
  run(3);
  check(audio.started.length === 4, `no clip, no steps, no throw (${audio.started.length - 4} started)`);
  const { buf, slices } = clip(audio, 6);
  side.setSound('grus', buf, slices);
  run(3);
  check(audio.started.length > 6, `the clip arrives and she is heard walking (${audio.started.length - 4} steps)`);
  side.close();
}

// Steps are levelled: a quiet cut is brought up and a loud one down, within bounds.
{
  const { audio, side } = rig();
  const { buf, slices } = clip(audio, 3, [0.05, 0.3, 0.9]);
  side.setSound('prov', buf, slices);
  const gains = side.sounds.prov.cuts.map(c => c.gain);
  check(gains[0] > gains[1] && gains[1] > gains[2], `quiet cuts get more gain (${gains.map(g => g.toFixed(2)).join(', ')})`);
  check(Math.max(...gains) <= 4 && Math.min(...gains) >= 0.25, 'and never beyond the bounds');
  side.setSound('tyst', audio.createBuffer(1, 800, audio.sampleRate));
  check(side.sounds.tyst.cuts[0].gain === 1, 'a silent clip is left as it is');
}

// The lamp tone pulses until it is turned off, and then every pulse ends.
{
  const { audio, side, run, startedSince } = rig();
  run(0.5);
  let n = audio.started.length;
  side.tone(true);
  run(6);
  const pulses = startedSince(n) / 2;
  check(pulses >= 3 && pulses <= 5, `six seconds of lamp is about four slow pulses (${pulses})`);
  side.tone(false);
  run(0.3);
  n = audio.started.length;
  run(4);
  check(startedSince(n) === 0 && audio.playing.size === 4, `off: no new pulse, and the last one has ended (${audio.playing.size} playing)`);
}

// The other woman: comes, stops, goes, and is gone.
{
  const { audio, side, run, startedSince } = rig();
  run(0.5);
  let n = audio.started.length;
  side.other('near', 5);
  run(5);
  check(startedSince(n) >= 7, `her steps come (${startedSince(n)})`);
  check(side.otherGain.gain.value > 0.9, `and are close after the five seconds (${side.otherGain.gain.value})`);
  side.other('stop');
  run(0.3);
  n = audio.started.length;
  run(3);
  check(startedSince(n) === 0, 'she stops beside her');
  side.other('go');
  side.other('past', 4);
  run(4);
  check(startedSince(n) >= 5 && side.otherGain.gain.value < 0.01, 'she walks on and fades');
  side.other(null);
  run(0.3);
  n = audio.started.length;
  run(3);
  check(startedSince(n) === 0, 'and is gone');
}

// A line on her side resolves when it ends, and by the watchdog when the
// context never ends it (a suspended context).
{
  const { clock, audio, side, run } = rig();
  const line = audio.createBuffer(1, audio.sampleRate * 3, audio.sampleRate);
  let why = null;
  side.say(line, 'snacka').then(w => { why = w; });
  run(2.5);
  await Promise.resolve();
  check(why === null, 'a three second line is still going at 2.5 s');
  run(1);
  await Promise.resolve();
  check(why === 'ended', `and ends (${why})`);
  let late = null;
  for (const kind of ['nara', 'annan']) side.say(line, kind);
  side.say(line, 'snacka').then(w => { late = w; });
  clock.advance(clock.time + 14);     // timers only: the sources never end
  await Promise.resolve();
  check(late === 'timeout', `the watchdog lets the episode go on (${late})`);
}

// The bell: three strikes, heard to their end, beside the presence bus.
{
  const { audio, side, run, startedSince } = rig();
  run(0.5);
  const n = audio.started.length;
  const seconds = side.bell();
  check(startedSince(n) === 15, `three strikes of five partials (${startedSince(n)})`);
  run(seconds + 0.5);
  check(audio.playing.size === 4, `all rung out after ${seconds.toFixed(1)} s (${audio.playing.size} playing)`);
}

// close(): everything stops, no loop ticks on, nothing new can start.
{
  const { clock, audio, side, run } = rig();
  side.walk('mjukt', { rate: 90 });
  side.other('near', 3);
  side.tone(true);
  side.bell();
  side.say(audio.createBuffer(1, audio.sampleRate * 5, audio.sampleRate), 'nara');
  run(2);
  side.close();
  check(clock.intervals() === 0, `no loop keeps running (${clock.intervals()} intervals)`);
  check(side.out.gain.value === 0 && side.fixed.gain.value === 0, 'both buses are taken down');
  // Bell strikes still to come are stopped before they start; the stand-in
  // drops them when their start time passes.
  run(6);
  check(audio.playing.size === 0, `nothing is left sounding (${audio.playing.size} playing)`);
  const before = audio.started.length;
  audio.watching = true;
  side.walk('grus');
  side.other('near', 1);
  side.tone(true);
  side.hand();
  side.bell();
  side.setPresence(1);
  side.pin(true);
  side.lift(true);
  let why = null;
  side.say(audio.createBuffer(1, 800, audio.sampleRate), 'snacka').then(w => { why = w; });
  run(3);
  await Promise.resolve();
  check(audio.started.length === before && clock.intervals() === 0, 'a closed side starts nothing');
  check(audio.raised === 0, `and turns nothing up (${audio.raised} gains raised)`);
  check(why === 'closed', `a line on a closed side resolves at once (${why})`);
}

// A context that throws on every call (interrupted) must not keep close()
// from stopping the loops.
{
  const { clock, audio, side, run } = rig();
  side.walk('grus');
  side.tone(true);
  run(1);
  audio.broken = true;
  let threw = null;
  try { side.close(); } catch (e) { threw = e; }
  audio.broken = false;
  check(threw === null, `close() does not throw when the context does (${threw && threw.message})`);
  check(clock.intervals() === 0, `and no loop is left (${clock.intervals()} intervals)`);
}

// After a fade the bus stays down whatever the walker does.
{
  const { audio, side, run } = rig();
  run(1);
  side.fade(2);
  audio.watching = true;
  side.setPresence(1);
  side.pin(true);
  side.lift(true);
  check(audio.raised === 0, `nothing comes back up after the fade (${audio.raised} gains raised)`);
  run(3);
  side.close();
}

// A backgrounded tab: the interval stalls, then the walk picks up from now.
{
  const { clock, audio, side, run } = rig();
  side.walk('grus', { rate: 120 });
  run(2);
  const n = audio.started.length;
  clock.time += 10;
  run(0.3);
  check(audio.started.length - n <= 2, `after a stall, no burst of missed steps (${audio.started.length - n})`);
  side.close();
}

// The stand-in: nothing sounds, nothing throws, and it says it is silent.
{
  const s = new SilentSide();
  s.walk('grus'); s.other('near', 2); s.hand(); s.tone(true); s.bell(); s.lift(true); s.setPresence(1); s.fade(2);
  s.pin(true);
  const why = await s.say(null, 'snacka');
  check(s.silent && s.pinned && why === 'silent', 'the silent side keeps the pin and resolves its lines');
  s.close();
}

process.exit(failures ? 1 : 0);
