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
  const maxCad = Math.max(...cadences);
  check(maxCad <= 130, `walking cadence stays a walk's, 4.8 km/h is about 118 (highest ${Math.round(maxCad)})`);
  check(within(25.2, 25.7), `the standing double is heard (${fmt(doubles)})`);
  check(within(44.6, 45.1), 'the walking double is heard');
  check(within(76.3, 76.8), 'the answer knocked walking is heard');
  check(doubles.length === 3, `and nothing else is a double (${doubles.length})`);
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall recordings ok');
