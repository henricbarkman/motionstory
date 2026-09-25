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

// A walk straight north stays in one column (it slid sideways once).
const column = new Set(Array.from({ length: 60 }, (_, k) => cellOf(59.38 + k * 0.0009, 13.5123).split(',')[1]));
check(column.size === 1, `straight north stays in one column (${column.size} columns)`);

// Either side of a half degree, in the same row: the same square. The
// width once came from the fix's own latitude and split the row there.
check(cellOf(59.4999, 13.5123) === cellOf(59.5001, 13.5123), `a metre either side of 59.5° is one square (${cellOf(59.4999, 13.5123)} ${cellOf(59.5001, 13.5123)})`);

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

// The start screen lights the squares the last walk added.
const last = new Memory(s).lastWalkCells();
check(last.size === 1 && last.has(cellOf(59.38 + 20 * 100 / 111320, 13.5)), `last walk's squares are the ones it added (${[...last].join(' ')})`);
check(new Memory(store()).lastWalkCells().size === 0, 'no walks, no last squares');

// Two tabs, each with a walk: the second to end keeps the first's walk,
// squares and key instead of writing over them.
{
  const s2 = store();
  const a = new Memory(s2), b = new Memory(s2);
  for (let k = 0; k < 5; k++) a.visit(59.38 + k * 100 / 111320, 13.5);
  a.closing(dark, new Date(t0));
  for (let k = 3; k < 8; k++) b.visit(59.38 + k * 100 / 111320, 13.5);
  a.endWalk(t0 + H, 'labb1');
  b.endWalk(t0 + 2 * H, 'labb2');
  const both = new Memory(s2);
  check(both.summary().walks === 2 && both.summary().cells === 8 && both.summary().keys.includes('morker'),
    `two tabs: both walks, all squares, the key kept (${JSON.stringify(both.summary())})`);
  check(both.lastWalkCells().size === 3, `the second walk added the three squares the first had not (${both.lastWalkCells().size})`);
}

// Without storage (the simulation) walks still add up.
{
  const n = new Memory(null);
  n.visit(59.38, 13.5); n.endWalk(t0, 'labb1');
  n.visit(59.39, 13.5); n.endWalk(t0 + H, 'labb1');
  check(n.summary().walks === 2 && n.summary().cells === 2, `no storage: two walks, two squares (${JSON.stringify(n.summary())})`);
}

// A key earned is said once even if closing runs twice.
{
  const k = new Memory(store());
  const once = k.closing(dark, new Date(t0));
  const twice = k.closing(dark, new Date(t0));
  check(once.includes('nyckel-morker') && !twice.includes('nyckel-morker'), `a key is said once (${once.join(', ')} / ${twice.join(', ')})`);
}

// A broken entry starts over instead of throwing.
const broken = store();
broken.setItem('glimt-memory', '{not json');
check(new Memory(broken).summary().walks === 0, 'broken storage starts over');

process.exit(failures ? 1 : 0);
