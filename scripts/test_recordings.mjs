#!/usr/bin/env node
// Real pockets as tests. Each recording in scripts/recordings/ was saved with
// "Spara sensordata" on a field walk and runs through the engine the way the
// phone ran it: every sample, every fix, a tick every 250 ms. The simulated
// walkers in test_lab.mjs are guesses; these are not, and the first one
// (2026-09-28) broke two things the simulation had passed for days: steps
// counted twice read a walker as running, and heel strikes as sharp as knocks
// hid every knock made walking.
//
//   node scripts/test_recordings.mjs

import { readFileSync } from 'node:fs';
import { Walk, buzzReading } from '../glimt/engine.js';
import { labHelpers, knockPattern } from '../glimt/lab.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

// `buzzes` are her patterns as the phone asked for them, [{ at, n, counted }]
// in the samples' seconds: the engine is told of each the way the station
// tells it, and the knocks back are counted when the station counted them
// (the detector keeps ten seconds of knocks, so not afterwards).
function replay(file, { buzzes = [] } = {}) {
  const rec = JSON.parse(readFileSync(new URL(`./recordings/${file}`, import.meta.url), 'utf8'));
  const walk = new Walk();
  let clock = 0, bi = 0;
  const lab = labHelpers(walk, { now: () => clock, vibrateImpl: () => true });
  const overs = [], got = [];
  const fixes = rec.fixes.map(([t, north, east, accuracy, speed]) => ({
    t: t / 1000,
    coord: { latitude: 59.38 + north / 111320, longitude: 13.5 + east / 56700, accuracy, speed },
  }));
  const bands = [], doubles = [], cadences = [];
  let fi = 0, next = 0.25, last = -Infinity;
  const tickUntil = t => {
    while (next <= t) {
      while (fi < fixes.length && fixes[fi].t <= next) { walk.fix(fixes[fi].t, fixes[fi].coord); fi++; }
      const s = walk.tick(next);
      while (got.length < overs.length && buzzes[got.length].counted <= next) {
        got.push(walk.knocks.countBetween(overs[got.length], next));
      }
      bands.push({ t: next, band: s.band });
      if (s.paceSource === 'steps' && s.band === 'walk') cadences.push(s.cadence);
      if (s.lastDoubleKnockAt > last) { last = s.lastDoubleKnockAt; doubles.push(last); }
      next = Math.round((next + 0.25) * 1000) / 1000;
    }
  };
  for (let i = 0; i < rec.t.length; i++) {
    const t = rec.t[i] / 1000;
    while (bi < buzzes.length && buzzes[bi].at <= t) {
      tickUntil(buzzes[bi].at);
      clock = buzzes[bi].at;
      lab.vibrate(knockPattern(buzzes[bi].n));
      overs.push(lab.buzzOver());
      bi++;
    }
    tickUntil(t);
    walk.motion(t, rec.m[i] / 100);
  }
  tickUntil(rec.t[rec.t.length - 1] / 1000 + 1);
  const samples = rec.t.map((t, i) => ({ t: t / 1000, m: rec.m[i] / 100 }));
  return { bands, doubles, cadences, walk, samples, got };
}

// Knacket alone. Walked the whole time (he said so), 4.2-4.8 km/h by GPS.
// Knocked twice standing about 25.3 s, walking about 44.7 s, and to answer
// the last question about 76.4 s. Nothing else was a knock.
{
  const { bands, doubles, cadences } = replay('knack-2026-09-28.json');
  const fmt = xs => xs.map(x => x.toFixed(2)).join(', ') || 'none';
  const within = (a, b) => doubles.some(d => d >= a && d <= b);
  check(!bands.some(b => b.band === 'run'), `a walker never reads as running (${bands.filter(b => b.band === 'run').length} ticks did)`);
  check(cadences.length > 100, `steps decided the pace while walking (${cadences.length} ticks), so the next check measures something`);
  const maxCad = Math.max(...cadences);
  check(maxCad <= 130, `walking cadence stays a walk's, 4.8 km/h is about 118 (highest ${Math.round(maxCad)})`);
  check(within(25.2, 25.7), `the standing double is heard (${fmt(doubles)})`);
  check(within(44.6, 45.1), 'the walking double is heard');
  check(within(76.3, 76.8), 'the answer knocked walking is heard');
  check(doubles.length === 3, `and nothing else is a double (${doubles.length})`);
}

// Labb 2 from the start, 2026-10-01: Gå normalt, Vänd om, into Vägvalet,
// standing from about 5:00. No station asked for a knock and he knocked
// nothing. Turning round the first time, two heel strikes of 16.6 and 15.9
// came 0.14 s apart and the phone heard a double.
//
// From 5:26 the phone most likely came out of the pocket for the stop
// button: three shaky seconds, then five calm ones in the hand. Its bumps,
// right after standing, read as two seconds of running at 5:28. Not counted
// here; it would mute knocks for those seconds, nothing more.
{
  const { bands, doubles, cadences } = replay('labb2-2026-10-01.json');
  const fmt = xs => xs.map(x => x.toFixed(2)).join(', ') || 'none';
  check(doubles.length === 0, `turning round is not a double knock (${fmt(doubles)})`);
  const ran = bands.filter(b => b.band === 'run' && b.t < 326);
  check(ran.length === 0, `a walker never reads as running before the phone comes out (${ran.length} ticks did)`);
  check(cadences.length > 400, `steps decided the pace while walking (${cadences.length} ticks)`);
  const maxCad = Math.max(...cadences);
  check(maxCad <= 135, `walking cadence stays a walk's, 104-123 in the log (highest ${Math.round(maxCad)})`);
}

// Labb 2 again the same evening, from Vägvalet, in Firefox: no position all
// walk, so only steps say walking or still. Kroppsmorse is stop, walk, stop;
// he stood for Hon knackar. Knocked nothing. A heel strike of 38.6 at 2:02,
// walking, is the hardest yet: the detector counts it as a knock, but alone,
// so it is no double. No two strikes here come close enough to try the hard-
// knock rule; the morning's turning round does that.
{
  const { bands, doubles, cadences } = replay('labb2-2026-10-01-kvall.json');
  const fmt = xs => xs.map(x => x.toFixed(2)).join(', ') || 'none';
  check(doubles.length === 0, `nothing he did is a double knock (${fmt(doubles)})`);
  const ran = bands.filter(b => b.band === 'run');
  check(ran.length === 0, `a walker with no GPS never reads as running (${ran.length} ticks did)`);
  check(cadences.length > 600, `steps decided the pace while walking (${cadences.length} ticks)`);
  const maxCad = Math.max(...cadences);
  // 81-117 in the log's half-minute lines; 136 for a moment as he set off
  // between Kroppsmorse's stops. A run starts about 145.
  check(maxCad <= 140, `walking cadence stays under a run's (highest ${Math.round(maxCad)})`);
}

// Labb 2 in Chrome, 2026-10-06 morning: Vägvalet, Ljudkompassen, Hon knackar.
// He jogged a stretch in Ljudkompassen, about 2:27-2:35 (he said so), and the
// steps read it as a run. The phone was on Do not disturb: Chrome said yes to
// both of her patterns, about 3:47.8 and 4:04.3, and the motor never ran. He
// stood, waited, and knocked nothing on purpose.
//
// Standing for her knocks, his shifting about reads as running for a second
// at 3:54 and two at 4:01. Not counted here: a run the feet read does not
// mute knocks on a phone that stands still, and that is tried in
// test_knocks.mjs.
{
  const { bands, doubles, samples } = replay('labb2-2026-10-06.json');
  const fmt = xs => xs.map(x => x.toFixed(2)).join(', ') || 'none';
  const f = x => x === null ? '?' : x.toFixed(2);
  check(doubles.length === 0, `nothing he did is a double knock (${fmt(doubles)})`);
  const ran = bands.filter(b => b.band === 'run');
  check(ran.filter(b => b.t < 146).length === 0, `walking never reads as running before he jogs (${ran.filter(b => b.t < 146).length} ticks did)`);
  const jog = ran.filter(b => b.t >= 146 && b.t <= 156).length;
  check(jog >= 30, `the jog reads as running, 2:27-2:35 (${jog} ticks)`);
  const silent = [[227.8, 2], [244.3, 3]].map(([at, n]) => buzzReading(samples, knockPattern(n), at));
  check(silent.every(r => r.n >= 6 && r.on < 0.06 && r.off < 0.06),
    `a motor that never ran shows nothing in a still pocket (${silent.map(r => `${f(r.on)} while, ${f(r.off)} between`).join('; ')})`);
}

// Hon knackar alone the same afternoon, Do not disturb off: the first walk
// where the motor ran, and the first buzz recorded in a pocket. The times she
// asked for her patterns, 73.517 and 83.265 s, are where the phone's own
// reading in the log ("surr: sensorn 0,03 före, 0,18 under surren, 0,03
// emellan", then 0,17 / 0,28 / 0,10) comes out the same from these samples.
//
// After her two he knocked twice, 1.9 s after her last buzz. After her three
// he knocked nothing: from 84.6 s until he walks off at 102 s no sample
// leaves 9.5-10.6.
//
// The phone going into the pocket at 0:05 reads as a double. Not counted
// here: no station was listening.
{
  // Counted where the log says "hon knackade 2, du 2" and "hon knackade 3, du 0".
  const asked = [{ at: 73.517, n: 2, counted: 79.26 }, { at: 83.265, n: 3, counted: 96.01 }];
  const { doubles, samples, got } = replay('knackar-2026-10-06.json', { buzzes: asked });
  const fmt = xs => xs.map(x => x.toFixed(2)).join(', ') || 'none';
  const f = x => x === null ? '?' : x.toFixed(2);
  const [two, three] = asked.map(b => buzzReading(samples, knockPattern(b.n), b.at));
  check(f(two.before) === '0.03' && f(two.on) === '0.18' && f(two.off) === '0.03',
    `her two read as the phone logged them (${f(two.before)} before, ${f(two.on)} while, ${f(two.off)} between)`);
  check(f(three.before) === '0.17' && f(three.on) === '0.28' && f(three.off) === '0.10',
    `and her three (${f(three.before)} before, ${f(three.on)} while, ${f(three.off)} between)`);
  check(two.on > 4 * two.off && two.on > 4 * two.before, 'a motor that runs shows in a still pocket, several times the level around it');
  check(got[0] === 2, `his two knocks back are counted (${got[0]})`);
  check(doubles.some(d => d >= 76.3 && d <= 76.8), `and heard as a double (${fmt(doubles)})`);
  check(got[1] === 0, `after her three he knocked nothing, and nothing is counted (${got[1]})`);
  check(doubles.filter(d => d > 10).length === 1, `nothing else from the stop on is a double (${fmt(doubles.filter(d => d > 10))})`);
  // The same walk with the engine told of no buzz: the motor's shake is far
  // too small to be a knock on its own, so on this phone the mute guards
  // nothing. It is there for a motor nobody has measured.
  const untold = replay('knackar-2026-10-06.json');
  const shaken = untold.walk.knocks.spikes.filter(x => x.knock && asked.some(b => x.t >= b.at && x.t <= b.at + b.n * 0.5 + 0.2));
  const heard = untold.walk.knocks.spikes.filter(x => x.knock && x.t > 76 && x.t < 77).length;
  check(heard === 2, `untold, his two knocks are still knocks (${heard}), so the next check measures something`);
  check(shaken.length === 0, `and the motor's own shake is none (${shaken.length})`);
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall recordings ok');
