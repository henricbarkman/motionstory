#!/usr/bin/env node
// Unit cases for ending a line at a pause (v40): breakAt, the Mixer's
// endVoiceAtBreak on the strict Web Audio stand-in, and the pauses measured
// into episode 1. A go line that is ended early must end in a silence
// between two of her sentences, faded inside it, never in a word.
//
//   node scripts/test_breaks.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mixer, breakAt, BREAK_FADE, BREAK_LEAD, SONG_UNDER } from '../glimt/audio.js';
import { makeClock, FakeAudioContext } from './fake_audio.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EPISODE_SV = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episod-1.json'), 'utf8'));

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

// ---------- breakAt ----------
{
  const one = [{ from: 1, to: 2, said: 'Där.' }];
  check(breakAt(undefined, 0) === null && breakAt([], 0) === null, 'no pauses: none to end at');
  check(near(breakAt(one, 0.5)?.at, 1), 'before a pause: it ends where the pause begins');
  check(near(breakAt(one, 1.5)?.at, 1.5), 'inside a pause: it ends now, the silence has begun');
  check(near(breakAt(one, 2 - BREAK_FADE)?.at, 2 - BREAK_FADE), 'room for the fade exactly: still this pause');
  check(breakAt(one, 2 - BREAK_FADE + 0.01) === null, 'too late in the pause for the fade: none, the line plays out');
  check(breakAt(one, 2.5) === null, 'past the last pause: none');
  const two = [{ from: 1, to: 1.2, said: 'Där.' }, { from: 2, to: 2.5, said: 'Där. Ja.' }];
  check(breakAt(two, 0.2)?.said === 'Där.', 'several pauses: the first one ahead');
  check(breakAt(two, 1.19)?.said === 'Där. Ja.', 'the first too close to its end: the next one');
}

// ---------- the Mixer ----------
// A 3 s line with a pause at 1.0-1.5 s, played from 2 s in (the filters' own
// time constants settle first, as in the app).
function rig() {
  globalThis.window = globalThis.window || {};
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const mixer = new Mixer(audio);
  const run = s => clock.advance(clock.time + s, () => audio.update());
  run(2);
  const buffer = audio.createBuffer(1, audio.sampleRate * 3, audio.sampleRate);
  let why = null;
  const said = mixer.playVoice(buffer).then(w => { why = w; });
  const src = mixer.currentVoice;
  // Records what is asked of the line's own gain, with the times.
  const calls = [];
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
    const g = src.level.gain, f = g[m].bind(g);
    g[m] = (...a) => { calls.push([m, ...a]); return f(...a); };
  }
  return { clock, audio, mixer, run, src, calls, said, why: () => why };
}
const PAUSE = [{ from: 1.0, to: 1.5, said: 'Där.' }];

{
  const { mixer, run, src, calls, said, why } = rig();
  const t0 = src.startedAt;
  run(0.5);
  const b = mixer.endVoiceAtBreak(PAUSE);
  check(near(b?.at, 1.0), 'asked at 0.5 s: ends at the pause, 1.0 s in');
  check(near(src.endAt, t0 + 1.0 + BREAK_FADE), `the source stops when the fade is over (${(src.endAt - t0).toFixed(3)} s in)`);
  const ramp = calls.find(c => c[0] === 'linearRampToValueAtTime');
  const hold = calls.find(c => c[0] === 'setValueAtTime');
  check(hold && hold[1] === 1 && near(hold[2], t0 + 1.0), 'full level held to the start of the pause');
  check(ramp && ramp[1] === 0 && near(ramp[2], src.endAt), 'faded to nothing by the stop');
  check(src.endAt <= t0 + PAUSE[0].to, 'the fade lies inside the silence');
  check(mixer.endVoiceAtBreak([{ from: 1.2, to: 1.5, said: 'X' }]) === b && near(src.endAt, t0 + 1.0 + BREAK_FADE),
    'asked again: the same pause, the stop does not move');
  run(0.4);
  check(src.ended === false, 'still sounding a moment before the pause');
  run(0.2);
  await said;
  check(why() === 'break', `the play resolves 'break' (${why()})`);
  check(mixer.currentVoice === null, 'and no voice is left playing');
}

{
  // Asked a hair before the pause: no time to schedule it there, so it ends
  // BREAK_LEAD from now, still in the silence.
  const { mixer, run, src } = rig();
  run(0.98);
  const b = mixer.endVoiceAtBreak(PAUSE);
  check(near(b?.at, 0.98 + BREAK_LEAD), `asked at 0.98 s: ends ${BREAK_LEAD} s on, at ${b?.at?.toFixed(2)}`);
  check(near(src.endAt, src.startedAt + 0.98 + BREAK_LEAD + BREAK_FADE), 'never scheduled in the past');
}

{
  // Asked once the last pause is behind: the line is said to its end.
  const { mixer, run, src, calls, said, why } = rig();
  run(1.47);
  check(mixer.endVoiceAtBreak(PAUSE) === null, 'asked at 1.47 s, no pause ahead: none');
  check(src.endsAtBreak === undefined && calls.length === 0, 'nothing scheduled on the line');
  run(1.6);
  await said;
  check(why() === 'ended', `played to its end (${why()})`);
}

{
  const { mixer, run, said } = rig();
  run(3.1);
  await said;
  check(mixer.endVoiceAtBreak(PAUSE) === null, 'no line playing: none');
}

// ---------- the song under a line (the English credits) ----------
// It starts at its time at SONG_UNDER of the song's level, beside the line:
// the line is still the voice playing, and a stop that ends the line at a
// pause does not touch the song. rise() brings it to full; it resolves when
// it ends.
{
  const { clock, audio, mixer, run, src } = rig();
  const song = audio.createBuffer(1, audio.sampleRate * 6, audio.sampleRate);
  const at = clock.time + 0.5;
  const n = audio.started.length;
  const s = mixer.playSong(song, { at });
  const started = audio.started[n].node;
  check(started.startedAt === at && s.startedAt === at, 'the song starts at the time asked');
  check(mixer.currentVoice === src, 'the line is still the voice playing');
  const level = [...started.outs][0];
  check(Math.abs(level.gain.value - SONG_UNDER) < 1e-9, `faint under her (${level.gain.value})`);
  // Scribe heard both last lines word for word over the song at 0.2
  // (2026-10-27); louder than that is untested.
  check(SONG_UNDER <= 0.2, `no louder under her than Scribe has heard (${SONG_UNDER})`);
  check(mixer.endVoiceAtBreak(PAUSE) !== null && !started.ended, 'her line ends at its pause, the song plays on');
  s.rise();
  check(level.gain.value === 1, 'once she has finished it grows to full');
  let why = null;
  s.done.then(w => { why = w; });
  run(7);
  await Promise.resolve();
  check(why === 'ended', `and resolves when it ends (${why})`);
}

// ---------- the pauses measured into episode 1 ----------
// In Swedish and in English (episode-1.json): the same go lines, each its own
// takes and pauses.
const BREAK_MIN = 0.12;      // check_glimt_audio.py: a pause narrower is none
for (const [lang, EPISODE] of [['sv', EPISODE_SV], ['en', JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-1.json'), 'utf8'))]]) {
  console.log(`-- episode 1, ${lang}`);
  const goLines = Object.keys(EPISODE.breakFrom || {});
  check(goLines.length >= 9, `${goLines.length} lines are go lines (breakFrom)`);
  if (lang === 'en') check(goLines.join() === Object.keys(EPISODE_SV.breakFrom).join(), 'the English go lines are the Swedish ones');
  for (const id of goLines) {
    const bs = (EPISODE.breaks || {})[id] || [];
    const len = (EPISODE.seconds || {})[id];
    const bad = bs.filter((b, i) => !(b.to - b.from >= BREAK_MIN && b.from > 0 && b.to < len && b.said && (i === 0 || b.from >= bs[i - 1].to)));
    check(bs.length > 0 && !bad.length, `${id}: ${bs.length} pause(s), each ${BREAK_MIN} s or wider, in order, inside its ${len} s`);
    // A line rendered again has its pauses elsewhere: they must be from this take.
    const on = (EPISODE.breaksMeasuredOn || {})[id];
    check(on === len, `${id}: its pauses measured on this take (${on} s, the file ${len} s)`);
  }
  const strays = Object.keys(EPISODE.breaks || {}).filter(id => !goLines.includes(id));
  check(!strays.length, `pauses only on go lines${strays.length ? ` (also ${strays.join(', ')})` : ''}`);
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
