#!/usr/bin/env node
// Unit cases for glimt/synth.js on the strict Web Audio stand-in: what stop
// and close guarantee, including when the audio context misbehaves.
//
//   node scripts/test_synth.mjs

import { Synth } from '../glimt/synth.js';
import { makeClock, FakeAudioContext } from './fake_audio.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

function rig() {
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const synth = new Synth({ ctx: audio, master: audio.createGain() }, clock);
  const run = s => clock.advance(clock.time + s, () => audio.update());
  return { clock, audio, synth, run };
}

// A stopped sound ignores set(): the stations tick on through Avsluta's fade.
{
  const { audio, synth, run } = rig();
  const pad = synth.pad({ level: 0.5 });
  const noise = synth.staticNoise({ level: 0.5 });
  run(1);
  synth.close();
  audio.watching = true;
  pad.set({ level: 1 });
  noise.set({ level: 1 });
  check(audio.raised === 0, `set() after close turns nothing up (${audio.raised} gains raised)`);
  run(5);
  check(audio.playing.size === 0, `everything has stopped five seconds on (${audio.playing.size} playing)`);
}

// One sound that throws on stop does not keep the others alive.
{
  const { clock, audio, synth, run } = rig();
  synth.footsteps({ rate: 120, distance: 10 });
  synth.beat({ bpm: 110 });
  synth.chime({ pan: 0.5, distance: 50 });
  run(1);
  audio.broken = true;
  let threw = null;
  try { synth.close(); } catch (e) { threw = e; }
  audio.broken = false;
  check(threw === null, `close() does not throw when a stop does (${threw && threw.message})`);
  check(synth.live.size === 0, `every handle was told to stop (${synth.live.size} left)`);
  check(clock.intervals() === 0, `no loop keeps running (${clock.intervals()} intervals)`);
  const before = audio.started.length;
  run(3);
  check(audio.started.length === before, `nothing new starts after (${audio.started.length - before} started)`);
}

// Closed: new sounds are silent handles, and passing resolves at once.
{
  const { audio, synth } = rig();
  synth.close();
  const handles = [synth.footsteps(), synth.beat(), synth.staticNoise(), synth.pad(), synth.chime()];
  handles.forEach(h => { h.set({ level: 1, distance: 5, bpm: 120 }); h.stop(); });
  check(audio.started.length === 0 && synth.live.size === 0, 'a closed synth starts nothing');
  let resolved = false;
  synth.passing().then(() => { resolved = true; });
  await Promise.resolve();
  check(resolved, 'passing() on a closed synth resolves at once');
}

// passing() stopped early fades and still resolves.
{
  const { synth, run } = rig();
  let resolved = false;
  synth.passing({ seconds: 14 }).then(() => { resolved = true; });
  run(3);
  synth.stopAll();
  run(1.5);
  await Promise.resolve();
  check(resolved, 'a passing stopped early still resolves');
}

// A backgrounded tab: the interval stalls, then the loop starts from now
// instead of scheduling the missed beats all at once.
{
  const { clock, audio, synth, run } = rig();
  const beat = synth.beat({ bpm: 120 });
  run(2);
  const n = beat.beats.length;
  // Jump the audio clock ten seconds without running the timers.
  clock.time += 10;
  run(0.3);
  const burst = beat.beats.length - n;
  check(burst <= 2, `after a stall the beat picks up, no burst of missed beats (${burst} scheduled)`);
  check(beat.beats[beat.beats.length - 1] >= clock.time - 0.3, 'and the new beats are in the present');
  synth.close();
  void audio;
}

process.exit(failures ? 1 : 0);
