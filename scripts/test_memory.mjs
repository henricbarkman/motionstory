#!/usr/bin/env node
// Checks glimt/memory.js: moon phase against eclipses (a lunar eclipse is a
// full moon, a solar one a new moon), the absence thresholds, keys said only
// once, and new ground counted against earlier walks.
//
//   node scripts/test_memory.mjs

import { moonPhase, isFullMoon, absenceLine, cellOf, Memory } from '../glimt/memory.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

// Lunar eclipses: 2024-09-18 02:44, 2025-03-14 06:58, 2025-09-07 18:11 UTC.
for (const iso of ['2024-09-18T02:44Z', '2025-03-14T06:58Z', '2025-09-07T18:11Z']) {
  const p = moonPhase(new Date(iso));
  check(Math.abs(p - 0.5) < 0.02 && isFullMoon(new Date(iso)), `full moon at lunar eclipse ${iso} (phase ${p.toFixed(3)})`);
}
// Solar eclipse 2024-04-08 18:17 UTC: new moon, and so not full.
const solar = moonPhase(new Date('2024-04-08T18:17Z'));
check(Math.min(solar, 1 - solar) < 0.02 && !isFullMoon(new Date('2024-04-08T18:17Z')), `new moon at solar eclipse (phase ${solar.toFixed(3)})`);
// Four days off full is not full.
check(!isFullMoon(new Date('2025-09-11T18:11Z')), 'four days after full is not full');

const H = 3600000;
check(absenceLine(NaN, 0) === null, 'first walk ever: no absence line');
check(absenceLine(0, 3 * H) === 'franvaro-samma', 'three hours: samma');
check(absenceLine(0, 20 * H) === 'franvaro-dagar', 'twenty hours: dagar');
check(absenceLine(0, 6 * 24 * H) === 'franvaro-dagar', 'six days: dagar');
check(absenceLine(0, 8 * 24 * H) === 'franvaro-lange', 'eight days: lange');

// Squares: 100 m apart north is a different square, 10 m is usually not.
check(cellOf(59.38, 13.5) !== cellOf(59.38 + 100 / 111320, 13.5), 'a square north is another square');
const w = 0.0009 / Math.cos(59.38 * Math.PI / 180);
check(cellOf(59.38, 13.5) !== cellOf(59.38, 13.5 + w), 'a square east is another square');

// A storage stand-in.
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const s = store();
const dark = { light: 'dark', rain: false };
const t0 = Date.UTC(2026, 8, 25, 21);

let m = new Memory(s);
check(m.opening(t0).length === 0, 'first walk: no opening line');
for (let k = 0; k < 10; k++) m.visit(59.38 + k * 100 / 111320, 13.5);
const first = m.closing(dark, new Date(t0));
check(first.includes('nyckel-morker') && first.includes('varld-ny'), `first dark walk: key and new world (${first.join(', ')})`);
m.endWalk(t0 + H, 'labb1');

m = new Memory(s);
check(m.opening(t0 + 2 * H).join() === 'franvaro-samma', 'same evening: samma');
for (let k = 0; k < 10; k++) m.visit(59.38 + k * 100 / 111320, 13.5);
const second = m.closing(dark, new Date(t0 + 2 * H));
check(!second.includes('nyckel-morker') && second.includes('varld-samma'), `second walk, same squares: no key again, samma (${second.join(', ')})`);
m.endWalk(t0 + 3 * H, 'labb1');

m = new Memory(s);
m.visit(59.38 + 20 * 100 / 111320, 13.5);
const third = m.closing({ light: 'light', rain: true }, new Date(t0 + 30 * H));
check(third.includes('nyckel-regn') && third.includes('varld-lite'), `rain and one new square (${third.join(', ')})`);
m.endWalk(t0 + 31 * H, '1');
check(m.summary().walks === 3 && m.summary().cells === 11, `summary counts walks and squares (${JSON.stringify(m.summary())})`);

// A broken entry starts over instead of throwing.
const broken = store();
broken.setItem('glimt-memory', '{not json');
check(new Memory(broken).summary().walks === 0, 'broken storage starts over');

process.exit(failures ? 1 : 0);
