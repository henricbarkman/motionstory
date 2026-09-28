#!/usr/bin/env node
// Replays a walk saved with "Spara sensordata" through the engine, as the
// phone ran it: every sample into Walk.motion, every fix into Walk.fix, a
// tick every 250 ms. Prints what the step and knock detectors made of it, so
// thresholds can be set from a real pocket instead of a guess.
//
//   node scripts/replay_sensor.mjs <file.json> [--from s] [--to s] [--all]
//
// Without --all only knock-level spikes are listed; --all lists every spike.
// Each spike line says how far it sits from the nearest detected step, which
// is the question Knacket's first walks left open: are the stray "knocks"
// heel strikes, and do real knocks land between steps?
import { readFileSync } from 'node:fs';
import { Walk } from '../glimt/engine.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^\d/.test(a));
const opt = name => { const i = args.indexOf(name); return i >= 0 ? parseFloat(args[i + 1]) : null; };
const from = opt('--from') ?? 0;
const to = opt('--to') ?? Infinity;
const all = args.includes('--all');
if (!file) { console.error('usage: replay_sensor.mjs <file.json> [--from s] [--to s] [--all]'); process.exit(2); }

const rec = JSON.parse(readFileSync(file, 'utf8'));
if (rec.kind !== 'glimt-sensor') { console.error(`${file}: not a Glimt sensor file`); process.exit(2); }

const walk = new Walk();
const spikes = [], steps = [], doubles = [], bands = [];
const origSpike = walk.knocks._spike.bind(walk.knocks);
walk.knocks._spike = (t, peak) => {
  const before = walk.knocks.count;
  origSpike(t, peak);
  spikes.push({ t, peak, knock: walk.knocks.count > before, muted: t < walk.knocks.mutedUntil, band: walk.tempo.band });
};
const origStep = walk.steps._step.bind(walk.steps);
walk.steps._step = t => { steps.push(t); origStep(t); };

const ORIGIN = { latitude: 59.38, longitude: 13.5 };
const fixes = (rec.fixes || []).map(([t, north, east, accuracy, speed]) => ({
  t: t / 1000,
  coord: {
    latitude: ORIGIN.latitude + north / 111320,
    longitude: ORIGIN.longitude + east / (111320 * Math.cos(ORIGIN.latitude * Math.PI / 180)),
    accuracy, speed,
  },
}));

let fi = 0, nextTick = 0.25, lastDouble = -Infinity, band = null;
const tickUntil = t => {
  while (nextTick <= t) {
    while (fi < fixes.length && fixes[fi].t <= nextTick) { walk.fix(fixes[fi].t, fixes[fi].coord); fi++; }
    const s = walk.tick(nextTick);
    if (s.band !== band) { bands.push({ t: nextTick, band: s.band, cadence: walk.steps.cadence(nextTick), source: s.paceSource }); band = s.band; }
    if (s.lastDoubleKnockAt > lastDouble) { lastDouble = s.lastDoubleKnockAt; doubles.push(lastDouble); }
    nextTick = Math.round((nextTick + 0.25) * 1000) / 1000;
  }
};
for (let i = 0; i < rec.t.length; i++) {
  const t = rec.t[i] / 1000;
  tickUntil(t);
  walk.motion(t, rec.m[i] / 100);
}
tickUntil(rec.t.length ? rec.t[rec.t.length - 1] / 1000 + 1 : 0);

const f1 = x => x.toFixed(1);
const f2 = x => x.toFixed(2);
const clock = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const inRange = t => t >= from && t <= to;

// Distance to the nearest step, signed: negative before it, positive after.
const nearestStep = t => {
  let best = null;
  for (const s of steps) { if (best === null || Math.abs(t - s) < Math.abs(best)) best = t - s; if (s > t + 2) break; }
  return best;
};

const gaps = rec.t.slice(1).map((t, i) => t - rec.t[i]).sort((a, b) => a - b);
const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
const dur = rec.t.length ? rec.t[rec.t.length - 1] / 1000 : 0;
console.log(`${file}\n  build ${rec.build}, kapitel ${rec.chapter}${rec.station ? `, bara ${rec.station}` : ''}, sparad ${rec.saved}`);
console.log(`  ${rec.t.length} samples over ${clock(dur)}, median ${medGap} ms apart (${medGap ? Math.round(1000 / medGap) : '?'} Hz), ${gaps.filter(g => g > 1000).length} gaps over 1 s, ${fixes.length} fixes`);
console.log(`  ${steps.length} steps, ${spikes.length} spikes, ${spikes.filter(s => s.knock).length} knocks, ${doubles.length} doubles`);

const events = [];
for (const [t, msg] of rec.log || []) events.push({ t: t / 1000, line: `LOG     ${msg}` });
for (const b of bands) events.push({ t: b.t, line: `BAND    ${b.band} (${Math.round(b.cadence)} steg/min, ${b.source})` });
for (const d of doubles) events.push({ t: d, line: 'DOUBLE  heard' });
for (const s of spikes) {
  if (!all && !s.knock && !s.muted) continue;
  const near = nearestStep(s.t);
  const tag = s.knock ? 'KNOCK ' : s.muted ? 'MUTED ' : 'spike ';
  events.push({ t: s.t, line: `${tag}  ${f1(s.peak).padStart(5)}  step ${near === null ? '   -' : `${near >= 0 ? '+' : ''}${f2(near)}s`}  ${s.band}` });
}
events.sort((a, b) => a.t - b.t);
console.log('');
for (const e of events) if (inRange(e.t)) console.log(`${clock(e.t).padStart(8)}  ${e.line}`);
