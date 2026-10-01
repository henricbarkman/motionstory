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
import { Walk } from '../glimt/engine.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

function replay(file) {
  const rec = JSON.parse(readFileSync(new URL(`./recordings/${file}`, import.meta.url), 'utf8'));
  const walk = new Walk();
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
      bands.push({ t: next, band: s.band });
      if (s.paceSource === 'steps' && s.band === 'walk') cadences.push(s.cadence);
      if (s.lastDoubleKnockAt > last) { last = s.lastDoubleKnockAt; doubles.push(last); }
      next = Math.round((next + 0.25) * 1000) / 1000;
    }
  };
  for (let i = 0; i < rec.t.length; i++) {
    tickUntil(rec.t[i] / 1000);
    walk.motion(rec.t[i] / 1000, rec.m[i] / 100);
  }
  tickUntil(rec.t[rec.t.length - 1] / 1000 + 1);
  return { bands, doubles, cadences };
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

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall recordings ok');
