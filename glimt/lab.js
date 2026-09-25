// The mechanics lab. Short stations, one mechanic each, almost no story:
// Vega says what to do and the body does it. Built 2026-09-25 after Henric
// and Demi decided that the mechanics go first and the lore follows (see
// PROGRESS.md). Each station ends with an outcome for the log, and the end
// screen asks the walker which ones they would do again.
//
// Same ctx contract as the chapters (play, until, state, log, hold, world),
// plus:
//   sfx            the placeholder sounds (synth.js)
//   vibrate(p)     vibrates a pattern, returns its length in seconds (0 when
//                  the phone cannot), and keeps the knock detector deaf meanwhile
//   setTarget(c)   a place to walk to; state.distToTarget follows it
//   position()     the newest decent fix, positionAgo(s) an older one
//   knocksBetween(a, b), knockTimes(a, b), spikesBetween(a, b), strayDoubles(w)
//                  what the knock detector heard
//   track()        decent fixes, last two minutes: [{t, latitude, longitude}]
//   impactsBetween(a, b)  how hard each step landed: [{t, peak}]
//   memo           an object that lives for the whole walk, for baselines
//   station(id)    tells the screen which station is running
//   result(id, r)  hands a station's outcome to the end screen
//
// labHelpers() builds the walk-derived half of that, so the app and the
// simulation (scripts/test_lab.mjs) run the same code instead of two copies.
//
// Every station returns { outcome: 'klarade' | 'missade' | 'hoppade', detail }.

import { haversine, bearing, angleDiff } from './engine.js';

export function labHelpers(walk, { now, vibrateImpl }) {
  return {
    position: () => walk.position(),
    positionAgo: s => walk.positionAgo(now(), s),
    track: () => walk.track,
    impactsBetween: (a, b) => walk.steps.impacts.filter(x => x.t > a && x.t <= b),
    setTarget: c => walk.setTarget(c),
    knocksBetween: (a, b) => walk.knocks.countBetween(a, b),
    knockTimes: (a, b) => walk.knocks.times.filter(k => k > a && k <= b),
    spikesBetween: (a, b) => walk.knocks.spikes.filter(x => x.t > a && x.t <= b),
    strayDoubles: windows => walk.knocks.history.filter(t => !windows.some(([a, b]) => t >= a && t <= b)).length,
    // Seconds the pattern lasts, or 0 when the phone would not vibrate. The
    // motor shakes the sensor, so knocks do not count until it has stopped.
    vibrate(pattern) {
      let ok = false;
      try { ok = !!vibrateImpl(pattern); } catch (_) { ok = false; }
      if (!ok) return 0;
      const len = pattern.reduce((a, b) => a + b, 0) / 1000;
      walk.knocks.mute(now() + len + 0.25);
      return len;
    },
  };
}

export const LABS = {
  1: ['linjen', 'ja', 'knack', 'takten', 'flykten', 'frys', 'spoket', 'hitta'],
  2: ['normalt', 'vandom', 'vagval', 'kompass', 'morse', 'vibration', 'tassa'],
};

export const TITLES = {
  linjen: 'Stämma linjen', ja: 'Stanna för ja', knack: 'Knacket', takten: 'Takten',
  flykten: 'Flykten', frys: 'Frys', spoket: 'Spöket', hitta: 'Hitta',
  normalt: 'Gå normalt', vandom: 'Vänd om', vagval: 'Vägvalet', kompass: 'Ljudkompassen',
  morse: 'Kroppsmorse', vibration: 'Hon knackar', tassa: 'Tassa',
};

const DEFAULT_PACE = 1.4;       // m/s, a walk, when no baseline was measured
const DEFAULT_CADENCE = 112;

// ---------- small helpers ----------

const wait = (ctx, seconds) => ctx.until(() => false, { timeout: seconds });

// Runs fn(state, dt) on every tick until the returned stop() is called. The
// waiter checks every pending predicate on every tick, so this keeps running
// while the station awaits a line or another condition.
function every(ctx, fn) {
  let stopped = false;
  let last = null;
  ctx.until(s => {
    if (stopped) return true;
    const dt = last === null ? 0 : Math.max(0, s.t - last);
    last = s.t;
    fn(s, dt);
    return false;
  });
  return () => { stopped = true; };
}

const pct = x => `${Math.round(x * 100)} %`;
const sec = x => `${x.toFixed(1).replace('.', ',')} s`;
const kmh = v => `${((v || 0) * 3.6).toFixed(1).replace('.', ',')} km/h`;
const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
};

// A question answered by stopping. Resolves {yes, after}: yes when the walker
// is still for three seconds within `window` seconds of the line ending (or
// already stands still when it ends), `after` the seconds that took.
async function askStop(ctx, id, { window = 20 } = {}) {
  await ctx.play(id);
  const t0 = ctx.state().t;
  const yes = await ctx.until(s => s.stillFor >= 3, { timeout: window });
  return { yes, after: ctx.state().t - t0 };
}

// After a yes: the walker walks on before the next thing starts.
const walkOn = ctx => ctx.until(s => s.moving && s.movingFor >= 2, { timeout: 30 });

// A point `dist` metres from `from` along `deg` degrees.
function offset(from, dist, deg) {
  const r = deg * Math.PI / 180;
  const lat = from.latitude + dist * Math.cos(r) / 111320;
  const lon = from.longitude + dist * Math.sin(r) / (111320 * Math.cos(from.latitude * Math.PI / 180));
  return { latitude: lat, longitude: lon };
}

// A place to find: the landmark from the map when it is within reach, else a
// point a short walk away in a random direction. Returns {coord, kind}.
function pickTarget(ctx, { maxLandmark = 350, near = [110, 160] } = {}) {
  const here = ctx.position();
  const w = ctx.world;
  if (here && w.landmarkCoord) {
    const lm = { latitude: w.landmarkCoord.lat, longitude: w.landmarkCoord.lon };
    const d = haversine(here, lm);
    if (d <= maxLandmark && d >= 40) return { coord: lm, kind: w.landmark, dist: d };
  }
  if (!here) return null;
  const dist = near[0] + Math.random() * (near[1] - near[0]);
  return { coord: offset(here, dist, Math.random() * 360), kind: 'plats', dist };
}

// ---------- stations ----------

// Stämma linjen, and the third field test: an even pace clears the line,
// an uneven one hisses. Then a stop of fifteen seconds that the log times.
// Records the walker's own pace for Spöket and the baselines for the rest.
async function linjen(ctx) {
  const noise = ctx.sfx.staticNoise({ level: 0.4 });
  const paces = [];
  const recent = [];
  let steadyTime = 0, movingTime = 0, steadyRun = 0, praised = false;
  const ghost = [];
  let ghostStart = null;

  const stop = every(ctx, (s, dt) => {
    recent.push({ t: s.t, v: s.pace });
    while (recent.length && recent[0].t < s.t - 10) recent.shift();
    if (!s.moving) { noise.set({ level: 0.15 }); steadyRun = 0; return; }
    movingTime += dt;
    paces.push(s.pace);
    if (s.cadence) ctx.memo.cadences.push(s.cadence);
    if (ghostStart === null) ghostStart = { t: s.t, odo: s.odo };
    ghost.push({ dt: s.t - ghostStart.t, odo: s.odo - ghostStart.odo });
    const vs = recent.filter(r => r.v > 0).map(r => r.v);
    if (vs.length < 8) return;
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
    const cv = mean ? sd / mean : 1;
    noise.set({ level: Math.min(1, Math.max(0, (cv - 0.04) / 0.16)) });
    if (cv < 0.1) { steadyTime += dt; steadyRun += dt; } else steadyRun = 0;
  });

  await ctx.play('linjen-intro');
  // About seventy seconds of tuning, with one word of praise the first time
  // the walker holds it for ten seconds.
  const tuneEnd = ctx.state().t + 70;
  while (ctx.state().t < tuneEnd) {
    const held = await ctx.until(() => !praised && steadyRun >= 10, { by: tuneEnd });
    if (!held) break;
    praised = true;
    await ctx.play('linjen-bra');
  }
  stop();
  noise.stop();
  // `||`, not `??`: a median of 0 (stood still through the station) is no
  // pace to chase or flee at, so it falls back like an empty one.
  ctx.memo.basePace = median(paces) || ctx.memo.basePace;
  ctx.memo.baseCadence = median(ctx.memo.cadences) || ctx.memo.baseCadence;
  if (ghost.length > 20) ctx.memo.ghost = ghost;
  const steadyShare = movingTime ? steadyTime / movingTime : 0;

  // The stop. Timed from the end of the line: the walker's reaction plus the
  // phone's delay, which is what the field test is about.
  ctx.hold(true);
  await ctx.play('linjen-stanna');
  const asked = ctx.state().t;
  const src = ctx.state().paceSource;
  const stopped = await ctx.until(s => !s.moving, { timeout: 25 });
  const stopAfter = ctx.state().t - asked;
  await wait(ctx, 15);
  await ctx.play('linjen-ga');
  const goAsked = ctx.state().t;
  const went = await ctx.until(s => s.moving, { timeout: 20 });
  const goAfter = ctx.state().t - goAsked;
  await ctx.play('linjen-slut');

  const s = ctx.state();
  const detail = [
    `jämn ${pct(steadyShare)} av gångtiden`,
    `takt ${ctx.memo.basePace ? (ctx.memo.basePace * 3.6).toFixed(1).replace('.', ',') + ' km/h' : 'okänd'}` +
      (ctx.memo.baseCadence ? `, ${Math.round(ctx.memo.baseCadence)} steg/min` : ''),
    stopped ? `stopp läst efter ${sec(stopAfter)} (${src === 'steps' ? 'steg' : 'gps'})` : 'stoppet lästes aldrig',
    went ? `gång igen efter ${sec(goAfter)}` : 'gången igen lästes aldrig',
    s.stepsTrusted ? 'stegen avgör' : 'gps avgör',
  ].join(', ');
  return { outcome: stopped && went ? 'klarade' : 'missade', detail };
}

// Stanna för ja, three questions with known answers.
async function ja(ctx) {
  await ctx.play('ja-intro');
  const answers = [];
  const qs = ['ja-q1', ctx.world.light === 'dark' ? 'ja-q2-morkt' : 'ja-q2-ljust', 'ja-q3'];
  for (const q of qs) {
    const a = await askStop(ctx, q);
    answers.push(a);
    ctx.log(`${q}: ${a.yes ? `ja efter ${sec(a.after)}` : 'nej'}`);
    await ctx.play(a.yes ? 'ja-svar-ja' : 'ja-svar-nej');
    if (a.yes) await walkOn(ctx);
    await wait(ctx, 4);
  }
  await ctx.play('ja-slut');
  const yes = answers.filter(a => a.yes);
  const detail = `${answers.map(a => a.yes ? 'ja' : 'nej').join('/')}` +
    (yes.length ? `, svar efter ${yes.map(a => sec(a.after)).join(' / ')}` : '');
  // The first two have a known yes. Missing them is the phone, not the walker.
  return { outcome: answers[0].yes && answers[1].yes ? 'klarade' : 'missade', detail };
}

// Knacket: a double knock through the pocket, standing, then walking, then
// as the answer to a question.
async function knack(ctx) {
  const spikeNote = (from, to) => {
    const sp = ctx.spikesBetween(from, to);
    if (!sp.length) return 'inga utslag';
    const max = Math.max(...sp.map(x => x.peak));
    return `${sp.length} utslag, högst ${max.toFixed(1).replace('.', ',')}`;
  };

  // Knocks asked for count from the start of the asking line (an eager
  // walker knocks before Vega has finished) to a few seconds after the wait,
  // so none of them is later counted as the detector hearing things.
  const windowFrom = ctx.state().t;
  const closeWindow = () => ctx.memo.knockWindows.push([windowFrom, ctx.state().t + 3]);

  await ctx.play('knack-intro');
  let asked = ctx.state().t;
  let standing = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  if (!standing) {
    ctx.log(`knack stående, första försöket: ${spikeNote(asked, ctx.state().t)}`);
    await ctx.play('knack-igen');
    asked = ctx.state().t;
    standing = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  }
  ctx.log(`knack stående: ${standing ? 'hört' : 'inte hört'} (${spikeNote(asked, ctx.state().t)})`);
  await ctx.play(standing ? 'knack-hord' : 'knack-inget');

  await ctx.play('knack-ga');
  await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 15 });
  asked = ctx.state().t;
  const walking = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 25 });
  ctx.log(`knack gående: ${walking ? 'hört' : 'inte hört'} (${spikeNote(asked, ctx.state().t)})`);
  await ctx.play(walking ? 'knack-hord' : 'knack-inget-ga');

  await ctx.play('knack-fraga');
  asked = ctx.state().t;
  const prefers = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  closeWindow();
  await ctx.play(prefers ? 'knack-ja' : 'knack-nej');

  const detail = `stående ${standing ? 'hört' : 'missat'}, gående ${walking ? 'hört' : 'missat'}, ` +
    `föredrar ${prefers ? 'knack' : 'stopp (eller hördes inte)'}`;
  return { outcome: standing ? 'klarade' : 'missade', detail };
}

// Takten: a beat at the walker's own cadence, then faster, then slower.
// In step, a chord fades in under it.
async function takten(ctx) {
  if (!ctx.state().stepsTrusted) {
    await ctx.until(s => s.stepsTrusted, { timeout: 20 });
  }
  if (!ctx.state().stepsTrusted) {
    await ctx.play('takten-dov');
    return { outcome: 'hoppade', detail: 'stegräkningen hittade ingen rytm, takten går inte att mäta' };
  }
  const base = Math.round(ctx.memo.baseCadence || ctx.state().cadence || DEFAULT_CADENCE);
  await ctx.play('takten-intro');
  const beat = ctx.sfx.beat({ bpm: base });
  const pad = ctx.sfx.pad({ level: 0 });
  let bpm = base, level = 0, syncRun = 0;
  const share = {};
  let phase = 'lika';
  const stop = every(ctx, (s, dt) => {
    const ok = s.cadence > 0 && Math.abs(s.cadence - bpm) / bpm < 0.05;
    level += ((ok ? 1 : 0) - level) * Math.min(1, dt / 2);
    pad.set({ level });
    syncRun = ok ? syncRun + dt : 0;
    share[phase] = share[phase] || { in: 0, all: 0 };
    share[phase].all += dt;
    if (ok) share[phase].in += dt;
  });

  let praised = false;
  const segment = async seconds => {
    const end = ctx.state().t + seconds;
    while (ctx.state().t < end) {
      const hit = await ctx.until(() => !praised && syncRun >= 5, { by: end });
      if (!hit) break;
      praised = true;
      await ctx.play('takten-i');
    }
  };
  // The first beat is the walker's own cadence, so being in time there says
  // nothing: it is where the ear learns the sound. Only the changes count.
  await segment(25);
  phase = 'fortare'; bpm = Math.round(base * 1.08); beat.set({ bpm });
  await ctx.play('takten-fortare');
  await segment(35);
  phase = 'saktare'; bpm = Math.round(base * 0.93); beat.set({ bpm });
  await ctx.play('takten-saktare');
  await segment(35);
  stop();
  beat.stop();
  pad.stop();
  await ctx.play('takten-slut');
  const part = k => share[k] && share[k].all ? pct(share[k].in / share[k].all) : '–';
  const changed = ['fortare', 'saktare'].reduce((a, k) => {
    const x = share[k] || { in: 0, all: 0 };
    return { in: a.in + x.in, all: a.all + x.all };
  }, { in: 0, all: 0 });
  const followed = changed.all ? changed.in / changed.all : 0;
  return {
    outcome: followed >= 0.4 ? 'klarade' : 'missade',
    detail: `slag ${base}/${Math.round(base * 1.08)}/${Math.round(base * 0.93)}, i takt ${part('lika')} / ${part('fortare')} / ${part('saktare')}`,
  };
}

// Flykten: footsteps behind, faster than the walker's usual pace. Get away.
async function flykten(ctx) {
  const base = ctx.memo.basePace || DEFAULT_PACE;
  const speed = base * 1.35;
  let d = 25;
  const steps = ctx.sfx.footsteps({ rate: 128, distance: d });
  await ctx.play('flykten-intro');
  let warned = false, maxPace = 0;
  const t0 = ctx.state().t;
  const stop = every(ctx, (s, dt) => {
    d += (s.pace - speed) * dt;
    maxPace = Math.max(maxPace, s.pace);
    steps.set({ distance: Math.max(1, d) });
  });
  let result = null;
  while (result === null) {
    const hit = await ctx.until(() => d >= 55 || d <= 2 || (!warned && d < 12), { timeout: 100 - (ctx.state().t - t0) });
    if (!hit) { result = d > 25 ? 'undan' : 'fast'; break; }
    if (d >= 55) result = 'undan';
    else if (d <= 2) result = 'fast';
    else { warned = true; await ctx.play('flykten-narmare'); }
  }
  stop();
  steps.stop();
  const took = ctx.state().t - t0;
  await ctx.play(result === 'undan' ? 'flykten-undan' : 'flykten-fast');
  return {
    outcome: result === 'undan' ? 'klarade' : 'missade',
    detail: `${result === 'undan' ? 'kom undan' : 'hanns ikapp'} efter ${sec(took)}, ` +
      `förföljaren ${(speed * 3.6).toFixed(1).replace('.', ',')} km/h, du som mest ${(maxPace * 3.6).toFixed(1).replace('.', ',')} km/h`,
  };
}

// Frys: something passes. Stand completely still until it has gone.
async function frys(ctx) {
  await ctx.play('frys-intro');
  await ctx.until(s => s.moving && s.movingFor >= 5, { timeout: 20 });
  await wait(ctx, 5 + Math.random() * 10);
  await ctx.play('frys-nu');
  const asked = ctx.state().t;
  const src = ctx.state().paceSource;
  ctx.sfx.passing({ seconds: 18 });
  const stopped = await ctx.until(s => !s.moving, { timeout: 9 });
  if (!stopped) {
    await ctx.play('frys-sen');
    return { outcome: 'missade', detail: `inget stopp inom 9 s (${src === 'steps' ? 'steg' : 'gps'})` };
  }
  const still = ctx.state().t;
  const moved = await ctx.until(s => s.moving, { timeout: Math.max(8, asked + 18 - still) });
  const m = ctx.state();
  const at = m.t - still;
  // What read as movement, so a real walk's log can tell a step from a jump.
  const why = m.paceSource === 'steps' ? `steg ${Math.round(m.cadence)}/min` : `gps ${kmh(m.pace)}`;
  await ctx.play(moved ? 'frys-rorde' : 'frys-klarade');
  return {
    outcome: moved ? 'missade' : 'klarade',
    detail: `stopp läst efter ${sec(still - asked)}` + (moved ? `, rörelse efter ${sec(at)} (${why})` : ', stod still tills det passerat'),
  };
}

// Spöket: the walker's own pace from Stämma linjen, ten percent faster, as
// footsteps behind. Stay ahead of yourself for ninety seconds.
async function spoket(ctx) {
  const ghost = ctx.memo.ghost;
  const base = ctx.memo.basePace || DEFAULT_PACE;
  // The recorded walk as speed over time, looped if the chase runs longer.
  const ghostSpeed = tau => {
    if (!ghost || ghost.length < 2) return base * 1.1;
    const span = ghost[ghost.length - 1].dt;
    const x = span > 0 ? tau % span : 0;
    let i = 1;
    while (i < ghost.length - 1 && ghost[i].dt < x) i++;
    const a = ghost[i - 1], b = ghost[i];
    const v = b.dt > a.dt ? (b.odo - a.odo) / (b.dt - a.dt) : base;
    return v * 1.1;
  };
  let d = 10;
  const steps = ctx.sfx.footsteps({ rate: Math.round(ctx.memo.baseCadence || DEFAULT_CADENCE), distance: d });
  await ctx.play('spoket-intro');
  const t0 = ctx.state().t;
  let warned = false, closest = d;
  const stop = every(ctx, (s, dt) => {
    d += (s.pace - ghostSpeed(s.t - t0)) * dt;
    closest = Math.min(closest, d);
    steps.set({ distance: Math.max(1, d) });
  });
  let caught = false;
  while (true) {
    const hit = await ctx.until(() => d <= 0 || (!warned && d < 4), { by: t0 + 90 });
    if (!hit) break;
    if (d <= 0) { caught = true; break; }
    warned = true;
    await ctx.play('spoket-narmare');
  }
  stop();
  steps.stop();
  await ctx.play(caught ? 'spoket-forbi' : 'spoket-klarade');
  return {
    outcome: caught ? 'missade' : 'klarade',
    detail: `${ghost ? 'din egen takt från Stämma linjen' : 'en schablon (ingen inspelad takt)'} +10 %, ` +
      (caught ? `omsprungen efter ${sec(ctx.state().t - t0)}` : `som närmast ${Math.max(0, closest).toFixed(0)} m`),
  };
}

// Hitta: warmer or colder, in words, towards a real place.
async function hitta(ctx) {
  let target = pickTarget(ctx);
  if (!target) {
    await ctx.until(() => !!ctx.position(), { timeout: 20 });
    target = pickTarget(ctx);
  }
  if (!target) {
    await ctx.play('hitta-ingps');
    return { outcome: 'hoppade', detail: 'ingen position att utgå från' };
  }
  ctx.setTarget(target.coord);
  const intro = target.kind === 'plats' ? 'hitta-intro-plats' : `hitta-intro-${target.kind}`;
  await ctx.play(intro);
  const t0 = ctx.state().t;
  const limit = t0 + 5 * 60;
  let lastD = ctx.state().distToTarget ?? target.dist;
  let near = false, found = false;
  while (ctx.state().t < limit) {
    const arrived = await ctx.until(s => s.distToTarget !== null && s.distToTarget < 25, { timeout: Math.min(25, limit - ctx.state().t) });
    if (arrived) { found = true; break; }
    const d = ctx.state().distToTarget;
    if (d === null) continue;
    if (!near && d < 60) { near = true; await ctx.play('hitta-nara'); }
    else if (d < lastD - 8) await ctx.play('hitta-varmare');
    else if (d > lastD + 8) await ctx.play('hitta-kallare');
    lastD = d;
  }
  ctx.setTarget(null);
  await ctx.play(found ? 'hitta-framme' : 'hitta-tid');
  return {
    outcome: found ? 'klarade' : 'missade',
    detail: `${target.kind === 'plats' ? 'en punkt' : target.kind} ${Math.round(target.dist)} m bort, ` +
      (found ? `framme efter ${sec(ctx.state().t - t0)}` : `${Math.round(lastD)} m kvar när tiden tog slut`),
  };
}

// Gå normalt: a baseline, then a minute of exactly that pace.
async function normalt(ctx) {
  await ctx.play('normalt-intro');
  const useCadence = ctx.state().stepsTrusted;
  const measure = s => useCadence ? s.cadence : s.pace;
  const samples = [];
  const stopBase = every(ctx, s => { if (s.moving && measure(s) > 0) samples.push(measure(s)); });
  await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 20 });
  await wait(ctx, 15);
  stopBase();
  const base = median(samples) || (useCadence ? DEFAULT_CADENCE : DEFAULT_PACE);
  await ctx.play('normalt-nu');
  const noise = ctx.sfx.staticNoise({ level: 0 });
  let off = 0, breaches = 0, maxDev = 0;
  const stop = every(ctx, (s, dt) => {
    const v = measure(s);
    const dev = v > 0 ? Math.abs(v - base) / base : 1;
    maxDev = Math.max(maxDev, dev);
    noise.set({ level: dev / 0.15 });
    off = dev > 0.12 ? off + dt : 0;
  });
  const end = ctx.state().t + 60;
  let noticed = false;
  while (ctx.state().t < end) {
    const hit = await ctx.until(() => off >= 3, { by: end });
    if (!hit) break;
    breaches++;
    off = 0;
    if (breaches === 1) await ctx.play('normalt-varning');
    else { noticed = true; break; }
  }
  stop();
  noise.stop();
  await ctx.play(noticed ? 'normalt-marktes' : 'normalt-klarade');
  return {
    outcome: noticed ? 'missade' : 'klarade',
    detail: `mätt på ${useCadence ? 'steg/min' : 'fart'}, ${breaches} ${breaches === 1 ? 'avvikelse' : 'avvikelser'}, störst ${pct(Math.min(maxDev, 9.99))}`,
  };
}

// The mean of the fixes in (from, to], or null when there are none.
function meanPosition(ctx, from, to) {
  const q = ctx.track().filter(p => p.t > from && p.t <= to);
  if (!q.length) return null;
  return {
    latitude: q.reduce((a, p) => a + p.latitude, 0) / q.length,
    longitude: q.reduce((a, p) => a + p.longitude, 0) / q.length,
  };
}

// Vänd om: turn back on the word, twice. A turn is read as coming eight
// metres back along the line walked before the word, on two fixes in a row,
// each the mean of the last eight seconds. The line comes from averaged
// fixes too. On the field phone (a fix every six seconds, ten metres of
// wander) single fixes and the GPS heading read turns nobody made, and a
// first fix, distance to where the walker was fifteen seconds earlier,
// missed real turns: walking back, you pass that point and it grows again.
function travelBearing(ctx, t) {
  // Two or three fixes in each mean on the field phone; one each missed a
  // turn in four simulated walks of thirty (the line was too short to read).
  const a = meanPosition(ctx, t - 24, t - 10);
  const b = meanPosition(ctx, t - 8, t);
  if (!a || !b || haversine(a, b) < 8) return null;
  return bearing(a, b);
}

async function turnBack(ctx, id) {
  await ctx.play(id);
  const t0 = ctx.state().t;
  const line = travelBearing(ctx, t0);
  const p0 = meanPosition(ctx, t0 - 6, t0) || ctx.position();
  if (line === null || !p0) return { turned: false, after: null, why: 'ingen riktning att vända från' };
  let seen = null, inRow = 0;
  const turned = await ctx.until(s => {
    const pts = ctx.track();
    const last = pts[pts.length - 1];
    if (!last || last.t === seen) return false;
    seen = last.t;
    const here = meanPosition(ctx, s.t - 8, s.t) || last;
    // Metres along the old line; negative is back where you came from.
    const along = haversine(p0, here) * Math.cos(angleDiff(line, bearing(p0, here)) * Math.PI / 180);
    inRow = along <= -8 ? inRow + 1 : 0;
    return inRow >= 2;
  }, { timeout: 45 });
  return { turned, after: ctx.state().t - t0 };
}

async function vandom(ctx) {
  await ctx.play('vandom-intro');
  await ctx.until(s => s.moving && s.movingFor >= 15, { timeout: 40 });
  const first = await turnBack(ctx, 'vandom-nu');
  await ctx.play(first.turned ? 'vandom-bra' : 'vandom-sen');
  await ctx.until(s => s.moving && s.movingFor >= 10, { timeout: 30 });
  await wait(ctx, 10);
  const second = await turnBack(ctx, 'vandom-igen');
  await ctx.play(second.turned ? 'vandom-slut' : 'vandom-sen');
  const fmtTurn = r => r.turned ? `läst efter ${sec(r.after)}` : r.why || 'inte läst';
  return {
    outcome: first.turned && second.turned ? 'klarade' : 'missade',
    detail: `första vändningen ${fmtTurn(first)}, andra ${fmtTurn(second)}`,
  };
}

// Heading from averaged fixes: from the mean position 18 to 30 seconds ago
// to the mean of the last 12. Slow (a turn shows some twenty seconds after
// it), but on the field phone it is the only heading that holds still: the
// fix-to-fix one read a turn in two of three simulated walks that went
// straight. Null until the two means are fifteen metres apart.
function steadyHeading(ctx, t) {
  const then = meanPosition(ctx, t - 30, t - 18);
  const now = meanPosition(ctx, t - 12, t);
  if (!then || !now || haversine(then, now) < 15) return null;
  return bearing(then, now);
}

// Vägvalet: left is shorter but that is where it sounds. The choice is read
// once the steady heading has stayed at least 60 degrees off for 12 seconds
// (55 for 8 read one straight walk in ten as a turn on the field phone).
// The averaging makes it slow, a turn shows some thirty seconds after it,
// and the next crossing can be a minute away: hence 150 seconds.
async function vagval(ctx) {
  await ctx.until(s => steadyHeading(ctx, s.t) !== null, { timeout: 45 });
  await ctx.play('vagval-intro');
  await ctx.until(s => steadyHeading(ctx, s.t) !== null, { timeout: 20 });
  const t0 = ctx.state().t;
  const h0 = steadyHeading(ctx, t0);
  if (h0 === null) {
    await ctx.play('vagval-rakt');
    return { outcome: 'hoppade', detail: 'ingen riktning från gps:en att utgå från' };
  }
  let off = 0, sign = 0, lastT = null;
  const chose = await ctx.until(s => {
    const dt = lastT === null ? 0 : s.t - lastT;
    lastT = s.t;
    const h = steadyHeading(ctx, s.t);
    if (h === null) { off = 0; return false; }
    const d = angleDiff(h0, h);
    if (Math.abs(d) > 60 && Math.sign(d) === sign) off += dt;
    else { off = Math.abs(d) > 60 ? dt : 0; sign = Math.sign(d); }
    return off >= 12;
  }, { timeout: 150 });
  const side = !chose ? 'rakt' : sign > 0 ? 'hoger' : 'vanster';
  await ctx.play(`vagval-${side}`);
  return {
    outcome: chose ? 'klarade' : 'missade',
    detail: chose ? `valde ${side === 'hoger' ? 'höger' : 'vänster'}, läst efter ${sec(ctx.state().t - t0)}` : 'ingen sväng läst på 150 s',
  };
}

// Ljudkompassen: a tone placed left or right of where the walker is heading.
async function kompass(ctx) {
  let target = pickTarget(ctx, { maxLandmark: 300, near: [100, 150] });
  if (!target) {
    await ctx.until(() => !!ctx.position(), { timeout: 20 });
    target = pickTarget(ctx, { maxLandmark: 300, near: [100, 150] });
  }
  if (!target) {
    await ctx.play('hitta-ingps');
    return { outcome: 'hoppade', detail: 'ingen position att utgå från' };
  }
  ctx.setTarget(target.coord);
  const chime = ctx.sfx.chime({ pan: 0, distance: target.dist });
  let headed = 0, total = 0;
  const stop = every(ctx, (s, dt) => {
    const here = ctx.position();
    const d = s.distToTarget ?? target.dist;
    if (!here || s.heading === null) { chime.set({ pan: 0, behind: false, distance: d }); return; }
    const rel = angleDiff(s.heading, bearing(here, target.coord));
    chime.set({ pan: Math.sin(rel * Math.PI / 180), behind: Math.abs(rel) > 110, distance: d });
    total += dt;
    if (Math.abs(rel) < 45) headed += dt;
  });
  await ctx.play('kompass-intro');
  const t0 = ctx.state().t;
  const found = await ctx.until(s => s.distToTarget !== null && s.distToTarget < 25, { timeout: 5 * 60 });
  stop();
  chime.stop();
  const left = ctx.state().distToTarget;
  ctx.setTarget(null);
  await ctx.play(found ? 'kompass-framme' : 'kompass-tid');
  return {
    outcome: found ? 'klarade' : 'missade',
    detail: `${target.kind === 'plats' ? 'en punkt' : target.kind} ${Math.round(target.dist)} m bort, ` +
      (found ? `framme efter ${sec(ctx.state().t - t0)}` : `${left === null ? '?' : Math.round(left)} m kvar`) +
      `, på väg rätt ${total ? pct(headed / total) : '–'} av tiden med riktning`,
  };
}

// Kroppsmorse: stop, walk, stop. Two stops of two seconds with at least two
// seconds of walking between them, within forty-five seconds.
async function sendWord(ctx) {
  const t0 = ctx.state().t;
  let stops = 0, walkedBetween = false, inStop = false;
  return ctx.until(s => {
    if (!s.moving && s.stillFor >= 2 && !inStop) {
      inStop = true;
      if (stops === 0 || walkedBetween) stops++;
      walkedBetween = false;
    }
    if (s.moving) {
      inStop = false;
      if (stops >= 1 && s.movingFor >= 2) walkedBetween = true;
    }
    return stops >= 2;
  }, { by: t0 + 45 });
}

async function morse(ctx) {
  await ctx.play('morse-intro');
  let sent = await sendWord(ctx);
  let tries = 1;
  if (!sent) {
    await ctx.play('morse-igen');
    sent = await sendWord(ctx);
    tries = 2;
  }
  await ctx.play(sent ? 'morse-hord' : 'morse-miss');
  if (sent) await ctx.play('morse-slut');
  return { outcome: sent ? 'klarade' : 'missade', detail: sent ? `ordet hört på försök ${tries}` : 'ordet hördes inte' };
}

// Hon knackar: she vibrates the phone n times, the walker knocks back n.
async function vibration(ctx) {
  await ctx.play('vibra-intro');
  await ctx.until(s => !s.moving, { timeout: 15 });
  const rounds = [];
  for (const n of [2, 3]) {
    await wait(ctx, 1.5);
    const pattern = [];
    for (let i = 0; i < n; i++) pattern.push(180, 320);
    const len = ctx.vibrate(pattern);
    if (!len) {
      await ctx.play('vibra-kan-inte');
      return { outcome: 'hoppade', detail: 'telefonen kan inte vibrera härifrån' };
    }
    await wait(ctx, len + 0.4);
    const from = ctx.state().t;
    ctx.memo.knockWindows.push([from, from + 12]);
    // Counting ends 2,5 s after the last knock, or after ten seconds.
    await ctx.until(s => {
      const ks = ctx.knockTimes(from, s.t);
      return ks.length > 0 && s.t - ks[ks.length - 1] > 2.5;
    }, { timeout: 10 });
    const got = ctx.knocksBetween(from, ctx.state().t);
    rounds.push({ n, got });
    ctx.log(`hon knackade ${n}, du ${got}`);
    if (got === n) await ctx.play('vibra-ratt');
    else if (got === 0) await ctx.play('vibra-inget');
    else await ctx.play('vibra-fel');
  }
  const right = rounds.filter(r => r.got === r.n).length;
  if (rounds.every(r => r.got === 0)) {
    await ctx.play('vibra-kande-inte');
    return { outcome: 'missade', detail: 'inga knack tillbaka, kändes vibrationen?' };
  }
  await ctx.play('vibra-slut');
  return {
    outcome: right === rounds.length ? 'klarade' : 'missade',
    detail: rounds.map(r => `${r.n} → ${r.got}`).join(', '),
  };
}

// Tassa: soft, quiet steps, as if you do not want to be heard. Measured as
// how hard each step lands (Steps.impacts), before and after the word. A
// first version asked for shorter, quicker steps and measured stride as GPS
// speed over cadence; on the field phone the GPS speed was too noisy and the
// sim failed two of three walkers who did it right. Whether soft steps show
// in a real pocket is what this station is here to find out, so the log
// gives both medians.
const TASSA_SOFTER = 0.75;   // after/before; a guess until a walk says otherwise

async function tassa(ctx) {
  if (!ctx.state().stepsTrusted) await ctx.until(s => s.stepsTrusted, { timeout: 20 });
  if (!ctx.state().stepsTrusted) {
    await ctx.play('takten-dov');
    return { outcome: 'hoppade', detail: 'stegräkningen hittade ingen rytm' };
  }
  const sample = () => {
    const from = ctx.state().t;
    const speeds = [];
    const stop = every(ctx, s => speeds.push(s.speed));
    return () => {
      stop();
      const hits = ctx.impactsBetween(from, ctx.state().t).map(x => x.peak);
      return { n: hits.length, peak: median(hits), gps: median(speeds) };
    };
  };
  await ctx.play('tassa-intro');
  await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 15 });
  let end = sample();
  await wait(ctx, 20);
  const before = end();
  await ctx.play('tassa-nu');
  await wait(ctx, 4);
  end = sample();
  await wait(ctx, 25);
  const after = end();
  // Steps so soft the detector lost them, while the GPS says you kept going,
  // count as soft. Stopping does not.
  const vanished = after.n < 8 && after.gps > 0.9;
  const softer = before.n >= 8 && after.n >= 8 && after.peak <= before.peak * TASSA_SOFTER;
  const ok = softer || (before.n >= 8 && vanished);
  await ctx.play(ok ? 'tassa-klarade' : 'tassa-inte');
  const f = r => r.n ? `${r.n} steg, styrka ${r.peak.toFixed(2).replace('.', ',')}, gps ${kmh(r.gps)}` : `inga steg, gps ${kmh(r.gps)}`;
  const ratio = before.peak && after.peak ? `, kvot ${(after.peak / before.peak).toFixed(2).replace('.', ',')}` : '';
  return {
    outcome: ok ? 'klarade' : 'missade',
    detail: `före: ${f(before)}; tassande: ${f(after)}${ratio}` + (vanished && ok ? ', stegen för tysta för stegräkningen' : ''),
  };
}

const STATIONS = { linjen, ja, knack, takten, flykten, frys, spoket, hitta, normalt, vandom, vagval, kompass, morse, vibration, tassa };

// ---------- the run ----------

// `only` runs a single station (for trying one out); otherwise the lab's
// stations in order. `opening` and `closing` are the line ids the walk's
// memory chose (absence, keys, new ground), played around the stations.
export async function runLab(ctx, no, { only = null, opening = [], closing = [] } = {}) {
  ctx.memo.cadences = ctx.memo.cadences || [];
  ctx.memo.knockWindows = ctx.memo.knockWindows || [];
  ctx.hold(true);
  const ids = only ? [only] : LABS[no];
  await ctx.play(only ? 'labb-intro-en' : `labb-intro-${no}`);
  for (const id of opening) await ctx.play(id);
  await ctx.until(s => s.moving && s.movingFor >= 8, { timeout: 30 });

  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    ctx.station(id, i + 1, ids.length);
    ctx.log(`bana ${i + 1}/${ids.length}: ${TITLES[id]}`);
    let r;
    try {
      r = await STATIONS[id](ctx);
    } catch (err) {
      r = { outcome: 'hoppade', detail: `fel: ${err.message}` };
    }
    ctx.hold(true);
    ctx.sfx.stopAll();
    results.push({ id, ...r });
    ctx.result(id, r);
    if (i < ids.length - 1) {
      await ctx.play(`nasta-${1 + (i % 3)}`);
      await ctx.until(s => s.moving && s.movingFor >= 10, { timeout: 25 });
    }
  }

  // Double knocks outside every window where one was asked for: what the
  // detector made of plain walking.
  const stray = ctx.strayDoubles(ctx.memo.knockWindows);
  ctx.log(`knack: ${stray} dubbelknack utan att någon bad om det`);

  ctx.station(null);
  for (const id of closing) await ctx.play(id);
  await ctx.play('labb-slut');
  return results;
}
