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
//   buzzOver()     when the knock detector hears again after that pattern
//   buzzSeen()     what the motion sensor made of the last pattern vibrated
//   noBuzz         why the phone will not buzz, when the app knew before the
//                  walk (a string for the log); otherwise null or missing
//   setTarget(c)   a place to walk to; state.distToTarget follows it
//   position()     the newest decent fix, positionAgo(s) an older one
//   knocksBetween(a, b), knockTimes(a, b), spikesBetween(a, b), strayDoubles(w)
//                  what the knock detector heard
//   sensorShare(a, b)  share of the seconds in [a, b) the motion sensor answered
//   track()        decent fixes, last two minutes: [{t, latitude, longitude}]
//   impactsBetween(a, b)  how hard each step landed: [{t, peak}]
//   memo           an object that lives for the whole walk, for baselines
//   setContact(v)  sets the contact meter (Kontakten starts her near)
//   doublesBetween(a, b)  double knocks heard in (a, b]
//   station(id)    tells the screen which station is running
//   result(id, r)  hands a station's outcome to the end screen
//
// labHelpers() builds the walk-derived half of that, so the app and the
// simulation (scripts/test_lab.mjs) run the same code instead of two copies.
//
// Every station returns { outcome: 'klarade' | 'missade' | 'hoppade', detail }.

import { haversine, bearing, angleDiff } from './engine.js';

// How long after a pattern's last buzz the motor is taken to be running
// still. The browser asks for each buzz in turn and the motor has to stop, so
// the real one trails the one asked for. A quarter second was within reach
// of a motor that starts 0.15 s late and rings on for 0.2, and its shake
// then counted as a knock (review, 2026-10-06).
//
// Measured the same afternoon, the first buzz recorded in a pocket
// (scripts/recordings/knackar-2026-10-06.json): his phone's motor starts
// 0.07-0.12 s after the call and is still 0.08-0.10 s after the buzz was to
// end, and its shake moves the sensor 0.6 m/s² between samples at most,
// a fifth of what a knock takes standing. Half a second is five times what
// that phone needs. It stays, for a motor nobody has measured, and because
// it costs less than it looks: the walker cannot know she is done until her
// next beat, a pause after (KNOCK_OFF), stays silent, so a counted answer
// does not start before then. He answered 1.9 s after.
const BUZZ_TAIL = 0.5;

export function labHelpers(walk, { now, vibrateImpl }) {
  let buzz = null;              // the last pattern vibrated: {pattern, at, over}
  return {
    position: () => walk.position(),
    positionAgo: s => walk.positionAgo(now(), s),
    track: () => walk.track,
    impactsBetween: (a, b) => walk.steps.impacts.filter(x => x.t > a && x.t <= b),
    setTarget: c => walk.setTarget(c),
    knocksBetween: (a, b) => walk.knocks.countBetween(a, b),
    knockTimes: (a, b) => walk.knocks.times.filter(k => k > a && k <= b),
    doublesBetween: (a, b) => walk.knocks.history.filter(k => k > a && k <= b).length,
    setContact: v => { walk.contact.value = Math.min(1, Math.max(0, v)); },
    spikesBetween: (a, b) => walk.knocks.spikes.filter(x => x.t > a && x.t <= b),
    sensorShare: (a, b) => walk.sensorShare(a, b),
    strayDoubles: windows => walk.knocks.history.filter(t => !windows.some(([a, b]) => t >= a && t <= b)).length,
    // Seconds the pattern lasts, or 0 when the phone would not vibrate. The
    // motor shakes the sensor, so knocks do not count until it has stopped:
    // BUZZ_TAIL after the last buzz. A pause that ends the pattern is silence
    // already, and not waited out twice.
    vibrate(pattern) {
      const at = now();
      let ok = false;
      try { ok = !!vibrateImpl(pattern); } catch (_) { ok = false; }
      if (!ok) return 0;
      const len = pattern.reduce((a, b) => a + b, 0) / 1000;
      const pause = pattern.length % 2 ? 0 : pattern[pattern.length - 1] / 1000;
      buzz = { pattern, at, over: at + len - pause + BUZZ_TAIL };
      walk.buzz(at, buzz.over);
      return len;
    },
    // When the detector hears again after the last pattern: an answer is
    // counted from here. Null before any buzz.
    buzzOver: () => buzz && buzz.over,
    // What the sensor made of it, asked once the pattern is over (engine.js,
    // buzzReading). Null before any buzz.
    buzzSeen: () => buzz && walk.buzzSeen(buzz.pattern, buzz.at),
  };
}

// Her knocks as a vibration pattern: n buzzes of KNOCK_ON ms, KNOCK_OFF ms
// apart. The start screen's try-out sends the same ones.
//
// They were 180 ms, 320 apart, until 2026-10-06. In a front trouser pocket
// he felt her two and answered them, then waited for more and never felt
// her three, though the sensor shows the motor shaking the phone as hard the
// second time (high-frequency shake 0.32-0.47 against 0.34, and at most 0.12
// lying still). A page cannot make a buzz stronger, only longer, so they are
// longer: more than twice. 400 is a guess, not a measurement; the next walk
// says whether every one is felt.
export const KNOCK_ON = 400, KNOCK_OFF = 400;
export const knockPattern = n => Array.from({ length: n }, () => [KNOCK_ON, KNOCK_OFF]).flat();

// A buzz reading in the log's words. Under BUZZ_MIN steps between samples,
// while the motor ran or between, it says nothing. The level before is left
// out when the sensor had not started by then (the start screen's try-out).
const BUZZ_MIN = 6;
export function buzzWords(r) {
  if (!r || r.n < BUZZ_MIN) return 'sensorn gav för få värden';
  const f = x => x.toFixed(2).replace('.', ',');
  const before = r.before === null || r.before === undefined ? '' : `${f(r.before)} före, `;
  return `sensorn ${before}${f(r.on)} under surren, ${f(r.off)} emellan`;
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
  kontakt: 'Kontakten', knackgang: 'Knacket gående', vakten: 'Sensorvakten', vaxla: 'Gå och spring',
};

// The test walks (?prov=<id>, 2026-10-07): one open question each, as short
// as the question allows, listed in the order their answers are worth most.
// Each runs ordinary stations through runLab, the way ?banor= does, with
// options of its own (`opts`, per station). `question` is what the walk is
// for and `todo` what the body does, both shown on the start screen, with
// `minutes` (the walk's length in the simulation, rounded up); `sensor`
// has the start screen check the motion sensor, `map` the map;
// `asks` are put on the end screen, where only the walker knows the answer.
// The page listing them with their links is data/uploads/glimt-plan/
// tester.html in Demi's repo; what each walk taught goes in PROGRESS.md.
//
// Not here: Fortare. The 2026-10-06 recording read his jog at 2:27 as the
// increase it is, so only its chapter scene is untried, and that is no
// test of the mechanic.
export const PROV = {
  frys: {
    title: 'Frys', minutes: 2, sensor: true, stations: ['frys'], opts: { frys: { rounds: 2, steps: true } },
    question: 'Märker telefonen att du står still i tid när stegen avgör?',
    todo: 'Gå. När hon säger nu stannar du tvärt och står helt still tills hon säger till. Två gånger.',
    asks: [{ id: 'i-tid', text: 'Märkte hon ditt stopp i tid?', options: ['I tid', 'Lite sent', 'För sent'] }],
  },
  ja: {
    title: 'Stanna för ja', minutes: 2, sensor: true, stations: ['ja'], opts: { ja: { expect: [true, true, false] } },
    question: 'Hur fort hör hon ett ja när stegen avgör, och läser hon ett nej som ja?',
    todo: 'Hon ställer tre frågor. Svara ja, ja, nej: stanna kort för ja, gå vidare för nej.',
    asks: [{ id: 'i-tid', text: 'Hörde hon dina ja i tid?', options: ['I tid', 'Lite sent', 'För sent'] }],
  },
  kontakt: {
    title: 'Kontakten', minutes: 4, sensor: true, stations: ['kontakt'],
    question: 'Känns det rätt när rösten blir dov vid stopp och klar igen när du går, och i rätt fart?',
    todo: 'Gå medan hon pratar. Stanna två gånger en halv minut när du vill, och gå sedan vidare.',
    asks: [
      { id: 'dov', text: 'När du stannade blev hon dov', options: ['För fort', 'Lagom', 'För sakta', 'Inte alls'] },
      { id: 'tillbaka', text: 'När du gick igen kom hon tillbaka', options: ['För fort', 'Lagom', 'För sakta'] },
    ],
  },
  vaxla: {
    title: 'Gå och spring', minutes: 3, stations: ['vaxla'],
    question: 'Märker telefonen när du byter mellan gång och löpning, och räknar den stegen rätt när du springer?',
    todo: 'Gå. När hon säger spring springer du i lugn joggfart, när hon säger gå går du igen. Två gånger.',
    asks: [{ id: 'fart', text: 'Hur sprang du?', options: ['Lugn jogg', 'Ganska fort', 'Så fort jag kunde'] }],
  },
  knack: {
    title: 'Knacket gående', minutes: 2, sensor: true, stations: ['knackgang'],
    question: 'Hörs två knack på fickan medan du går, och läses en stöt som knack?',
    todo: 'Knacka två gånger på fickan när hon ber om det, utan att stanna. Sedan tar du upp telefonen och stoppar ner den igen.',
    asks: [{ id: 'hart', text: 'Hur hårt fick du knacka?', options: ['Lätt', 'Ganska hårt', 'Väldigt hårt'] }],
  },
  riktning: {
    title: 'Riktning', minutes: 4, stations: ['vagval', 'vandom'], opts: { vagval: { fast: true } },
    question: 'Läser Chrome en sväng åt vänster, och en vändning, snabbt nog?',
    todo: 'Sväng vänster vid första korsningen efter att hon frågat. Vänd sedan om när hon säger vänd, två gånger.',
    asks: [{ id: 'svang', text: 'Åt vilket håll svängde du vid korsningen?', options: ['Vänster', 'Höger', 'Rakt fram'] }],
  },
  kompass: {
    title: 'Ljudkompassen', minutes: 4, map: true, stations: ['kompass'], opts: { kompass: { real: true } },
    question: 'Leder tonen dig till ett riktigt ställe som kartan känner till?',
    todo: 'Gå mot tonen: låter den från vänster svänger du vänster, låter den dov är den bakom dig.',
    asks: [{ id: 'hall', text: 'Hörde du åt vilket håll tonen låg?', options: ['Tydligt', 'Ibland', 'Inte alls'] }],
  },
  takten: {
    title: 'Takten', minutes: 3, sensor: true, stations: ['takten'],
    question: 'Går det att följa ett slag i lurarna när det blir fortare och lugnare?',
    todo: 'Gå i takt med slaget i lurarna, och följ med när det ändras.',
    asks: [{ id: 'folja', text: 'Gick det att följa takten?', options: ['Lätt', 'Det gick', 'Svårt'] }],
  },
  hitta: {
    title: 'Hitta', minutes: 4, map: true, stations: ['hitta'], opts: { hitta: { waitMap: true } },
    question: 'Leder varmare och kallare dig fram till ett ställe?',
    todo: 'Gå åt det håll du tror. Hon säger varmare eller kallare tills du är framme.',
    asks: [{ id: 'hjalp', text: 'Hjälpte varmare och kallare?', options: ['Ja', 'Lite', 'Nej'] }],
  },
  tassa: {
    title: 'Tassa', minutes: 2, sensor: true, stations: ['tassa'],
    question: 'Syns mjuka steg i rörelsesensorn?',
    todo: 'Gå som vanligt. När hon säger tassa går du mjukt och tyst i samma fart.',
    asks: [{ id: 'gick', text: 'Hur gick du när hon sa tassa?', options: ['Mjukt, samma fart', 'Mjukt och saktare', 'Som vanligt'] }],
  },
  vakten: {
    title: 'Sensorvakten', minutes: 2, sensor: true, stations: ['vakten'],
    question: 'Säger hon till när skärmen låses, och hörs det fast skärmen är släckt?',
    todo: 'Lås skärmen när hon ber om det och gå vidare. Lås upp när hon säger till, eller efter en halv minut om du inte hör något.',
    asks: [{ id: 'hordes', text: 'Hörde du henne medan skärmen var låst?', options: ['Ja', 'Nej'] }],
  },
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
// has stood still one second after the feet read the stop (three on GPS)
// within the window after the line ends, or already stands still when it
// ends; `after` the seconds that took. The window is ten seconds when the
// feet decide and twenty on GPS, which reads a stop five to twelve seconds
// late (Henric 2026-10-08, after the test walk: one second and ten).
async function askStop(ctx, id, { window = null } = {}) {
  await ctx.play(id);
  const t0 = ctx.state().t;
  const yes = await ctx.until(s => s.stillFor >= stillToAnswer(s), { timeout: window ?? answerWindow(ctx.state()) });
  // Which of the two read the stop: steps take about three seconds, GPS on
  // the field phone took twelve (2026-09-28), so the log has to say.
  const state = ctx.state();
  return { yes, after: state.t - t0, src: state.paceSource, said: t0, state };
}

const via = src => src === 'steps' ? 'steg' : 'gps';
const stillToAnswer = s => s.paceSource === 'steps' ? 1 : 3;
const answerWindow = s => s.paceSource === 'steps' ? 10 : 20;

// The phone stops the motion sensor when the screen goes dark or another app
// takes the front, and says nothing about it. In the first field lab
// (2026-09-28) it went quiet at 2:30 and came back at 8:56: Knacket listened
// to a sensor that was not there and logged "no spikes", Takten was skipped,
// and nobody knew until the log was read. So she says it, six seconds into
// a silence, again every two minutes it lasts, and once more when it is back.
// A phone whose sensor never answered has nothing to lose: GPS decides there
// from the start, and she stays quiet. A test walk is a couple of minutes,
// so there she says it after three (`warn`). When she asked is kept in
// ctx.memo.sensorWarns, for Sensorvakten.
const SENSOR_WARN = 6;
const SENSOR_REMIND = 120;
function watchSensor(ctx, { warn = SENSOR_WARN } = {}) {
  let silentSince = null, warnedAt = null;
  ctx.memo.sensorWarns = ctx.memo.sensorWarns || [];
  return every(ctx, s => {
    if (!s.sensorSeen) return;
    if (s.sensorLive) {
      if (warnedAt !== null) ctx.play('sensor-tillbaka');
      silentSince = warnedAt = null;
      return;
    }
    if (silentSince === null) silentSince = s.t;
    const due = warnedAt === null ? s.t - silentSince >= warn : s.t - warnedAt >= SENSOR_REMIND;
    if (due) {
      warnedAt = s.t;
      ctx.memo.sensorWarns.push(s.t);
      ctx.play('sensor-tyst');
    }
  });
}

// For a station that listens to the sensor: true once it answers. While it
// is silent the watcher has already asked the walker to look at the phone,
// so this waits for that, up to 25 seconds. False at once on a phone that
// never had one.
async function sensorReady(ctx) {
  const s = ctx.state();
  if (s.sensorLive) return true;
  if (!s.sensorSeen) return false;
  return ctx.until(x => x.sensorLive, { timeout: 25 });
}

// A station that could not listen: skipped, not missed, and the log says why.
async function deaf(ctx) {
  await ctx.play('takten-dov');
  return {
    outcome: 'hoppade',
    detail: ctx.state().sensorSeen ? 'rörelsesensorn tyst (skärmen släckt?)' : 'ingen rörelsesensor i telefonen',
  };
}

// What the knock detector made of (from, to]: how many sharp spikes and how
// hard, or that the sensor was not there to say.
function spikeNote(ctx, from, to) {
  if (ctx.sensorShare(from, to) < 0.5) return 'sensorn tyst';
  const sp = ctx.spikesBetween(from, to);
  if (!sp.length) return 'inga utslag';
  const max = Math.max(...sp.map(x => x.peak));
  return `${sp.length} utslag, högst ${max.toFixed(1).replace('.', ',')}`;
}

// A stop as the log should tell it: when it was read after the word, and,
// when the feet decided, how much of that was the walker and how much the
// phone. `said` is when the word ended, `read` when the stop was read, `s`
// the state then. Steps: the last step is when the walker stopped; the
// detector waits STEP_GONE (2 s) after it and the station its own seconds
// still on top.
function stopTiming(said, read, s) {
  const base = `läst ${sec(read - said)} efter ordet (${via(s.paceSource)})`;
  if (s.paceSource !== 'steps' || !Number.isFinite(s.lastStepAt)) return base;
  const a = s.lastStepAt - said;
  return `${base}: du stannade ${a < 0 ? 'redan under ordet' : `${sec(a)} efter`}, telefonen märkte det ${sec(read - s.lastStepAt)} efter sista steget`;
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

// Stanna för ja, three questions with known answers. `expect` (the test
// walk: yes, yes, no, which the walker is told to answer) judges all three,
// so a no that reads as a yes is a miss too.
async function ja(ctx, { expect = null } = {}) {
  await ctx.play('ja-intro');
  const answers = [];
  const qs = ['ja-q1', ctx.world.light === 'dark' ? 'ja-q2-morkt' : 'ja-q2-ljust', 'ja-q3'];
  for (const q of qs) {
    const a = await askStop(ctx, q);
    answers.push(a);
    // The stop itself, apart from the second (or three) of standing that
    // makes it a yes: the log said "märkte det 5,3 s efter" for a stop the
    // feet read in two (2026-10-08).
    const read = a.state.t - a.state.stillFor;
    ctx.log(`${q}: ${!a.yes ? 'nej' : read < a.said ? `ja efter ${sec(a.after)}, stod redan still`
      : `ja efter ${sec(a.after)}, stoppet ${stopTiming(a.said, read, a.state)}`}`);
    await ctx.play(a.yes ? 'ja-svar-ja' : 'ja-svar-nej');
    if (a.yes) await walkOn(ctx);
    await wait(ctx, 4);
  }
  await ctx.play('ja-slut');
  const yes = answers.filter(a => a.yes);
  const detail = `${answers.map(a => a.yes ? 'ja' : 'nej').join('/')}` +
    (expect ? ` (rätt: ${expect.map(x => x ? 'ja' : 'nej').join('/')})` : '') +
    (yes.length ? `, svar efter ${yes.map(a => `${sec(a.after)} (${via(a.src)})`).join(' / ')}` : '');
  // The first two have a known yes. Missing them is the phone, not the walker.
  const ok = expect ? expect.every((x, i) => answers[i].yes === x) : answers[0].yes && answers[1].yes;
  return { outcome: ok ? 'klarade' : 'missade', detail };
}

// Knacket: a double knock through the pocket, standing, then walking, then
// as the answer to a question.
async function knack(ctx) {
  if (!await sensorReady(ctx)) return deaf(ctx);

  // Knocks asked for count from the start of the asking line (an eager
  // walker knocks before Vega has finished) to a few seconds after the wait,
  // so none of them is later counted as the detector hearing things.
  const windowFrom = ctx.state().t;
  const closeWindow = () => ctx.memo.knockWindows.push([windowFrom, ctx.state().t + 3]);

  await ctx.play('knack-intro');
  let asked = ctx.state().t;
  let standing = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  if (!standing) {
    ctx.log(`knack stående, första försöket: ${spikeNote(ctx, asked, ctx.state().t)}`);
    await ctx.play('knack-igen');
    asked = ctx.state().t;
    standing = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  }
  ctx.log(`knack stående: ${standing ? 'hört' : 'inte hört'} (${spikeNote(ctx, asked, ctx.state().t)})`);
  await ctx.play(standing ? 'knack-hord' : 'knack-inget');

  await ctx.play('knack-ga');
  await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 15 });
  asked = ctx.state().t;
  const walking = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 25 });
  ctx.log(`knack gående: ${walking ? 'hört' : 'inte hört'} (${spikeNote(ctx, asked, ctx.state().t)})`);
  await ctx.play(walking ? 'knack-hord' : 'knack-inget-ga');

  await ctx.play('knack-fraga');
  asked = ctx.state().t;
  const prefers = await ctx.until(s => s.lastDoubleKnockAt > asked, { timeout: 20 });
  closeWindow();
  await ctx.play(prefers ? 'knack-ja' : 'knack-nej');

  const detail = `stående ${standing ? 'hört' : 'missat'}, gående ${walking ? 'hört' : 'missat'}, ` +
    `föredrar ${prefers ? 'knack' : 'stopp (eller hördes inte)'}`;
  // A sensor that died after the start heard nothing either way.
  if (!standing && ctx.sensorShare(windowFrom, ctx.state().t) < 0.5) {
    return { outcome: 'hoppade', detail: `rörelsesensorn tyst under banan; ${detail}` };
  }
  return { outcome: standing ? 'klarade' : 'missade', detail };
}

// Takten: a beat at the walker's own cadence, then faster, then slower.
// In step, a chord fades in under it.
async function takten(ctx) {
  if (!await sensorReady(ctx)) return deaf(ctx);
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
  // What the feet and the GPS did in each part, so the log says whether a
  // part was missed by the walker or by the reading.
  const feet = {}, gps = {};
  let phase = 'lika';
  const stop = every(ctx, (s, dt) => {
    const ok = s.cadence > 0 && Math.abs(s.cadence - bpm) / bpm < 0.05;
    level += ((ok ? 1 : 0) - level) * Math.min(1, dt / 2);
    pad.set({ level });
    syncRun = ok ? syncRun + dt : 0;
    share[phase] = share[phase] || { in: 0, all: 0 };
    share[phase].all += dt;
    if (ok) share[phase].in += dt;
    if (s.cadence > 0) (feet[phase] = feet[phase] || []).push(s.cadence);
    (gps[phase] = gps[phase] || []).push(s.speed);
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
  const parts = ['lika', 'fortare', 'saktare'];
  const steps = parts.map(k => feet[k] && feet[k].length ? Math.round(median(feet[k])) : '–').join('/');
  const speeds = parts.map(k => gps[k] && gps[k].length ? kmh(median(gps[k])) : '–').join(' / ');
  return {
    outcome: followed >= 0.4 ? 'klarade' : 'missade',
    detail: `slag ${base}/${Math.round(base * 1.08)}/${Math.round(base * 0.93)}, i takt ${part('lika')} / ${part('fortare')} / ${part('saktare')}, ` +
      `dina steg ${steps} per minut, gps ${speeds}`,
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
// `rounds` asks again after the first ("En gång till."). `steps` waits for
// the feet to be read before the word, and skips the station when they are
// not: Frys had only been walked with the sensor silent and a fix every
// 5,5 s deciding (2026-10-05), and whether the steps read a stop in time is
// what the test walk is for.
async function frys(ctx, { rounds = 1, steps = false } = {}) {
  if (steps && !await sensorReady(ctx)) return deaf(ctx);
  await ctx.play('frys-intro');
  const out = [];
  for (let i = 0; i < rounds; i++) {
    if (i) await ctx.play('vibra-igen');
    await ctx.until(s => s.moving && s.movingFor >= 5, { timeout: 20 });
    if (steps && !ctx.state().stepsTrusted) await ctx.until(s => s.stepsTrusted, { timeout: 20 });
    if (steps && !ctx.state().stepsTrusted) {
      await ctx.play('takten-dov');
      const why = ctx.state().sensorLive ? 'stegräkningen hittade ingen rytm' : 'rörelsesensorn tyst (skärmen släckt?)';
      // Only the rounds walked can say klarade; one of two is not the test.
      return { outcome: out.some(r => !r.ok) ? 'missade' : 'hoppade', detail: [...out.map(r => r.detail), why].join('; ') };
    }
    await wait(ctx, 5 + Math.random() * 10);
    // A stop before the word is no answer to it (review, 2026-10-07).
    if (!ctx.state().moving) await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 15 });
    const r = ctx.state().moving ? await frysRound(ctx) : { ok: false, detail: 'stod still redan innan hon sa nu' };
    out.push(r);
    if (rounds > 1) ctx.log(`frys ${i + 1}: ${r.detail}`);
  }
  return {
    outcome: out.every(r => r.ok) ? 'klarade' : 'missade',
    detail: out.map((r, i) => rounds > 1 ? `${i + 1}: ${r.detail}` : r.detail).join('; '),
  };
}

async function frysRound(ctx) {
  await ctx.play('frys-nu');
  const asked = ctx.state().t;
  const src = ctx.state().paceSource;
  ctx.sfx.passing({ seconds: 18 });
  const stopped = await ctx.until(s => !s.moving, { timeout: 9 });
  if (!stopped) {
    await ctx.play('frys-sen');
    return { ok: false, detail: `inget stopp inom 9 s (${via(src)})` };
  }
  const read = ctx.state();
  const still = read.t;
  const moved = await ctx.until(s => s.moving, { timeout: Math.max(8, asked + 18 - still) });
  const m = ctx.state();
  const at = m.t - still;
  // What read as movement, so a real walk's log can tell a step from a jump.
  const why = m.paceSource === 'steps' ? `steg ${Math.round(m.cadence)}/min` : `gps ${kmh(m.pace)}`;
  await ctx.play(moved ? 'frys-rorde' : 'frys-klarade');
  return {
    ok: !moved,
    detail: `stopp ${stopTiming(asked, still, read)}` + (moved ? `, rörelse efter ${sec(at)} (${why})` : ', stod still tills det passerat'),
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

// Waits for the map's answer, up to `seconds`. It is asked at the walk's
// first fix and can take forty seconds with both servers slow; a test walk
// reaches its station well before that.
const waitMap = (ctx, seconds) => ctx.world.landmarkAnswered
  ? Promise.resolve(true) : ctx.until(() => !!ctx.world.landmarkAnswered, { timeout: seconds });

// Hitta: warmer or colder, in words, towards a real place. `waitMap` (the
// test walk) gives the map time to answer first, so a real place is the one
// found when there is one.
async function hitta(ctx, { waitMap: mapFirst = false } = {}) {
  if (mapFirst) await waitMap(ctx, 25);
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
  // Metres along the old line; negative is back where you came from.
  const alongOf = p => haversine(p0, p) * Math.cos(angleDiff(line, bearing(p0, p)) * Math.PI / 180);
  const turned = await ctx.until(s => {
    const pts = ctx.track();
    const last = pts[pts.length - 1];
    if (!last || last.t === seen) return false;
    seen = last.t;
    // Standing, the drift alone can come eight metres back: only fixes from
    // walking count (a simulated walker who stopped at the word read as
    // turned, 2026-09-25).
    if (!s.moving) { inRow = 0; return false; }
    const here = meanPosition(ctx, s.t - 8, s.t) || last;
    inRow = alongOf(here) <= -8 ? inRow + 1 : 0;
    return inRow >= 2;
  }, { timeout: 45 });
  const at = ctx.state().t;
  // Where the turn shows in the track: the furthest along the old line the
  // walker got after the word, in four-second means, so the log can say how
  // long after the real turn it was read (the second turn of 2026-10-05 was
  // late, and nobody could say by how much).
  let far = null;
  if (turned) {
    for (const p of ctx.track().filter(q => q.t >= t0 && q.t <= at)) {
      const m = meanPosition(ctx, p.t - 2, p.t + 2);
      const a = m && alongOf(m);
      if (a !== null && (far === null || a > far.a)) far = { a, t: p.t };
    }
  }
  return { turned, after: at - t0, lag: far ? at - far.t : null };
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
  const fmtTurn = r => r.turned
    ? `läst ${sec(r.after)} efter ordet` + (r.lag !== null ? `, ${sec(r.lag)} efter vändpunkten i spåret` : '')
    : r.why || 'inte läst';
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
// once the steady heading has stayed at least 60 degrees off the line, with
// the walker forty metres to that side, for 12 seconds (55 for 8, heading
// alone, read one straight walk in ten as a turn on the field phone). The
// averaging and the forty metres make it slow, a turn shows some fifty
// seconds after it, and the next crossing can be a minute away: hence 150.
// The line walked when the question came: over a longer stretch than the
// steady heading, where the walk allows, since everything after is measured
// against it. A line a few tens of degrees off lets a walker going straight
// drift away from it and read as a turn.
// Only fixes from walking count: standing, the two means differ by the
// GPS drift alone, and a walker who had stopped at a crossing got a line
// in any direction (a simulated walker with drifting GPS read a turn in a
// quarter of straight walks that way, 2026-09-25).
function lineWalked(ctx, s) {
  if (!s.moving || s.movingFor < 30) return null;
  const then = s.movingFor >= 45 && meanPosition(ctx, s.t - 45, s.t - 30);
  const now = meanPosition(ctx, s.t - 12, s.t);
  if (then && now && haversine(then, now) >= 30) return bearing(then, now);
  return steadyHeading(ctx, s.t);
}

// A turn needs the walker forty metres to the side of that line as well,
// held twelve seconds: GPS drift is bounded, a walk down another street is
// not. Measured on simulated drift (eight metres, half a minute): 60 of 60
// turns read, 1 of 60 straight walks read as one; shorter holds or wider
// sides did worse. With fifteen metres that drifts for a minute, a fifth of
// straight walks still read a turn (2026-09-25).
const VAGVAL_SIDE = 40;
const VAGVAL_HOLD = 12;

// Dense GPS: Chrome on the field phone gave two fixes a second at ±3-6 m
// (2026-10-06), where Firefox gave one every six seconds at ±17-24. The slow
// reading above is built for the latter, and in Chrome it read his right
// turn of 10-06 some 42 s after the corner the track shows. With `fast`
// (the test walk) Vägvalet reads from short means whenever the last twenty
// seconds held fifteen fixes or more at a median within twelve metres, and
// falls back on the slow reading, tick by tick, when they do not.
const DENSE_FIXES = 15, DENSE_ACCURACY = 12;
export function denseGps(track, t) {
  const q = track.filter(p => p.t > t - 20 && p.t <= t);
  if (q.length < DENSE_FIXES) return false;
  const acc = median(q.map(p => p.accuracy).filter(a => a !== null && a !== undefined));
  return acc !== null && acc <= DENSE_ACCURACY;
}
// The fast reading's numbers. The line: the mean 20 to 12 s before the
// question to the mean of the last 6, at least 12 m apart. The heading: 10 to
// 6 s back to the last 4, at least 5 m apart. A turn: more than 50 degrees
// off the line, 8 m to that side, held 3 s. His Chrome walk of 2026-10-06
// strayed 0,5-0,8 m from a straight line and its heading 3 degrees, so the
// margins are wide; on simulated GPS twice as noisy (scripts/test_lab.mjs,
// profiles *-chrome) straight walks stay straight. With 15 m and 4 s the
// recorded right turn read 13,6 s after its corner.
const FAST = { side: 8, angle: 50, hold: 3, here: 4, walk: 20 };
function fastLine(ctx, s) {
  if (!s.moving || s.movingFor < FAST.walk) return null;
  const a = meanPosition(ctx, s.t - 20, s.t - 12), b = meanPosition(ctx, s.t - 6, s.t);
  return a && b && haversine(a, b) >= 12 ? bearing(a, b) : null;
}
function fastHeading(ctx, t) {
  const a = meanPosition(ctx, t - 10, t - 6), b = meanPosition(ctx, t - 4, t);
  return a && b && haversine(a, b) >= 5 ? bearing(a, b) : null;
}

// When the corner shows in the track: of the fixes since `from`, in
// four-second means, the one furthest from the straight line between where
// the walker was at the question (`p0`) and is now. A walk with one turn has
// its corner there.
function cornerAt(ctx, from, p0, here) {
  const course = bearing(p0, here);
  let best = null;
  for (const p of ctx.track().filter(q => q.t >= from)) {
    const m = meanPosition(ctx, p.t - 2, p.t + 2);
    if (!m) continue;
    const off = Math.abs(haversine(p0, m) * Math.sin(angleDiff(course, bearing(p0, m)) * Math.PI / 180));
    if (!best || off > best.off) best = { off, t: p.t };
  }
  return best && best.off >= 4 ? best.t : null;
}

async function vagval(ctx, { fast = false } = {}) {
  const dense = t => fast && denseGps(ctx.track(), t);
  // Walking for 45 seconds before the question gives the long line; the
  // short one (eighteen seconds apart) was off by 30 to 60 degrees in the
  // straight walks that read a turn under drifting GPS. On dense GPS twenty
  // are enough.
  await ctx.until(s => s.moving && s.movingFor >= (dense(s.t) ? FAST.walk : 45), { timeout: 75 });
  await ctx.play('vagval-intro');
  const lineOf = s => (dense(s.t) ? fastLine(ctx, s) : null) ?? lineWalked(ctx, s);
  await ctx.until(s => lineOf(s) !== null, { timeout: 30 });
  const t0 = ctx.state().t;
  const h0 = lineOf(ctx.state());
  if (h0 === null) {
    await ctx.play('vagval-rakt');
    return { outcome: 'hoppade', detail: 'ingen riktning från gps:en att utgå från' };
  }
  const dense0 = dense(t0);
  const fixes0 = ctx.track().filter(p => p.t > t0 - 20 && p.t <= t0);
  const acc0 = median(fixes0.map(p => p.accuracy).filter(a => a !== null && a !== undefined));
  const gpsNote = `${fixes0.length} positioner på 20 s${acc0 === null ? '' : `, ±${Math.round(acc0)} m`}`;
  const p0 = meanPosition(ctx, t0 - (dense0 ? 6 : 12), t0);
  let off = 0, sign = 0, lastT = null, seen = null, mode = null;
  const chose = await ctx.until(s => {
    const dt = lastT === null ? 0 : s.t - lastT;
    lastT = s.t;
    const d0 = dense(s.t);
    // A change of reading starts the count over: the two hold for
    // different times on different means.
    if (d0 !== mode) { mode = d0; off = 0; }
    const [hold, angle, sideMin, span] = d0
      ? [FAST.hold, FAST.angle, FAST.side, FAST.here]
      : [VAGVAL_HOLD, 60, VAGVAL_SIDE, 12];
    // Standing still (at the crossing, deciding) holds the count: the
    // positions then say nothing about a direction.
    const h = s.moving && s.movingFor >= span ? (d0 ? fastHeading(ctx, s.t) : steadyHeading(ctx, s.t)) : null;
    const here = meanPosition(ctx, s.t - span, s.t);
    if (h === null || !here) return false;
    const d = angleDiff(h0, h);
    // Metres to the side of the line walked at the question, right positive.
    const side = haversine(p0, here) * Math.sin(angleDiff(h0, bearing(p0, here)) * Math.PI / 180);
    const turned = Math.abs(d) > angle && Math.abs(side) >= sideMin && Math.sign(side) === Math.sign(d);
    seen = { d, side, dense: d0 };
    if (turned && Math.sign(d) === sign) off += dt;
    else { off = turned ? dt : 0; sign = Math.sign(d); }
    return off >= hold;
  }, { timeout: 150 });
  const side = !chose ? 'rakt' : sign > 0 ? 'hoger' : 'vanster';
  const readAt = ctx.state().t;
  let lag = '';
  if (chose) {
    const corner = cornerAt(ctx, t0 - 5, p0, meanPosition(ctx, readAt - 4, readAt) || ctx.position());
    lag = corner === null ? ', svängen syns inte i spåret' : `, ${sec(readAt - corner)} efter svängen i spåret`;
    ctx.log(`vägval: ${seen.dense ? 'tät' : 'gles'} gps (${gpsNote} vid frågan)${lag}`);
  }
  await ctx.play(`vagval-${side}`);
  return {
    outcome: chose ? 'klarade' : 'missade',
    detail: chose
      ? `valde ${side === 'hoger' ? 'höger' : 'vänster'}, ${Math.round(Math.abs(seen.side))} m åt sidan, ${Math.round(Math.abs(seen.d))}° från linjen, läst ${sec(readAt - t0)} efter frågan${lag}` +
        (fast ? `, ${seen.dense ? 'snabb' : 'långsam'} läsning` : '')
      : `ingen sväng läst på 150 s (${gpsNote} vid frågan)`,
  };
}

// A real place the map found, for Ljudkompassen's test walk: the walk has
// to end somewhere the walker can see. Within REAL_NEAR..REAL_FAR metres of
// where the walker is now. Only the middle of what the map drew is known
// (Overpass gives a centre), and the middle of a lake or a wood may be out of
// reach, so a bridge or a peak goes first: the other kinds count as 150 m
// further than they are, and are reached at a wider radius (ARRIVE).
const REAL_NEAR = 60, REAL_FAR = 350;
const ARRIVE = { bro: 25, berg: 30, kyrkogard: 40, vatten: 60, skog: 60 };
const KIND_WORDS = { vatten: 'vatten', skog: 'skog', berg: 'en höjd', bro: 'en bro', kyrkogard: 'en kyrkogård' };
export function realTarget(nearby, here) {
  let best = null;
  const seen = [];
  for (const [kind, c] of Object.entries(nearby || {})) {
    if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;
    const coord = { latitude: c.lat, longitude: c.lon };
    const dist = haversine(here, coord);
    seen.push(`${KIND_WORDS[kind] || kind} ${Math.round(dist)} m`);
    if (dist < REAL_NEAR || dist > REAL_FAR) continue;
    const score = dist + (['vatten', 'skog'].includes(kind) ? 150 : 0);
    if (!best || score < best.score) best = { coord, kind, dist, score, arrive: ARRIVE[kind] || 40 };
  }
  return { target: best, seen };
}

// Ljudkompassen: a tone placed left or right of where the walker is heading.
// `real` (the test walk) waits for the map and walks to a place it found,
// or skips at once when there is none in reach.
async function kompass(ctx, { real = false } = {}) {
  let target = null;
  if (real) {
    const answered = await waitMap(ctx, 30);
    if (!ctx.position()) await ctx.until(() => !!ctx.position(), { timeout: 20 });
    const here = ctx.position();
    const found = here ? realTarget(ctx.world.nearby, here) : { target: null, seen: [] };
    if (!found.target) {
      await ctx.play('kompass-ingen-karta');
      const why = !here ? 'ingen position att utgå från'
        : !answered ? 'kartan hade inte svarat efter 30 s'
        : ctx.world.landmarkAnswered === 'fel' ? `kartan svarade inte (${ctx.world.sources.landmark})`
        : found.seen.length ? `inget på kartan ${REAL_NEAR}-${REAL_FAR} m bort (${found.seen.join(', ')})`
        : 'kartan hittade inget alls inom 400 m';
      return { outcome: 'hoppade', detail: why };
    }
    target = found.target;
    ctx.log(`kompass: mot ${KIND_WORDS[target.kind]} ${Math.round(target.dist)} m bort, framme inom ${target.arrive} m (kartan: ${found.seen.join(', ')})`);
  } else {
    target = pickTarget(ctx, { maxLandmark: 300, near: [100, 150] });
    if (!target) {
      await ctx.until(() => !!ctx.position(), { timeout: 20 });
      target = pickTarget(ctx, { maxLandmark: 300, near: [100, 150] });
    }
  }
  if (!target) {
    await ctx.play('hitta-ingps');
    return { outcome: 'hoppade', detail: 'ingen position att utgå från' };
  }
  const arrive = target.arrive || 25;
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
  const found = await ctx.until(s => s.distToTarget !== null && s.distToTarget < arrive, { timeout: 5 * 60 });
  stop();
  chime.stop();
  const left = ctx.state().distToTarget;
  ctx.setTarget(null);
  await ctx.play(found ? 'kompass-framme' : 'kompass-tid');
  return {
    outcome: found ? 'klarade' : 'missade',
    detail: `${target.kind === 'plats' ? 'en punkt' : real ? KIND_WORDS[target.kind] : target.kind} ${Math.round(target.dist)} m bort, ` +
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
//
// A browser may say yes to the buzz and leave the motor alone: Chrome does on
// a silent phone, and on 2026-10-06 the station waited twice for knocks to a
// buzz that never came and called it a miss. The page cannot tell, only the
// walker can, so the start screen has a try-out. When that was not felt, or
// the browser cannot vibrate at all, ctx.noBuzz says why and the station is
// skipped at once, without asking the walker to stop and feel for it.
async function vibration(ctx) {
  if (ctx.noBuzz) {
    await ctx.play('vibra-kan-inte');
    return { outcome: 'hoppade', detail: ctx.noBuzz };
  }
  if (!await sensorReady(ctx)) return deaf(ctx);
  await ctx.play('vibra-intro');
  await ctx.until(s => !s.moving, { timeout: 15 });
  const rounds = [];
  for (const n of [2, 3]) {
    // She says that a second round comes. Until 2026-10-06 the three buzzes
    // came a second and a half after "Rätt. Samma antal." with no word of
    // more. He was waiting for more all the same, and still never felt them
    // (knockPattern, above, for what that changed).
    if (rounds.length) await ctx.play('vibra-igen');
    await wait(ctx, 1.5);
    const len = ctx.vibrate(knockPattern(n));
    if (!len) {
      await ctx.play('vibra-kan-inte');
      return { outcome: 'hoppade', detail: 'telefonen kan inte vibrera härifrån' };
    }
    await wait(ctx, len + 0.4);
    // What the sensor made of the buzz, for the log only: whether a buzz
    // shows there at all is what the first felt one will say.
    ctx.log(`surr: ${buzzWords(ctx.buzzSeen())}`);
    // The answer counts from when the motor is taken to have stopped
    // (BUZZ_TAIL after her last buzz), not from now: this line runs about a
    // second after that buzz (the pattern's last pause, the wait above, the
    // tick), and a walker who knocked back promptly had the first knock land
    // before it. The simulation's walker waited 1.3 s and never showed it
    // (2026-10-06).
    const from = ctx.buzzOver();
    ctx.memo.knockWindows.push([from, from + 12]);
    // Counting ends 2,5 s after the last knock, or after ten seconds.
    await ctx.until(s => {
      const ks = ctx.knockTimes(from, s.t);
      return ks.length > 0 && s.t - ks[ks.length - 1] > 2.5;
    }, { timeout: 10 });
    const got = ctx.knocksBetween(from, ctx.state().t);
    rounds.push({ n, got, deaf: ctx.sensorShare(from, ctx.state().t) < 0.5 });
    ctx.log(`hon knackade ${n}, du ${got}`);
    if (got === n) await ctx.play('vibra-ratt');
    // A miss says that she did knock, and that no knock came back. "Inget
    // svar. Kände du det?" left him unsure what he had missed: he had not
    // felt her three at all (2026-10-06).
    else if (got === 0) await ctx.play('vibra-inget');
    else await ctx.play('vibra-fel');
  }
  const right = rounds.filter(r => r.got === r.n).length;
  const counts = rounds.map(r => `${r.n} → ${r.got}`).join(', ');
  // A round the sensor did not hear says nothing about the walker, even if
  // the round before it was heard (review, 2026-09-28).
  if (rounds.some(r => r.got !== r.n && r.deaf)) {
    await ctx.play('takten-dov');
    return { outcome: 'hoppade', detail: `rörelsesensorn tyst under banan; ${counts}` };
  }
  if (rounds.every(r => r.got === 0)) {
    await ctx.play('vibra-kande-inte');
    return { outcome: 'missade', detail: 'inga knack tillbaka, kändes vibrationen?' };
  }
  await ctx.play('vibra-slut');
  return {
    outcome: right === rounds.length ? 'klarade' : 'missade',
    detail: counts,
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
  if (!await sensorReady(ctx)) return deaf(ctx);
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

// Kontakten: her voice through the contact, as in the chapters, while the
// walker walks, stops twice and walks on. Everywhere else in the lab she is
// clear. The walk is for whether the voice going dull at a stop and coming
// back feels right, and at the right speed (Contact in engine.js: down 0,04
// a second standing, up 0,018 walking). The log times every stop against the
// meter crossing 0,5 and 0,2 on the way down and 0,8 on the way back up.
const KONTAKT_LINES = ['kontakt-1', 'kontakt-2', 'kontakt-3', 'kontakt-4', 'kontakt-5', 'kontakt-6', 'kontakt-7', 'kontakt-8'];
async function kontakt(ctx) {
  await ctx.play('kontakt-intro');
  ctx.setContact(1);
  ctx.hold(false);
  const stops = [];
  let cur = null, poor = false;
  const stop = every(ctx, s => {
    if (s.accuracy !== null && s.accuracy > 40) poor = true;
    // A stop begins when the walk reads still, and ends when it reads moving.
    if (!s.moving && (!cur || cur.go !== null)) {
      // How long the stop took to read, when the feet read it: the meter
      // only starts down from then.
      const lag = s.paceSource === 'steps' && Number.isFinite(s.lastStepAt) ? s.t - s.lastStepAt : null;
      cur = { at: s.t, lag, half: null, low: null, go: null, back: null, min: s.contact };
      stops.push(cur);
    }
    if (!cur) return;
    if (cur.go === null) {
      cur.min = Math.min(cur.min, s.contact);
      if (cur.half === null && s.contact < 0.5) cur.half = s.t;
      if (cur.low === null && s.contact < 0.2) cur.low = s.t;
      // Walking again means two seconds of it: one tick of a step read in
      // the stop is not the end of the stop (review, 2026-10-07).
      if (s.moving && s.movingFor >= 2) { cur.go = s.t - s.movingFor; cur.from = s.contact; }
    }
    // Every stop's way back, so a moment read as still on the way up does
    // not lose the one before it.
    for (const x of stops) if (x.go !== null && x.back === null && x.min < 0.8 && s.contact > 0.8) x.back = s.t;
  });
  try {
    for (const id of KONTAKT_LINES) await ctx.play(id, { contact: true });
    // The last stop may still be on its way back up: up to thirty seconds
    // more of walking, without words, to see it arrive.
    if (cur && cur.back === null) await ctx.until(s => s.contact > 0.8 || !s.moving, { timeout: 30 });
  } finally {
    stop();
  }
  ctx.hold(true);
  await ctx.play('kontakt-slut');
  // Short stops (the GPS reading still for a second) are not what she asked
  // for; only the ones that lasted five seconds are told.
  const real = stops.filter(x => (x.go ?? ctx.state().t) - x.at >= 5);
  const words = real.map((x, i) => {
    const stood = (x.go ?? ctx.state().t) - x.at;
    const down = x.half === null ? 'aldrig under 0,5' : `under 0,5 efter ${sec(x.half - x.at)}` +
      (x.low === null ? `, lägst ${x.min.toFixed(2).replace('.', ',')}` : `, under 0,2 efter ${sec(x.low - x.at)}`);
    const up = x.go === null ? 'stod kvar till slutet'
      : x.back === null ? `gick igen från ${x.from.toFixed(2).replace('.', ',')}, aldrig över 0,8`
      : `gick igen från ${x.from.toFixed(2).replace('.', ',')}, över 0,8 efter ${sec(x.back - x.go)}`;
    const read = x.lag === null ? '' : ` (still läst ${sec(x.lag)} efter sista steget)`;
    return `stopp ${i + 1}: stod ${sec(stood)}${read}, dov ${down}; ${up}`;
  });
  return {
    outcome: real.some(x => x.half !== null && x.back !== null) ? 'klarade' : 'missade',
    detail: (words.length ? words.join('; ') : 'inga stopp') + (poor ? '; gps:en sämre än ±40 m en stund, kontakten högst 0,5 då' : ''),
  };
}

// Knacket gående: two knocks on the pocket while walking, three times, then
// the phone taken out, looked at and put back, which must not read as a
// knock. Knacket's walking try heard nothing in labb 1 on 2026-09-28, with
// the sensor running; whether a jolt reads as a double while a station
// listens had not been tried at all.
async function knackgang(ctx) {
  if (!await sensorReady(ctx)) return deaf(ctx);
  await ctx.play('knackgang-intro');
  const tries = [];
  for (let i = 0; i < 3; i++) {
    await ctx.until(s => s.moving && s.movingFor >= 4, { timeout: 20 });
    const from = ctx.state().t;
    const before = ctx.state();
    await ctx.play('knackgang-nu');
    const heard = await ctx.until(s => s.lastDoubleKnockAt > from, { timeout: 12 });
    const to = ctx.state().t;
    ctx.memo.knockWindows.push([from, to + 3]);
    const feet = before.paceSource === 'steps' ? `${BAND_WORDS[before.band]}, ${Math.round(before.cadence)} steg/min` : `${BAND_WORDS[before.band]}, gps`;
    const note = spikeNote(ctx, from, to);
    // A knock heard standing clears a lower bar: it says nothing about a
    // walking one (review, 2026-10-07).
    const walked = before.moving && ctx.state().moving;
    tries.push({ heard: heard && walked, note });
    ctx.log(`knack gående ${i + 1}: ${heard ? 'hört' : 'inte hört'} (${note}; ${feet}${walked ? '' : ', stod still, räknas inte'})`);
    await ctx.play(heard ? 'knack-hord' : 'knackgang-inget');
  }
  await ctx.play('knackgang-ficka');
  const from = ctx.state().t;
  await wait(ctx, 15);
  const to = ctx.state().t;
  ctx.memo.knockWindows.push([from, to]);
  const jolts = ctx.doublesBetween(from, to);
  const joltNote = spikeNote(ctx, from, to);
  ctx.log(`knack: telefonen upp ur fickan och ner, ${jolts} dubbelknack (${joltNote})`);
  await ctx.play('knackgang-slut');
  const heard = tries.filter(x => x.heard).length;
  const detail = `gående ${heard} av 3 hörda (${tries.map(x => x.note).join(' / ')}); upp ur fickan ${jolts} dubbelknack (${joltNote})`;
  if (ctx.sensorShare(from - 60, to) < 0.5) return { outcome: 'hoppade', detail: `rörelsesensorn tyst under banan; ${detail}` };
  return { outcome: heard >= 2 && jolts === 0 ? 'klarade' : 'missade', detail };
}

// Sensorvakten: the screen locked on purpose. The phone stops the motion
// sensor with it; she should say so within seconds (watchSensor), from a
// page that is hidden by then, and say it again when the sensor is back.
// Whether her words get out of a hidden page is the phone's to allow, and
// only the walker can say if they did: the end screen asks.
async function vakten(ctx) {
  if (!await sensorReady(ctx)) return deaf(ctx);
  // Locking during her line is doing as asked, and her word about it may
  // come before the line has ended (review, 2026-10-07).
  const began = ctx.state().t;
  await ctx.play('vakten-intro');
  const asked = ctx.state().t;
  const quiet = await ctx.until(s => !s.sensorLive, { timeout: 30 });
  if (!quiet) {
    await ctx.play('vakten-inte');
    return { outcome: 'missade', detail: 'rörelsesensorn tystnade aldrig på 30 s (låstes skärmen?)' };
  }
  const silentAt = ctx.state().t;
  const back = await ctx.until(s => s.sensorLive, { timeout: 90 });
  const backAt = ctx.state().t;
  const warned = (ctx.memo.sensorWarns || []).find(w => w >= began);
  await ctx.play(back ? 'vakten-slut' : 'vakten-inte');
  const detail = (silentAt - asked < 0.5 ? 'tyst redan under ordet, ' : `tyst ${sec(silentAt - asked)} efter ordet, `) +
    (warned === undefined ? 'hon bad aldrig om att få säga till' : `hon bad om att få säga till ${sec(Math.max(0, warned - Math.min(silentAt, asked)))} ${silentAt - asked < 0.5 ? 'efter ordet' : 'senare'}`) +
    (back ? `, sensorn tillbaka efter ${sec(backAt - silentAt)}` : ', sensorn kom inte tillbaka på 90 s');
  return { outcome: back && warned !== undefined ? 'klarade' : 'missade', detail };
}

const BAND_WORDS = { still: 'stilla', walk: 'gång', run: 'löpning' };

// Gå och spring: walk, run, walk, run, walk, on her word. Henric 2026-10-07:
// Glimt should work walking, running and both in one walk, switching freely,
// and running had only been tried as a short jog in Ljudkompassen and
// Flykten. Per part the log says how soon the band read the switch, how much
// of the part it had right once settled, and what the feet and the GPS read,
// so a step count that halves on a run shows. Flykten and Spöket set their
// chasers from the walking pace (Stämma linjen, or the default): what that
// means for someone already running is worked out from the run's own pace.
const VAXLA = [['walk', null, 25], ['run', 'vaxla-spring', 40], ['walk', 'vaxla-ga', 30], ['run', 'vaxla-spring-igen', 40], ['walk', 'vaxla-ga-igen', 25]];
const VAXLA_SETTLE = 8;   // s after her word before a wrong band counts
const VAXLA_HOLD = 2;     // s the band must hold to count as read
const VAXLA_READ = 12;    // s; a switch read later than this is too slow
const VAXLA_WRONG = 0.25; // share of a settled part the band may have wrong
async function vaxla(ctx) {
  await ctx.play('vaxla-intro');
  await ctx.until(s => s.moving && s.movingFor >= 5, { timeout: 20 });
  const parts = [];
  for (const [want, line, seconds] of VAXLA) {
    if (line) await ctx.play(line);
    const said = ctx.state().t;
    const p = { want, line, said, read: line ? null : said, since: null, wrong: 0, all: 0, cad: [], gps: [], pace: [], steps: 0 };
    const stop = every(ctx, (s, dt) => {
      // Read when the band has held two seconds, timed from when it began:
      // a run's one tick of walk is not the walk she asked for.
      p.since = s.band === want ? p.since ?? s.t : null;
      if (p.read === null && p.since !== null && s.t - p.since >= VAXLA_HOLD) p.read = p.since;
      if (s.t - said < VAXLA_SETTLE) return;
      p.all += dt;
      if (s.band !== want) p.wrong += dt;
      if (s.paceSource === 'steps') p.steps += dt;
      if (s.cadence > 0) p.cad.push(s.cadence);
      p.gps.push(s.speed);
      p.pace.push(s.pace);
    });
    try { await wait(ctx, seconds); } finally { stop(); }
    p.end = ctx.state().t;
    p.doubles = ctx.doublesBetween(said, p.end);
    parts.push(p);
    const n = parts.length;
    const read = !line ? '' : p.read === null ? `${BAND_WORDS[want]} aldrig läst, ` : `${BAND_WORDS[want]} läst ${sec(p.read - said)} efter ordet, `;
    const cad = p.cad.length ? `${Math.round(median(p.cad))} steg/min` : 'inga steg';
    ctx.log(`växla ${n} (${want === 'run' ? 'spring' : 'gå'}): ${read}annat band ${p.all ? pct(p.wrong / p.all) : '–'} av tiden efter ${VAXLA_SETTLE} s; ` +
      `${cad}, gps ${kmh(median(p.gps))}, stegen avgjorde ${p.all ? pct(p.steps / p.all) : '–'}` + (p.doubles ? `, ${p.doubles} dubbelknack` : ''));
  }
  await ctx.play('vaxla-slut');
  const switches = parts.filter(p => p.line);
  const ok = switches.every(p => p.read !== null && p.read - p.said <= VAXLA_READ && p.all && p.wrong / p.all <= VAXLA_WRONG);
  const runs = parts.filter(p => p.want === 'run'), walks = parts.filter(p => p.want === 'walk');
  const runCad = median(runs.flatMap(p => p.cad)), walkCad = median(walks.flatMap(p => p.cad));
  const runPace = median(runs.flatMap(p => p.pace)) || 0;
  const base = ctx.memo.basePace || DEFAULT_PACE;
  const chaser = base * 1.35, ghost = base * 1.1;
  ctx.log(`växla: Flykten och Spöket räknar från gångfarten ${kmh(base)}${ctx.memo.basePace ? '' : ' (schablon)'}, förföljaren ${kmh(chaser)}, Spöket ${kmh(ghost)}; ` +
    `springande gjorde du ${kmh(runPace)}` + (runPace > chaser ? `, Flykten vunnen på ${sec(30 / (runPace - chaser))} och Spöket kommer aldrig ikapp` : ''));
  const lag = p => p.read === null ? 'aldrig' : sec(p.read - p.said);
  return {
    outcome: ok ? 'klarade' : 'missade',
    detail: `löpning läst ${runs.map(lag).join(' / ')}, gång igen ${walks.filter(p => p.line).map(lag).join(' / ')} efter ordet; ` +
      `steg ${walkCad ? Math.round(walkCad) : '–'} gående, ${runCad ? Math.round(runCad) : '–'} springande per minut; ` +
      `annat band ${switches.map(p => p.all ? pct(p.wrong / p.all) : '–').join(' / ')}`,
  };
}

const STATIONS = {
  linjen, ja, knack, takten, flykten, frys, spoket, hitta, normalt, vandom, vagval, kompass, morse, vibration, tassa,
  kontakt, knackgang, vakten, vaxla,
};

// Stations that only work walking. A knock is not heard while running (the
// run's heel strikes are as sharp, so knocks are muted, engine.js), Hon
// knackar and Kroppsmorse are answered by knocks or stops timed to a walk,
// and Tassa compares soft steps with walking ones. Takten's beat starts from
// the walking cadence. Episodes that may be run should leave these out.
export const WALK_ONLY = ['knack', 'knackgang', 'vibration', 'morse', 'tassa', 'takten'];

// ---------- the run ----------

// The stations of lab `no` the walker has rated in the round under way, in
// the lab's order. A round ends when every station has a rating, and the
// next starts empty. `ratings` is the saved list, oldest first. A walk cut
// short goes on from the first unrated station next time (Henric, labb 2,
// 2026-10-01: two stations done, then he had to stop). Not done, rated or
// not: a station stopped inside or skipped (never walked to its end), and a
// station tried alone with ?bana= (`only`), which is not a walk of the lab,
// and stations walked from a ?banor= link (`picked`): the link stands in for
// a round kept in another browser, and counting it here would offer the rest
// of that round again in this one (review, 2026-10-01).
// A rating changed on the done screen is saved again under the same `walk`;
// it is that station once more, not the next round's first (review).
const UNFINISHED = ['avbruten', 'hoppade'];
// Labs that go on where the walker left off. Not labb 1: Stämma linjen
// measures the pace and cadence Takten, Flykten and Spöket read, so a walk
// that skips it sets them up on defaults, and Vega's intro counts eight
// stations (review, 2026-10-01). Labb 2's Gå normalt measures its own, and
// its intro counts nothing.
export const RESUMABLE = [2];

export function ratedThisRound(ratings, no) {
  const ids = LABS[no] || [];
  let round = new Set();
  const seen = new Set();
  for (const r of Array.isArray(ratings) ? ratings : []) {
    if (!r || !ids.includes(r.station) || r.only || r.picked || UNFINISHED.includes(r.outcome)) continue;
    if (r.walk) {
      const key = `${r.walk}|${r.station}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    round.add(r.station);
    if (round.size === ids.length) round = new Set();
  }
  return ids.filter(id => round.has(id));
}

// ?banor=vagval,kompass,vibration: some stations of one lab, walked in the
// lab's order. The saved ratings live in one browser, so a walk moved to
// another (Firefox does not vibrate, 2026-10-01) cannot go on where the
// walker left off; a link can. Only the labs that can be walked in part
// (RESUMABLE, for the same reason). Null unless every id is a station of the
// same such lab; the start screen then says the link was not understood.
export function chosenStations(text) {
  const ids = String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return null;
  for (const no of RESUMABLE) {
    const all = LABS[no];
    if (ids.every(id => all.includes(id))) return { lab: no, stations: all.filter(id => ids.includes(id)) };
  }
  return null;
}

// `only` runs a single station (for trying one out); `stations` a part of
// the lab, in its order, numbered as in the whole lab; `prov` one of the
// test walks (PROV), numbered within it, with its options, its own intro
// and end, a quicker word when the sensor goes quiet, and no memory lines;
// otherwise every station. `opening` and `closing` are the line ids the
// walk's memory chose (absence, keys, new ground), played around the
// stations; `closing` may be a function, asked after the last station.
export async function runLab(ctx, no, { only = null, stations = null, opening = [], closing = [], prov = null } = {}) {
  ctx.memo.cadences = ctx.memo.cadences || [];
  ctx.memo.knockWindows = ctx.memo.knockWindows || [];
  ctx.hold(true);
  const test = prov ? PROV[prov] : null;
  const all = test ? test.stations : LABS[no];
  const ids = only ? [only] : stations && stations.length ? all.filter(id => stations.includes(id)) : all;
  await ctx.play(test ? 'prov-intro' : only ? 'labb-intro-en' : `labb-intro-${no}`);
  if (!test) for (const id of opening) await ctx.play(id);
  const stopWatch = watchSensor(ctx, test ? { warn: 3 } : {});
  const introEnd = ctx.state().t;
  await ctx.until(s => s.moving && s.movingFor >= 8, { timeout: 30 });
  // A test walk listens a few seconds before its first line: the screen
  // goes dark as the phone goes in the pocket, if it does, and her word
  // about it should not wait behind a station's intro (she speaks one line
  // at a time). Then, if it did, until it answers again.
  if (test) {
    await ctx.until(s => s.t >= introEnd + 6, { timeout: 6 });
    if (test.sensor && ctx.state().sensorSeen && !ctx.state().sensorLive) await ctx.until(s => s.sensorLive, { timeout: 40 });
  }

  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const [k, n] = only ? [1, 1] : test ? [i + 1, ids.length] : [all.indexOf(id) + 1, all.length];
    ctx.station(id, k, n);
    ctx.log(`bana ${k}/${n}: ${TITLES[id]}`);
    // Walked or run: the share of the moving time the band read running.
    const gaitTime = { still: 0, walk: 0, run: 0 };
    let gaitLast = null;
    const stopGait = every(ctx, s => {
      if (gaitLast !== null) gaitTime[s.band] += s.t - gaitLast;
      gaitLast = s.t;
    });
    let r;
    try {
      r = await STATIONS[id](ctx, (test && test.opts && test.opts[id]) || {});
    } catch (err) {
      r = { outcome: 'hoppade', detail: `fel: ${err.message}` };
    }
    stopGait();
    const moved = gaitTime.walk + gaitTime.run;
    const runShare = moved ? gaitTime.run / moved : 0;
    const gait = runShare >= 0.7 ? 'springande' : runShare <= 0.1 ? 'gående' : 'blandat';
    ctx.log(`${TITLES[id]} gicks ${gait} (löpning ${pct(runShare)} av tiden i rörelse)`);
    ctx.hold(true);
    ctx.sfx.stopAll();
    results.push({ id, ...r, gait });
    ctx.result(id, { ...r, gait });
    if (i < ids.length - 1) {
      await ctx.play(`nasta-${1 + (i % 3)}`);
      await ctx.until(s => s.moving && s.movingFor >= 10, { timeout: 25 });
    }
  }
  stopWatch();

  // Double knocks outside every window where one was asked for: what the
  // detector made of plain walking.
  const stray = ctx.strayDoubles(ctx.memo.knockWindows);
  ctx.log(`knack: ${stray} dubbelknack utan att någon bad om det`);

  ctx.station(null);
  if (test) {
    await ctx.play('prov-slut');
    return results;
  }
  // A function is asked at the end: which squares were new is only known
  // once the walk is over.
  let tail = [];
  try { tail = typeof closing === 'function' ? closing() : closing; } catch (err) { ctx.log(`minne: ${err.message}`); }
  for (const id of tail) await ctx.play(id);
  await ctx.play('labb-slut');
  return results;
}
