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
import { Mixer, breakAt, brusOf, readBakgrund, BREAK_FADE, BREAK_LEAD, SONG_UNDER, RADIO_HISS, BED_GAIN, FX_GAIN, BAKGRUND_MIN, BAKGRUND_MAX } from '../glimt/audio.js';
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

// ---------- the hiss (v48) ----------
// Its own knob, brus, beside klarhet: until v47 the hiss was 1 - klarhet under
// every line. A chapter with "brus" has it only under the lines it names.
{
  const EN = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-1.json'), 'utf8'));
  const same = (a, b) => a.length === b.length && a.every((x, i) => (x === null && b[i] === null) || Math.abs(x - b[i]) < 1e-9);
  check(same(brusOf(undefined, 's1-2', 0.45), [0.55, 0.55, null]), 'a chapter without brus: as much as its radio, under every line (Swedish, as before)');
  check(same(brusOf(EN.brus, 's0-1', 0.45), [1, 1, null]), 'the English first line: the whole radio\'s hiss');
  check(same(brusOf(EN.brus, 's0-2', 0.45), [1, 0, 18.1]), 'her second: from all of it to none, 18.1 s in (v50: after the long pause)');
  const hissed = Object.keys(EN.lines).filter(id => brusOf(EN.brus, id, EN.klarhet).some(x => x > 0));
  check(hissed.join() === 's0-1,s0-2', `and no other English line has any (${hissed.join(', ')})`);
  check(Object.keys(EN.brus).every(id => id in EN.lines), 'brus names only lines of the episode');
  // v50 (Henric 29/10, "Lång paus efteråt"): about 4 s of silence after "I'm
  // keeping up instead.", laid into the take. Measured from the file: from
  // "instead" to "who" was 1.4 s in the v45 take, and the words around the
  // pause take about one of them.
  const sinks = EN.cues['s0-2'].who - EN.cues['s0-2'].instead;
  check(sinks >= 4.5 && sinks <= 6, `a long pause after "I'm keeping up instead." (${sinks.toFixed(2)} s from instead to who)`);
  check(EN.brus['s0-2'][2] < EN.seconds['s0-2'],`the hiss is gone before her second line ends (${EN.brus['s0-2'][2]} of ${EN.seconds['s0-2']} s)`);
  check(same(brusOf(undefined, 'x', 1.2), [0, 0, null]) && same(brusOf(undefined, 'x', -1), [1, 1, null]),
    'a klarhet outside 0..1 hisses as setKlarhet clamps it, never below none');

  // The Mixer: klarhet no longer touches the hiss, and setBrus schedules it
  // from the line's start to its end.
  const { clock, mixer, run, said } = rig();
  const g = mixer.hissLevel.gain;
  const calls = [];
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'setTargetAtTime']) {
    const f = g[m].bind(g);
    g[m] = (...a) => { calls.push([m, ...a]); return f(...a); };
  }
  mixer.setKlarhet(0.2);
  check(calls.length === 0, 'setKlarhet leaves the hiss alone');
  check(mixer.hissNow() === 0, 'and there is none until a line asks for it');
  const at = clock.time + 0.5;
  mixer.setBrus(1, 0, { at, seconds: 14.5 });
  const start = calls.filter(c => c[0] === 'setValueAtTime').pop();
  const ramp = calls.find(c => c[0] === 'linearRampToValueAtTime');
  check(start && near(start[1], RADIO_HISS) && near(start[2], at), `the whole radio's hiss as the line starts (${start})`);
  check(ramp && ramp[1] === 0 && near(ramp[2], at + 14.5), `none 14.5 s on (${ramp})`);
  calls.length = 0;
  mixer.setBrus(0.5);
  check(!calls.some(c => c[0] === 'linearRampToValueAtTime') && near(calls.filter(c => c[0] === 'setValueAtTime').pop()[1], 0.5 * RADIO_HISS),
    'a level alone: it stays there, no ramp');
  mixer.setBrus(0);
  check(mixer.hissNow() === 0 && mixer.brus === 0, 'brus 0: no hiss, the line still playing');
  calls.length = 0;
  let threw = null;
  try { mixer.setBrus(NaN, undefined); mixer.setBrus('x'); } catch (e) { threw = e; }
  const values = calls.filter(c => c[0] === 'setValueAtTime').map(c => c[1]);
  check(!threw && values.every(Number.isFinite), `a level that is no number is no hiss, and nothing throws (${threw || values})`);
  run(3.1);
  await said;
}

// ---------- the bed and the riser (v49) ----------
// Henric 29/10: the bed and the riser far too loud against Jessica's voice,
// which lies 8-9 dB under the voice they were set against. The English
// episode moves both 12 dB down (bakgrund), a link tries another level.
{
  const EN = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-1.json'), 'utf8'));
  const db = x => Math.pow(10, x / 20);
  check(readBakgrund(null) === null && readBakgrund('') === null && readBakgrund('x') === null && readBakgrund('-6,1,2') === null,
    'readBakgrund: nothing or no number is null');
  check(readBakgrund('-12') === -12 && readBakgrund(' -7,5 ') === -7.5 && readBakgrund('\u22126') === -6 && readBakgrund('3') === 3,
    'readBakgrund: dB, a decimal comma and a typed minus sign');
  check(readBakgrund('-99') === BAKGRUND_MIN && readBakgrund('40') === BAKGRUND_MAX, 'readBakgrund: clamped');
  check(EN.bakgrund === -12, `the English episode's bed and riser 12 dB down (${EN.bakgrund})`);
  check(EPISODE_SV.bakgrund === undefined, 'the Swedish has none: its bed and riser as before');

  const { audio, mixer, run, said } = rig();
  const bed = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  check(near(mixer.fxGain.gain.value, FX_GAIN) && mixer.bakgrund === 0, 'a mixer not told: the riser at its own level');
  mixer.setBakgrund(EN.bakgrund);
  check(near(mixer.fxGain.gain.value, FX_GAIN * db(-12)), `bakgrund -12: the riser 12 dB down (${mixer.fxGain.gain.value.toFixed(3)})`);
  mixer.startBed(bed);
  check(near(mixer.bedLevel, BED_GAIN * db(-12)), `and the bed starts 12 dB down (${mixer.bedLevel.toFixed(3)})`);
  mixer.setBed(0.35);
  check(near(mixer.bedLevel * mixer.bedShare, BED_GAIN * db(-12) * 0.35), 'stepped back under her side from its own lower level');
  mixer.setBakgrund('x');
  check(mixer.bakgrund === 0 && near(mixer.fxGain.gain.value, FX_GAIN), 'a level that is no number: 0, nothing throws');
  mixer.setBakgrund(-99);
  check(mixer.bakgrund === BAKGRUND_MIN, 'and one past the edge is clamped');
  run(3.1);
  await said;
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

// ---------- a line to herself (v57) ----------
// Henric chose "9 dB lower and duller" on the proof page (30/10): at full
// contact the aside is 0.355 of the level with the lowpass at 3.8 kHz, and it
// is there from the line's first word, not glided to over a second.
{
  globalThis.window = globalThis.window || {};
  const clock = makeClock();
  const audio = new FakeAudioContext(clock);
  const mixer = new Mixer(audio);
  clock.advance(2, () => audio.update());
  const calls = [];
  for (const [name, param] of [['gain', mixer.voiceGain.gain], ['freq', mixer.voiceFilter.frequency]]) {
    const f = param.setTargetAtTime.bind(param);
    param.setTargetAtTime = (v, t, c) => { calls.push({ name, v, t, c }); return f(v, t, c); };
  }
  const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
  mixer.playVoice(buffer, { aside: true, at: 2.5 });
  const gain = calls.find(x => x.name === 'gain'), freq = calls.find(x => x.name === 'freq');
  check(gain && Math.abs(20 * Math.log10(gain.v) + 9) < 0.1, `an aside at full contact is 9 dB lower (${gain && (20 * Math.log10(gain.v)).toFixed(2)} dB)`);
  check(freq && Math.abs(freq.v - 3800) < 25, `and duller: lowpass ${freq && Math.round(freq.v)} Hz, wanted 3800`);
  // Within a tenth of a second of the line's start it is at its level: a
  // time constant of at most 0.035 s (95 % in three of them), from its start.
  check(gain && gain.c <= 0.035 && freq.c <= 0.035, `it is at its level from the first word (time constant ${gain && gain.c} s)`);
  check(gain && Math.abs(gain.t - 2.5) < 1e-9, `from the line's start, not before it (${gain && gain.t})`);
  calls.length = 0;
  clock.advance(5, () => audio.update());
  const back = calls.find(x => x.name === 'gain');
  check(back && Math.abs(back.v - 1) < 1e-9 && back.c <= 0.035, 'after it the level is back, as fast');
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
