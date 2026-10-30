#!/usr/bin/env node
// Runs episode 2 in English, "Behind the Presses" (glimt/episode2.js), against
// the engine with simulated walkers and a fake clock. No audio, no DOM. Each
// walker takes one way through it: the map's four kinds of place and none,
// the bell first, a near miss, knocks or none, left, right, straight or no
// heading, faster or not, in time with the beats or not, no step rate, a
// runner, stops in the works and behind the presses, the reserve, the three
// answers in scene 5, the end standing or walking on, and the listen.
//
//   node scripts/test_episode2.mjs            # every walker
//   node scripts/test_episode2.mjs woods -v   # one, with its log

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Walk, Waiter, simulatedMagnitude, cadencePace } from '../glimt/engine.js';
import { runEpisode2, TAKT } from '../glimt/episode2.js';
import { Listener, LISTEN_YES, LISTEN_PLAN } from '../glimt/listen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-2.json'), 'utf8'));
const EP1 = JSON.parse(readFileSync(join(ROOT, 'stories/glimt/episode-1.json'), 'utf8'));
const PAUSER = JSON.parse(readFileSync(join(ROOT, 'glimt/pauser.json'), 'utf8'))[EP.id];
// Her reserve is episode 1's two takes (app.js borrows them).
const BORROWED = ['r-hjalp', 'r-vilar'];
const SECONDS = { ...EP.seconds, ...Object.fromEntries(BORROWED.map(id => [id, EP1.seconds[id]])) };

const LAT0 = 59.38, LON0 = 13.5;
const M_LAT = 111320, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const at = (x, y) => ({ lat: LAT0 + y / M_LAT, lon: LON0 + x / M_LON });
// A square of `size` metres, its south-west corner x m east and y m north of the start.
const square = (x, y, size) => [at(x, y), at(x + size, y), at(x + size, y + size), at(x, y + size), at(x, y)];
const PLACES = {
  woods: [{ kind: 'woods', id: 'way/1', area: true, parts: [square(-100, 300, 200)], point: null }],
  water: [{ kind: 'water', id: 'way/2', area: true, parts: [square(-150, 290, 300)], point: null }],
  bridge: [{ kind: 'bridge', id: 'way/3', area: false, parts: [[at(-30, 310), at(30, 310)]], point: null }],
  hill: [{ kind: 'hill', id: 'node/4', area: false, parts: [], point: at(0, 380) }],
  // East of the start, for a walker who walks north and away from it.
  east: [{ kind: 'woods', id: 'way/5', area: true, parts: [square(200, -100, 200)], point: null }],
};

// The walkers. `places`: what the map answers (null: it does not). `memory1`:
// what episode 1 left. `world`: light and rain read. `steps`: the feet read
// (false: GPS only). `on`: what the walker does when a line of hers ends,
// [{do, in, ...}] as the listen's plan; `do` is stop (for `for` s), knock,
// turn (dir), faster (by, for), run (for). `followBeats`: walks at the beats'
// tempo in scene 4. `run`: running from the start until the given line ends.
// `expect`: lines that must be said; `never`: lines that must not; `facts`:
// what she must remember at the end (a subset).
const WALK = 1.4;
const W = {
  woods: {
    places: PLACES.woods, memory1: { svarade: true, misstanke: true }, world: { light: 'dark', rain: false },
    stopHere: 16, on: {
      'x-now': [{ do: 'knock', in: 1.2 }],
      's3-choose': [{ do: 'turn', dir: 'left', in: 8 }],
      's3-fast': [{ do: 'faster', by: 1.3, for: 35, in: 0.5 }],
    },
    followBeats: true, endStop: true,
    expect: ['s0-dark', 's0-susp', 's2-woods', 's2-take', 's2-stop-ans', 's2-here', 's2-oh', 's2-go-again', 's2-held', 's2-saw-woods',
      's2-going', 's2-bell', 's3-yes1', 's3-yes2', 's3-left', 's3-followed', 's3-errand', 's4-instep', 's4-sing', 's5-two'],
    // Still fast from Fortare when the beats start: they start on the song's 135, no pull.
    never: ['s0-nosusp', 's2-stop', 's3-run', 's3-no1', 's3-lost', 's4-hum', 'x-avvikelse', 's5-nothing', 's4-run', 's5-runfree'],
    facts: { place: 'woods', saw: 'woods', bellFirst: false, knock3: true, choice: 'left', faster: true, song: 'whole', knock5: 'knock' },
    song: 'whole',
  },
  water: {
    places: PLACES.water, memory1: { svarade: false, misstanke: false }, world: { light: 'light', rain: true },
    stopHere: 4, on: {'s3-choose': [{ do: 'turn', dir: 'right', in: 10 }] },
    expect: ['s0-nosusp', 's2-water', 's2-stop', 's2-oh', 's2-saw-water', 's3-no1', 's3-right', 's3-lost', 's4-listen', 's4-hum', 's5-nothing'],
    never: ['s0-dark', 's2-stop-ans', 's2-go-again', 's3-yes1', 's4-sing'],
    facts: { place: 'water', saw: 'water', knock3: false, choice: 'right', faster: false, song: 'bits', knock5: 'nothing' },
  },
  bridge: {
    places: PLACES.bridge, memory1: null,
    stopHere: 6, on: {'x-now': [{ do: 'stop', in: 1, for: 8 }] },
    endStop: false,
    expect: ['s0-nosusp', 's2-bridge', 's2-stop', 's2-saw-bridge', 'x-avvikelse', 's3-seen', 's3-allsaid', 's3-straight', 's5-stopped', 's5-habits'],
    never: ['s3-think', 's3-pipe'],
    facts: { place: 'bridge', choice: 'straight', knock5: 'stop' },
  },
  hill: {
    places: PLACES.hill, memory1: { svarade: true, misstanke: false },
    stopHere: 5, on: {'s3-warm': [{ do: 'stop', in: 0.5, for: 16 }], 's4-wall': [{ do: 'stop', in: 0.5, for: 5 }] },
    expect: ['s2-hill', 's2-warm3', 's2-saw-hill', 'x-avvikelse', 's3-think', 's3-pipe'],
    never: ['s3-allsaid'],
    once: ['x-avvikelse', 's3-think', 's3-pipe'],
    facts: { place: 'hill', saw: 'hill' },
  },
  nothing: {
    places: [], world: { light: 'light', rain: false },
    on: { 's2-none2': [{ do: 'stop', in: 40, for: 8 }] },
    expect: ['s2-none1', 's2-none2', 's2-oh', 's2-held', 's2-sky-light', 's2-going'],
    never: ['s2-take', 's2-saw-woods', 's2-bell-first'],
    facts: { place: null, saw: 'sky-light', bellFirst: false },
  },
  'nothing-dark-unread': {
    places: [], world: { light: null, rain: null },
    on: { 's2-none2': [{ do: 'stop', in: 35, for: 8 }] },
    expect: ['s2-oh', 's2-held', 's2-going'],
    never: ['s2-sky-light', 's2-sky-dark', 's2-sky-rain', 's0-dark'],
    facts: { saw: 'nothing read' },
  },
  'nothing-rain': {
    places: [], world: { light: 'dark', rain: true },
    on: { 's2-none2': [{ do: 'stop', in: 45, for: 8 }] },
    expect: ['s2-sky-rain'],
    never: ['s2-sky-dark'],
    facts: { saw: 'sky-rain' },
  },
  'map-fails': {
    places: null,
    expect: ['s2-none1', 's2-none2', 's2-bell-first'],
    never: ['s2-oh', 's2-held'],
    facts: { bellFirst: true },
  },
  'bell-first': {
    places: PLACES.east,
    expect: ['s2-woods', 's2-take', 's2-bell-first'],
    some: [['s2-cold1', 's2-walk1']],
    never: ['s2-oh', 's2-here'],
    facts: { place: 'woods', saw: null, bellFirst: true },
  },
  'near-miss': {
    places: PLACES.woods,
    // 45 m short of the edge (255 m north), then on to it.
    stopAtY: [{ y: 255, for: 6 }],
    stopHere: 5, on: {},
    expect: ['s2-near', 's2-here', 's2-oh', 's2-saw-woods'],
    facts: { saw: 'woods' },
  },
  'no-steps': {
    places: PLACES.woods, steps: false,
    stopHere: 6, on: {'x-now': [{ do: 'knock', in: 1.2 }] },
    expect: ['s2-saw-woods', 's4-sing'],
    never: ['s4-instep', 's4-listen', 's4-pull'],
    facts: { song: 'whole', choice: 'straight' },
  },
  runner: {
    places: PLACES.woods, run: 's3-in',
    stopHere: 6, on: { 's5-carry': [{ do: 'run', in: 0.5, for: 30 }] },
    followBeats: true,
    expect: ['s3-run', 's4-pull', 's4-run', 's5-run', 's5-runfree'],
    facts: { ranAtDoor: true },
  },
  reserve: {
    places: PLACES.woods,
    stopHere: 6, on: {'s5-night': [{ do: 'stop', in: 0.5, for: 45 }] },
    expect: ['r-hjalp', 'r-vilar'],
  },
  'no-song': {
    places: PLACES.woods, song: null, followBeats: true,
    stopHere: 6, on: {},
    expect: ['s4-hum'],
    never: ['s4-sing'],
    facts: { song: 'no song here' },
  },
  'stop-under-song': {
    places: PLACES.woods, followBeats: true,
    stopHere: 6, on: {'s4-clogs2': [{ do: 'stop', in: 25, for: 8 }] },
    expect: ['s4-pull', 's4-sing'],
    tone: true,
  },
  // No GPS from the split to the end of the choice: no heading to read a turn from.
  'gps-gap': {
    places: PLACES.woods, stopHere: 6, gpsOff: ['s3-split', 's3-ours'],
    expect: ['s3-unknown'],
    never: ['s3-straight'],
    facts: { choice: 'unknown' },
  },
  listen: { places: PLACES.water, listen: true, memory1: null, world: { light: 'dark', rain: false },
    expect: ['s2-water', 's2-here', 's2-oh', 's2-saw-water', 's3-yes1', 's3-left', 's3-errand', 's4-instep', 's4-sing', 's5-two'],
    facts: { saw: 'water', knock3: true, choice: 'left', faster: true, song: 'whole', knock5: 'knock' },
  },
  'listen-nothing': { places: [], listen: true, world: { light: 'dark', rain: false },
    expect: ['s2-none2', 's2-oh', 's2-sky-dark'],
    never: ['s2-bell-first'],
  },
};

function simulate(name) {
  const p = W[name];
  const walk = new Walk();
  const waiter = new Waiter();
  const log = [];
  const played = [];
  const sideCalls = [];
  const songs = [];
  let memory = null;
  let t = 0, x = 0, y = 0, heading = 0, ended = false;
  const stops = [];         // {from, to}
  const knocks = [];        // t of each knock sample
  const fasters = [];       // {from, to, by}
  let runUntil = p.run ? Infinity : -Infinity;
  let target = null;        // {latitude, longitude}: the listen steers there
  let bpm = null;           // the beats' tempo while they play
  let current = null;
  const beatTimes = [];
  let nextBeat = null;
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const listener = p.listen ? new Listener(LISTEN_YES.episode2en, null, LISTEN_PLAN.episode2en) : null;

  const act = a => {
    const when = t + (a.in || 0);
    if (a.do === 'stop') stops.push({ from: when, to: a.for ? when + a.for : Infinity });
    if (a.do === 'knock') knocks.push(when, when + 0.3);
    if (a.do === 'turn') waiter.until(s => s.t >= when).then(() => { heading += a.dir === 'left' ? -Math.PI / 2 : Math.PI / 2; log.push(`${fmt(t)}  walker turns ${a.dir}`); });
    if (a.do === 'faster') fasters.push({ from: when, to: when + a.for, by: a.by });
    if (a.do === 'run') fasters.push({ from: when, to: when + a.for, by: 2.8 / WALK });
  };
  let stoppedHere = false, gpsOff = false;
  const ended1 = id => {
    for (const a of (p.on || {})[id] || []) act(a);
    // "Stop here": the walker who stops for her does so the first time.
    if (p.stopHere && !stoppedHere && (id === 's2-here' || id === 's2-byyou')) {
      stoppedHere = true;
      act({ do: 'stop', in: 0.3, for: p.stopHere });
    }
    if (p.run === id) runUntil = t;
    if (p.gpsOff && id === p.gpsOff[0]) gpsOff = true;
    if (p.gpsOff && id === p.gpsOff[1]) gpsOff = false;
    if (listener) {
      const next = listener.ended(id, t);
      if (next === 'stop') stops.push({ from: t, to: Infinity });
      if (next === 'walk') for (const st of stops) if (st.to === Infinity) st.to = t;
      for (const a of listener.plan(id)) {
        const when = t + (a.in || 0);
        if (a.do === 'stop') waiter.until(s => s.t >= when).then(() => { listener.stop(t); stops.push({ from: t, to: Infinity }); });
        else act(a);
      }
    }
  };
  const sound = (id, mark) => {
    const dur = SECONDS[id];
    if (dur === undefined) throw new Error(`unknown line ${id}`);
    log.push(`${fmt(t)}  ▶ ${id}${mark}`);
    played.push({ id, t });
    const me = { id, cut: false };
    return { me, done: waiter.until(() => me.cut, { timeout: dur }).then(() => ended1(id)) };
  };
  const call = what => (...args) => { sideCalls.push({ t, what, args }); };
  const ctx = {
    world: { light: null, rain: null, ...(p.world || {}) },
    state: () => walk.state(),
    position: () => walk.position(),
    log: msg => log.push(`${fmt(t)}  ${msg}  (${walk.tempo.band}${walk.state().cadence ? `, ${Math.round(walk.state().cadence)}/min` : ''})`),
    hold: on => { walk.contact.hold = on; },
    play(id) {
      const { me, done } = sound(id, '');
      current = me;
      return done.then(() => { if (current === me) current = null; return 'ended'; });
    },
    cut() { if (current) { current.cut = true; log.push(`${fmt(t)}  cut`); } },
    until: (pred, opts) => waiter.until(pred, opts),
    fadeOut: s => waiter.until(() => false, { timeout: s }).then(() => {}),
    seconds: id => SECONDS[id] || 0,
    cue: (id, word) => ((EP.cues || {})[id] || {})[word] || 0,
    remember: facts => { memory = { ...facts }; },
    pauses: PAUSER,
    memory1: p.memory1 === undefined ? { svarade: false, misstanke: false } : p.memory1,
    findPlaces: () => waiter.until(() => false, { timeout: 2 }).then(() => p.places === undefined ? [] : p.places),
    setTarget: c => { target = c; log.push(`${fmt(t)}  target ${c ? 'set' : 'cleared'}`); },
    gyroStatus: () => ({ ok: false, why: 'sim' }),
    gyroTurn: () => null,
    beats(b) {
      bpm = b;
      nextBeat = t + 0.1;
      log.push(`${fmt(t)}  beats at ${b}`);
      return {
        beats: beatTimes,
        set(o) { if (o.bpm) bpm = o.bpm; },
        stop() { bpm = null; log.push(`${fmt(t)}  beats stop`); },
      };
    },
    song: () => Promise.resolve(p.song === null ? null : { duration: 238.2 }),
    playSong(buf, o) {
      const s = { at: o.at, share: o.share, levels: [], faded: false, t };
      songs.push(s);
      log.push(`${fmt(t)}  song at ${o.at.toFixed(2)} (share ${o.share})`);
      return { done: Promise.resolve('ended'), setLevel: (v, sec) => s.levels.push({ t, v }), fade: () => { s.faded = true; } };
    },
    audioTime: () => t,
    side: {
      walk: call('walk'), other: call('other'), hand: call('hand'), tone: call('tone'), knock: call('knock'),
      bell: call('bell'), lift: call('lift'), pin: call('pin'), fade: call('fade'), breath: call('breath'),
      say: (id, kind) => sound(id, ` (her side, ${kind})`).done,
    },
  };

  const done = runEpisode2(ctx).then(() => { ended = true; }, err => { log.push(`ERROR ${err.stack}`); ended = true; });
  let stoppedAtY = new Set();
  return (async () => {
    while (!ended && t < 40 * 60) {
      let speed = WALK;
      if (t < runUntil) speed = 2.8;
      if (p.followBeats || p.listen) {
        if (bpm && bpm >= 100) speed = cadencePace(bpm);
      }
      for (const f of fasters) if (t >= f.from && t < f.to) speed = WALK * f.by;
      for (const [i, s] of (p.stopAtY || []).entries()) {
        if (!stoppedAtY.has(i) && y >= s.y) { stoppedAtY.add(i); stops.push({ from: t, to: t + s.for }); log.push(`${fmt(t)}  walker stops at ${Math.round(y)} m north`); }
      }
      if (p.endStop && played.some(e => e.id === 's5-home') && t > played.find(e => e.id === 's5-home').t + SECONDS['s5-home']) speed = 0;
      if (stops.some(st => t >= st.from && t < st.to)) speed = 0;
      if (target && p.listen) {
        const here = walk.position();
        if (here) {
          const dy = (target.latitude - here.latitude) * M_LAT, dx = (target.longitude - here.longitude) * M_LON;
          if (Math.hypot(dx, dy) > 3) heading = Math.atan2(dx, dy);
        }
      }
      if (p.steps !== false) {
        for (let u = t - 0.24; u <= t + 1e-9; u += 0.02) {
          let m = simulatedMagnitude(u, speed);
          if (knocks.some(k => u >= k && u < k + 0.02)) m = 9.81 + 40;
          walk.motion(u, m);
        }
      }
      if (bpm) while (nextBeat <= t + 0.25) { beatTimes.push(nextBeat); nextBeat += 60 / bpm; }
      if (Number.isInteger(t)) {
        y += speed * Math.cos(heading);
        x += speed * Math.sin(heading);
        if (!gpsOff) walk.fix(t, { latitude: LAT0 + y / M_LAT, longitude: LON0 + x / M_LON, accuracy: 8, speed: speed + (speed ? Math.sin(t * 1.7) * 0.05 : 0) });
      }
      waiter.check(walk.tick(t));
      await new Promise(r => setImmediate(r));
      t = Math.round((t + 0.25) * 4) / 4;
    }
    await Promise.race([done, Promise.resolve()]);
    return { log, played, sideCalls, songs, memory, ended, t, beats: beatTimes };
  })();
}

const only = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
const verbose = process.argv.includes('-v');
let failures = 0;
const fail = (name, msg) => { failures++; console.log(`  FAIL ${name}: ${msg}`); };
const allPlayed = new Set();

for (const name of Object.keys(W)) {
  if (only && name !== only) continue;
  const p = W[name];
  const r = await simulate(name);
  const ids = r.played.map(e => e.id);
  ids.forEach(id => allPlayed.add(id));
  if (verbose) console.log(r.log.join('\n'));
  const errors = r.log.filter(l => l.startsWith('ERROR'));
  for (const e of errors) fail(name, e);
  if (!r.ended) fail(name, `did not end (t ${Math.round(r.t)} s)`);
  for (const id of p.expect || []) if (!ids.includes(id)) fail(name, `${id} not said`);
  for (const id of p.never || []) if (ids.includes(id)) fail(name, `${id} said`);
  for (const id of p.once || []) if (ids.filter(i => i === id).length !== 1) fail(name, `${id} said ${ids.filter(i => i === id).length} times, not once`);
  for (const group of p.some || []) if (!group.some(id => ids.includes(id))) fail(name, `none of ${group.join(', ')} said`);
  for (const [k, v] of Object.entries(p.facts || {})) {
    if (!r.memory || r.memory[k] !== v) fail(name, `remembers ${k} = ${r.memory && JSON.stringify(r.memory[k])}, not ${JSON.stringify(v)}`);
  }
  if (!r.memory || !r.memory.klar) fail(name, 'the end not remembered');
  // Every line once at most, apart from those said again after a stop cut them.
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i && !/^x-|^s2-(warm|cold|almost|close|byyou)|^s3-wait/.test(id)))];
  for (const id of twice) if (!r.log.some(l => l.includes('cut'))) fail(name, `${id} said twice`);
  // The song in phase: its first beat on a scheduled beat.
  for (const s of r.songs) {
    const first = s.at + TAKT.firstBeat;
    if (!r.beats.some(b => Math.abs(b - first) < 0.01)) fail(name, `the song's first beat at ${first.toFixed(2)} is on no beat`);
  }
  if (p.song === 'whole' && !(r.songs[0] && r.songs[0].share === 1)) fail(name, 'the song did not come whole');
  if (p.tone && !r.sideCalls.some(c => c.what === 'tone' && c.args[0] === true)) fail(name, 'no tone for a stop under the song');
  const mins = (r.played.length ? r.played[r.played.length - 1].t : 0) / 60;
  console.log(`${name.padEnd(20)} ${mins.toFixed(1)} min, ${ids.length} lines, ${JSON.stringify(r.memory && { ...r.memory, klar: undefined })}`);
}

// Every line of the episode is said by some walker, except the opening
// straight after episode 1 (OM DIREKT), which the app cannot reach yet.
if (!only) {
  const unreachable = ['s0-d1', 's0-d2', 's0-d3', 's0-d4'];
  const missing = Object.keys(EP.lines).filter(id => !allPlayed.has(id) && !unreachable.includes(id));
  if (missing.length) fail('coverage', `never said: ${missing.join(', ')}`);
  else console.log(`coverage: every line said by some walker, but ${unreachable.join(', ')} (straight after episode 1, not built)`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall walkers passed');
process.exit(failures ? 1 : 0);
