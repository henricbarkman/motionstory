// Episode 2 in English, "Behind the Presses", as straight-line code against
// the engine. Manuscript: stories/glimt/episode-2.md (the text lives in Manus;
// that file is its mirror), whose section "The logic, beyond episode 1's" is
// the rule book for this file. It builds on episode 1 (episod1.js) and takes
// its readings of a stop and a walk from there.
//
//   - Scenes 0 to 2: she walks her round on the loop, so every stop is
//     harmless. Scene 2 is the mission (Hitta): the nearest water, woods,
//     bridge or hill near the walker, warmer or colder until the walker is at
//     its edge, and a stop there lets her see it.
//   - Scenes 3 and 4, the works and behind the presses: she is where she may
//     not be and nobody stands still, so a stop she did not ask for lights the
//     lamp, as mood only. The whole branch the first time, then only the tone.
//     Yes is two knocks after her Now (Knack). The path choice (Vägvalet),
//     going faster (Fortare), and walking in time with beats the Company pulls
//     up to the song's tempo (Takten), the song whole while the walker is in
//     time.
//   - Scene 5: she stands among the workers, so a stop is harmless again,
//     and both still for half a minute brings episode 1's reserve.
//
// She says only what the phone has read (as episode 1 in English): the light
// and the weather in scene 0 and at the end of the mission only when read,
// the walker's turn only when one was read, the lines about walking in time
// only with a step rate.
//
// The pauses before and after each line are the directing desk's, as it
// plays them (glimt/pauser.json, written by scripts/regibord_pauser.mjs): the
// desk's own, else the manuscript's "(pause about N s)", else 0.5 s. Henric
// sets them in the desk; running the script again carries them here, and
// nothing in this file names a pause length for a line.
//
// ctx as for episode 1 (episod1.js), plus:
//   pauses          {fore: {id: s}, efter: {id: s}} from pauser.json
//   memory1         what episode 1 remembered: {svarade, misstanke}, or null
//   findPlaces()    asks the map for the places near the walker now; resolves
//                   the places (world.js, classifyPlaces) or null
//   setTarget(c)    {latitude, longitude} the walker heads for, or null (the
//                   listen's walker steers there; the log says the distance)
//   gyroStatus(side), gyroTurn(opts), as the lab's (lab.js, labHelpers)
//   beats(bpm)      the presses' beats (synth.js, beat): {beats, set, stop}
//   song()          a promise of the song's decoded buffer, or null
//   playSong(buf, {at, share})  mixer.playSong: {done, setLevel, fade}
//   audioTime()     the audio clock now, which the beats are scheduled on
//   side.knock()    her knock on the pipe (herside.js)
//   remember(facts) what episode 3 will want to know

import { walking, going, heldStop } from './episod1.js';
import { nearestPlace, placeDistance, placeNearestPoint } from './world.js';
import { angleDiff } from './engine.js';
import { taktSteps } from './lab.js';

const MIN = 60;
const HALF_MINUTE = 30;     // s both still before the earpiece asks (scene 5)
const RESERVE_MAX = 3;
const SHORT_WAIT = 2.5 * MIN;
const SEE_WAIT = 20;        // s scene 0 waits for the walker to move before "There you are"
const FULL = 0.95;          // the contact scene 1 waits for, as episode 1
const full = s => s.contact >= FULL * (s.accuracy != null && s.accuracy > 40 ? 0.5 : 1);

// The mission (Hitta). The manuscript: warmer or colder about every 25 s; at
// the place within about 30 m of the edge, from a position at most half a
// minute old; 30 to 60 m a near miss; the bell after about five minutes.
export const HITTA = {
  every: 25,        // s between warmer and colder
  there: 30,        // m from the edge: there
  near: 60,         // m: a stop within this and over `there` is a near miss
  fresh: 30,        // s: the oldest position that says where the walker is
  change: 8,        // m nearer or further since the last report before she says so
  bell: 5 * MIN,    // s from the mission's start: the bell comes first
  anyWalk: 30,      // s walking before a stop is yes, when the map had nothing
  wait: 20,         // s more she waits for the map once she has asked to be shown
  goAgain: 5,       // s standing after "oh. Go." before she says it again
  slack: 15,        // m more a stop may be off after her "Here": the next fix can differ
  nearWait: 12,     // s standing after "Nearly" before she says she can't see them stand
  noneEvery: 40,    // s between her round's lines while the walker picks a place
};

// Knack: two quick knocks within about ten seconds of her Now, walking.
export const KNOCK_WINDOW = 10;
// Vägvalet: about a minute and a half for a corner. A turn is 55 to 140
// degrees from where the walker was heading when she asked, held six
// seconds; the gyro reads it with the lab's limits (lab.js, VAGVAL_GYRO).
export const CHOICE = { wait: 90, lines: [20, 45, 70], min: 55, max: 140, hold: 6, fix: 5, gyro: { min: 50, max: 140 } };
// Fortare: the step rate this much over the half minute before her line, for
// about half a minute in all within forty seconds, still walking. On GPS the
// speed, by a margin wider for its noise.
export const FAST = { ratio: 1.07, gpsRatio: 1.12, need: 12, within: 40, before: 30 };
const THINK = 10;           // s a stop in the works lasts before she thinks of something
// Takten: the song's tempo, where its first beat falls in the file (measured
// 30/10 on the master: 135.00 a minute all the way through, phase 0.44 s),
// in time within 5 % (the lab's Takten), steps of 7.5 % every 12 s (the
// manuscript: 7 to 8 %, 10 to 15 s).
export const TAKT = { bpm: 135, firstBeat: 0.44, near: 0.05, step: 0.075, hold: 12, find: 30, found: 4, lost: 3 };
const SONG_WHOLE = 90;      // s the song plays whole at most (the manuscript: about a minute and a half)
const SONG_BITS = 60;       // s of bits through the noise for a walker never in time
const SONG_BACK = 0.25;     // the song's share, drawn back behind the noise
const BEAT_GAIN = 0.5, BEAT_UNDER = 0.15;

const median = xs => {
  const v = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

export async function runEpisode2(ctx) {
  const P = ctx.pauses || { fore: {}, efter: {} };
  const mem = ctx.memory1 || {};
  const now = () => ctx.state().t;
  const side = ctx.side;
  const log = m => ctx.log(m);
  const her = {
    exposed: false,     // in the works or behind the presses: a stop shows
    stillSince: null,   // she stands still (scene 5); null while she walks
    reserves: 0,
    lampFull: false,    // the whole lamp branch has played
    lampLong: false,    // she has thought of something for a long stop
  };
  // What episode 3 will want to know (the manuscript, "Carried into episode 3").
  const facts = {
    place: null, saw: null, bellFirst: false, knock3: null, choice: null,
    faster: null, song: null, knock5: null, ranAtDoor: false,
  };
  const remember = klar => ctx.remember({ ...facts, klar });

  // What the walk has been doing, for the step rate before a line (Fortare,
  // Takten): every tick, the last minute. It never ends; the walk's end
  // releases it with every other wait.
  const ring = [];
  ctx.until(s => {
    ring.push({ t: s.t, cadence: s.paceSource === 'steps' && s.moving ? s.cadence : null, pace: s.moving ? s.pace : null, band: s.band });
    while (ring.length && ring[0].t < s.t - MIN) ring.shift();
    return false;
  });
  const before = (secs, key) => median(ring.filter(r => r.t >= now() - secs && r[key]).map(r => r[key]));

  // ---- the lamp ----
  const lit = s => her.exposed && heldStop(s);
  const stopBegan = s => s.t - s.stillFor;
  // A stop she did not ask for, in the works or behind the presses. Mood
  // only: nothing later depends on it. The first time the tone, the earpiece
  // and "now they can see me"; the first stop over THINK seconds she thinks
  // of something and fixes a pipe. After that only the tone, and her voice
  // muffled as always while the walker stands.
  // Her own lines in it are said with the lamp off, so a stop cannot light it
  // again inside itself.
  async function lamp() {
    const began = stopBegan(ctx.state());
    const first = !her.lampFull;
    her.lampFull = true;
    her.exposed = false;
    log(`lamp${first ? '' : ', the tone only'}`);
    side.tone(true);
    if (first) {
      side.pin(true);
      await ctx.until(() => false, { timeout: 1.2 });
      await side.say('x-avvikelse', 'snacka');
      side.pin(false);
      if (!ctx.state().moving) await say('s3-seen');
    }
    let thought = false;
    if (!her.lampLong) {
      await ctx.until(s => walking(s) || s.t >= began + THINK, { timeout: THINK + 5 });
      if (!ctx.state().moving && now() >= began + THINK) {
        her.lampLong = true;
        thought = true;
        log('lamp: a long stop, she thinks of something (the wrench is not built yet)');
        await say('s3-think');
      }
    }
    await ctx.until(walking, { timeout: 3 * MIN });
    side.tone(false);
    if (thought) await say('s3-pipe');
    else if (first) await say('s3-allsaid');
    her.exposed = true;
  }

  // ---- the reserve (episode 1's lines) ----
  const resting = s => her.stillSince !== null && her.reserves < RESERVE_MAX &&
    Math.min(s.stillFor, s.t - her.stillSince) >= HALF_MINUTE;
  async function reserve() {
    her.reserves++;
    log('reserve: both still for half a minute');
    side.pin(true);
    await side.say('r-hjalp', 'snacka');
    await ctx.play('r-vilar');
    side.pin(false);
    await ctx.until(walking, { timeout: 3 * MIN });
    if (her.stillSince !== null) her.stillSince = now();
  }

  // Waits for `pred` or the deadline, the lamp and the reserve run on the way.
  // 'ok', 'late', 'lamp' or 'rest' (the last two after they have run).
  async function hold(pred, opts) {
    let why = null;
    const hit = await ctx.until(s => {
      if (lit(s)) why = 'lamp';
      else if (resting(s)) why = 'rest';
      else if (pred(s)) why = 'ok';
      return !!why;
    }, opts);
    if (!hit) return 'late';
    if (why === 'lamp') await lamp();
    if (why === 'rest') await reserve();
    return why;
  }
  const pause = seconds => seconds > 0 ? hold(() => false, { timeout: seconds }) : Promise.resolve('ok');

  // A line, with no pause around it: 'done', or 'lamp' / 'rest' when a stop
  // cut it short (run, then reported), with the share heard in `heard`.
  let heard = 1;
  async function playLine(id) {
    let why = null;
    const began = now();
    const playing = ctx.play(id).then(() => { if (!why) why = 'done'; });
    const watch = ctx.until(s => {
      if (why) return true;
      if (lit(s)) why = 'lamp';
      else if (resting(s)) why = 'rest';
      return !!why;
    });
    await Promise.race([playing, watch]);
    if (why !== 'done') ctx.cut();
    await playing;
    heard = why === 'done' ? 1 : Math.min(1, (now() - began) / (ctx.seconds(id) || 1));
    if (why === 'lamp') await lamp();
    if (why === 'rest') await reserve();
    return why;
  }
  // A line with the desk's pauses before and after it, said again from the
  // start when a stop cut it before half of it was heard.
  async function say(id) {
    await pause(P.fore[id] ?? 0);
    for (;;) {
      const why = await playLine(id);
      if (why === 'done' || heard >= 0.5) break;
    }
    await pause(P.efter[id] ?? 0);
  }

  // Her Now, said only to a walker the phone reads walking (the manuscript:
  // "She says Now only when the phone reads walking"). Waits up to a minute;
  // a phone that never reads it gets her Now anyway. Returns when the word
  // fell (the window opens there).
  // Said again when a stop cut it: an answer is timed from a now that was heard.
  async function sayNow() {
    for (let i = 0; ; i++) {
      if (!walking(ctx.state())) {
        log('she waits for the walker to walk before her now');
        await hold(walking, { timeout: MIN });
      }
      await pause(P.fore['x-now'] ?? 0);
      const at = now() + (ctx.cue('x-now', 'now') || 0);
      if (await playLine('x-now') === 'done' || i >= 2) return at;
    }
  }

  // ==== 0. Back ====
  // Always as a new round: "straight after episode 1" needs the two episodes
  // played as one, which the app does not do yet (the manuscript's OM DIREKT).
  ctx.hold(true);
  log(`scene 0, a new round; from episode 1: ${mem.svarade ? 'answered' : "didn't answer"}, ${mem.misstanke ? 'suspicion' : 'no suspicion'}${ctx.memory1 ? '' : ' (no memory)'}`);
  await say('s0-1');
  // "There you are. I'd know that shape anywhere." says she sees the walker,
  // and what the phone can read of that is the walk (v58: until then it was
  // said about 7 s in, whatever the walker did). So she waits up to SEE_WAIT
  // for the walker to be read going; to a walker the phone never reads
  // moving she says "You came back." next, not that she sees them.
  if (!going(ctx.state())) {
    log('scene 0: she waits for the walker to move before she says she sees them');
    await hold(going, { timeout: SEE_WAIT });
  }
  if (going(ctx.state())) await say('s0-2');
  else log('scene 0: the phone has not read the walker moving, she does not say she sees them');
  await say('s0-3');
  if (ctx.world && ctx.world.light === 'dark') await say('s0-dark');
  await say(mem.misstanke ? 's0-susp' : 's0-nosusp');
  await say('s0-happened');
  await say('s0-clear');
  remember(false);

  // ==== 1. The Question ====
  const clear = await ctx.until(s => full(s) && s.moving && s.movingFor >= 3, { timeout: SHORT_WAIT });
  log(`scene 1${clear ? '' : ', the line never came through clear'}`);
  // The map once more, from here, for scene 2 (the manuscript: "The phone
  // asks the map again as the scene starts").
  let places = null, mapAnswered = false;
  const asked = (ctx.findPlaces ? ctx.findPlaces() : Promise.resolve(null)).then(p => { places = p; mapAnswered = true; });
  for (const id of ['s1-1', 's1-2', 's1-3', 's1-4', 's1-5', 's1-self', 's1-6']) await say(id);
  remember(false);

  // ==== 2. Outside ====
  const t2 = now();
  log('scene 2');
  await say('s2-1');
  if (!mapAnswered) await Promise.race([asked, ctx.until(() => false, { timeout: HITTA.wait })]);
  const freshHere = s => {
    const p = ctx.position ? ctx.position() : null;
    return p && s.t - p.t <= HITTA.fresh ? p : null;
  };
  const here0 = freshHere(ctx.state());
  const target = here0 && places ? nearestPlace(places, here0) : null;
  log(`scene 2: the map ${!mapAnswered ? 'did not answer in time' : places === null ? 'did not answer' : `has ${places.length} places`}` +
    `${!here0 ? ', no fresh position' : ''}` +
    `${target ? `; the nearest: ${target.kind} (${target.id}), ${Math.round(target.dist)} m to its edge` : '; nothing within 250 m'}`);

  let yes = false;
  if (!target) {
    // OM INGET: the walker picks a place, and a stop after half a minute of
    // walking is yes.
    await say('s2-none1');
    await say('s2-none2');
    let walked = 0, last = now();
    const deadline = Math.max(t2 + HITTA.bell, now() + HITTA.anyWalk + 30);
    // Her round between, so the search is not minutes of silence (the
    // feasibility review of v56): two of the walking lines, spaced out.
    const between = ['s2-walk2', 's2-walk3'];
    for (;;) {
      const r = await ctx.until(s => {
        const dt = s.t - last; last = s.t;
        if (s.moving) walked += dt;
        return walked >= HITTA.anyWalk && heldStop(s) && stopBegan(s) > t2;
      }, { by: between.length ? Math.min(deadline, now() + HITTA.noneEvery) : deadline });
      if (r) { yes = true; break; }
      if (!between.length || now() >= deadline - 1) break;
      await say(between.shift());
    }
    if (yes) log('scene 2: the walker stopped, she sees the sky');
  } else {
    facts.place = target.kind;
    await say(`s2-${target.kind}`);
    const dist = s => { const p = freshHere(s); return p ? placeDistance(target.place, p) : null; };
    const point = here0 ? placeNearestPoint(target.place, here0) : null;
    if (point && ctx.setTarget) ctx.setTarget(point);
    const first = dist(ctx.state());
    // A stop counts from the moment she asks for it, not from the end of
    // her asking: a walker who stops at "Stop here" has stopped before it ends.
    const tStops = now();
    if (first !== null && first <= HITTA.there) {
      // Why to stop before where: "When we're there, stop ... It's right by you. Stop here."
      log('scene 2: the walker is there already');
      await say(mem.svarade ? 's2-stop-ans' : 's2-stop');
      await say('s2-byyou');
    } else {
      await say('s2-take');
      await say(mem.svarade ? 's2-stop-ans' : 's2-stop');
    }
    // Warmer and colder, and the stop. The report goes out every `every`
    // seconds, measured against the last one she gave; "here" as soon as the
    // walker is there; the walking lines now and then between.
    const warm = ['s2-warm1', 's2-warm2', 's2-warm3'], cold = ['s2-cold1', 's2-cold2', 's2-cold3'];
    const walkLines = ['s2-walk1', 's2-walk2', 's2-walk3'];
    let nWarm = 0, nCold = 0, reports = 0, saidHere = first !== null && first <= HITTA.there;
    let lastDist = first, lastAt = now(), stopSeen = null;
    for (;;) {
      let ev = null;
      const hit = await ctx.until(s => {
        if (s.t >= t2 + HITTA.bell) { ev = 'bell'; return true; }
        if (heldStop(s) && stopBegan(s) > tStops - 2 && stopBegan(s) !== stopSeen) {
          const d = dist(s);
          stopSeen = stopBegan(s);
          // After her "Here" the fix that saw it may be a few metres off the one that sees the stop.
          if (d !== null && d <= HITTA.there + (saidHere ? HITTA.slack : 0)) { ev = 'there'; return true; }
          if (d !== null && d <= HITTA.near) { ev = 'near'; return true; }
        }
        const d = dist(s);
        if (d !== null && d <= HITTA.there && !saidHere && s.moving) { ev = 'here'; return true; }
        if (s.t >= lastAt + HITTA.every && s.moving) { ev = 'report'; return true; }
        return false;
      });
      if (!hit) break;      // the walk has ended
      if (ev === 'bell') break;
      if (ev === 'there') { yes = true; log('scene 2: the walker stopped at the place'); break; }
      if (ev === 'near') {
        log('scene 2: a stop near the place, not at it');
        await say('s2-near');
        // A walker who thinks they are there and stays: she can't see them standing.
        if (!await ctx.until(walking, { timeout: HITTA.nearWait })) {
          await say('s2-go-again');
          await ctx.until(walking, { timeout: MIN });
        }
        lastAt = now();
        continue;
      }
      const d = dist(ctx.state());
      if (ev === 'here') {
        saidHere = true;
        await say('s2-here');
        lastDist = d; lastAt = now();
        continue;
      }
      // A report.
      reports++;
      let id = null;
      if (d === null) log('scene 2: no fresh position, she says nothing');
      else if (d <= HITTA.there) id = 's2-byyou';
      else if (d <= HITTA.near) id = lastDist !== null && d > lastDist + HITTA.change ? cold[Math.min(nCold++, 2)] : (reports % 2 ? 's2-almost' : 's2-close');
      else if (lastDist !== null && d < lastDist - HITTA.change) id = warm[Math.min(nWarm++, 2)];
      else if (lastDist !== null && d > lastDist + HITTA.change) id = cold[Math.min(nCold++, 2)];
      else if (walkLines.length) id = walkLines.shift();
      if (d !== null) log(`scene 2: ${Math.round(d)} m to the edge${lastDist === null ? '' : ` (${Math.round(lastDist)} m before)`}`);
      if (id) await say(id);
      // A walking line between, now and then, while the distance changes.
      if (id && /warm|cold/.test(id) && reports % 3 === 0 && walkLines.length) await say(walkLines.shift());
      if (d !== null) lastDist = d;
      lastAt = now();
    }
    if (ctx.setTarget) ctx.setTarget(null);
  }

  if (yes) {
    // JA: she loses the walker, and the picture held still before it went.
    await say('s2-oh');
    if (!await ctx.until(going, { timeout: HITTA.goAgain })) {
      if (!ctx.state().moving) await say('s2-go-again');
    }
    await ctx.until(walking, { timeout: 3 * MIN });
    await say('s2-held');
    if (target) {
      facts.saw = target.kind;
      await say(`s2-saw-${target.kind}`);
    } else {
      // The sky, only what the phone has read.
      const w = ctx.world || {};
      const sky = w.rain === true ? 's2-sky-rain' : w.light === 'dark' ? 's2-sky-dark' : w.light === 'light' ? 's2-sky-light' : null;
      facts.saw = sky ? sky.slice(3) : 'nothing read';
      if (sky) await say(sky);
      else log('scene 2: the phone has read neither light nor weather, she says nothing of the sky');
    }
    await say('s2-going');
  } else {
    facts.bellFirst = true;
    log('scene 2: the bell comes first');
    await say('s2-bell-first');
  }
  remember(false);

  // The shift bell, far off.
  side.bell();
  await ctx.until(() => false, { timeout: 2.2 });
  await say('s2-bell');

  // ==== 3. The Works ====
  log('scene 3');
  await say('s3-1');
  await say('s3-glove');
  if (ctx.state().band === 'run') {
    facts.ranAtDoor = true;
    log('scene 3: the walker is running at the door');
    await say('s3-run');
  }
  await say('s3-in');
  her.exposed = true;
  log('scene 3: in the works, a stop shows');
  await say('s3-warm');
  await say('s3-cant');
  await say('s3-how');
  // Her knock on the pipe.
  await pause(0.6);
  side.knock();
  await pause(1.2);
  await say('s3-knock');
  const knockedSince = at => s => Number.isFinite(s.lastDoubleKnockAt) && s.lastDoubleKnockAt >= at - 0.5;
  // A stop in the window lights the lamp, and the window is gone by the time
  // it is out: her now once more, and a new window.
  let knocked = null, nowAt = null;
  for (let i = 0; i < 2 && knocked !== 'ok' && knocked !== 'late'; i++) {
    if (i) log('scene 3: the knock window went to the lamp, her now again');
    nowAt = await sayNow();
    knocked = await hold(knockedSince(nowAt), { by: nowAt + KNOCK_WINDOW });
  }
  facts.knock3 = knocked === 'ok';
  log(`scene 3: ${facts.knock3 ? 'two knocks' : 'no knock'}`);
  if (facts.knock3) { await say('s3-yes1'); await say('s3-yes2'); }
  else { await say('s3-no1'); await say('s3-no2'); }

  // Vägvalet. The lamp waits until the turn is read: a walker at a corner
  // deciding is not seen.
  await say('s3-split');
  her.exposed = false;
  await say('s3-choose');
  const tq = now();
  // A heading only from a fix just now: the engine keeps the last bearing
  // for a while after the GPS goes quiet, and a stale one never turns.
  const headingNow = s => {
    const p = ctx.position ? ctx.position() : null;
    return s.moving && p && s.t - p.t <= CHOICE.fix ? s.heading : null;
  };
  const h0of = () => headingNow(ctx.state());
  let h0 = h0of();
  // Readable only by a heading read inside the window: one from before it,
  // with the GPS gone since, would make every walk "straight".
  let readable = false;
  let turn = null, off = 0, sign = 0, lastT = tq;
  const gyroOk = () => ctx.gyroStatus ? ctx.gyroStatus(true).ok : false;
  const read = ctx.until(s => {
    const dt = s.t - lastT; lastT = s.t;
    if (gyroOk()) {
      readable = true;
      const r = ctx.gyroTurn({ since: tq, ...CHOICE.gyro });
      if (r) { turn = { dir: r.deg > 0 ? 'right' : 'left', by: 'gyro', deg: r.deg }; return true; }
    }
    if (h0 === null) { h0 = headingNow(s); if (h0 !== null) readable = true; return false; }
    const h = headingNow(s);
    if (h === null) return false;
    readable = true;
    const d = angleDiff(h0, h);
    const turned = Math.abs(d) >= CHOICE.min && Math.abs(d) <= CHOICE.max;
    if (turned && Math.sign(d) === sign) off += dt;
    else { off = turned ? dt : 0; sign = Math.sign(d); }
    if (off >= CHOICE.hold) { turn = { dir: sign > 0 ? 'right' : 'left', by: 'gps', deg: d }; return true; }
    return false;
  }, { timeout: CHOICE.wait });
  for (const [i, at] of CHOICE.lines.entries()) {
    const done = await Promise.race([read.then(() => true), ctx.until(s => s.t >= tq + at).then(() => false)]);
    if (done || turn) break;
    await say(`s3-wait${i + 1}`);
  }
  await read;
  facts.choice = turn ? turn.dir : readable ? 'straight' : 'unknown';
  log(`scene 3: the choice: ${turn ? `${turn.dir} (${turn.by}, ${Math.round(turn.deg)}°)` : readable ? 'no turn read' : 'no heading to read a turn from'}`);
  her.exposed = true;
  if (turn) { await say(`s3-${turn.dir}`); await say('s3-followed'); }
  else await say(readable ? 's3-straight' : 's3-unknown');
  await say('s3-ours');

  // Fortare.
  await say('s3-lit');
  const baseC = before(FAST.before, 'cadence');
  const baseP = before(FAST.before, 'pace');
  await say('s3-fast');
  let fast = 0, lastF = now();
  const quick = await hold(s => {
    const dt = s.t - lastF; lastF = s.t;
    const walkingNotRunning = s.moving && s.band !== 'run';
    const by = baseC && s.paceSource === 'steps' ? s.cadence >= baseC * FAST.ratio
      : baseP ? s.pace >= baseP * FAST.gpsRatio : false;
    if (walkingNotRunning && by) fast += dt;
    return fast >= FAST.need;
  }, { timeout: FAST.within });
  facts.faster = quick === 'ok';
  log(`scene 3: ${facts.faster ? 'faster' : 'the same pace'} (before: ${baseC ? `${Math.round(baseC)} steps a minute` : 'no step rate'}, ` +
    `${baseP ? `${baseP.toFixed(2)} m/s` : 'no speed'}; ${Math.round(fast)} s faster)`);
  await say(facts.faster ? 's3-errand' : 's3-lost');
  remember(false);
  // On to the presses, walking.
  await hold(() => false, { timeout: 12 });

  // ==== 4. The Presses ====
  log('scene 4');
  // The walker's own pace from before Faster: a walker who did as she asked
  // is still fast in the last half minute, and would meet 135 with no steps up.
  const baseStep = baseC || before(HALF_MINUTE, 'cadence');
  const runner = ctx.state().band === 'run';
  const from135 = !baseStep || runner || baseStep >= TAKT.bpm * (1 - TAKT.near);
  const steps = from135 ? [TAKT.bpm] : taktSteps(Math.max(60, baseStep), TAKT.bpm, TAKT.step);
  log(`scene 4: the beats from ${steps[0]} a minute${from135 ? (runner ? ' (running)' : !baseStep ? ' (no step rate)' : ' (already near the song)') : `, the walker's ${Math.round(baseStep)}; steps ${steps.join(', ')}`}`);
  const beats = ctx.beats ? ctx.beats(steps[0]) : { beats: [], set() {}, stop() {} };
  let bpm = steps[0], stepAt = 0;
  const pullTo = k => { stepAt = k; bpm = steps[k]; beats.set({ bpm }); log(`scene 4: the beats at ${bpm}`); };
  const inTime = s => s.paceSource === 'steps' && s.cadence > 0 && Math.abs(s.cadence - bpm) / bpm < TAKT.near;
  await say('s4-1');
  await say('s4-back');
  await say('s4-wall');
  await say('s4-people');
  await say('s4-self');
  await say('s4-intime');
  // The Company pulls the tempo up: a step every TAKT.hold seconds until the
  // song's, beside her lines.
  let pulled = Promise.resolve();
  if (steps.length > 1) {
    pulled = (async () => {
      for (let k = 1; k < steps.length; k++) {
        await ctx.until(() => false, { timeout: k === 1 ? 1 : TAKT.hold });
        pullTo(k);
      }
    })();
    await ctx.until(() => stepAt >= 1, { timeout: 5 });
    await say('s4-pull');
  }
  // [in time] or [out of time], only with a step rate to tell by.
  if (ctx.state().paceSource === 'steps') {
    const found = await hold(inTime, { timeout: 8 });
    await say(found === 'ok' ? 's4-instep' : 's4-listen');
  } else {
    log('scene 4: no step rate, she says nothing about walking in time');
  }
  if (steps.length > 2) await ctx.until(() => stepAt >= 2, { timeout: TAKT.hold + 5 });
  await say('s4-she');
  log('scene 4: two sneezes (not built yet)');
  await say('s4-clogs');
  await say('s4-clogs2');
  await pulled;
  if (facts.ranAtDoor) await say('s4-run');

  // In time with the song's tempo, or not.
  const readsSteps = ctx.state().paceSource === 'steps';
  let found = 0, lastK = now();
  const together = !readsSteps ? 'ok' : await hold(s => {
    const dt = s.t - lastK; lastK = s.t;
    found = inTime(s) ? found + dt : 0;
    return found >= TAKT.found;
  }, { timeout: TAKT.find });
  const songBuf = ctx.song ? await Promise.race([ctx.song(), ctx.until(() => false, { timeout: 5 }).then(() => null)]) : null;
  // The song's first beat on one of the presses' beats: the next scheduled
  // beat far enough ahead, and the song started its first beat before it.
  const songAt = () => {
    const period = 60 / TAKT.bpm;
    const t = ctx.audioTime ? ctx.audioTime() : 0;
    let b = beats.beats.length ? beats.beats[beats.beats.length - 1] : t + 0.5;
    while (b - TAKT.firstBeat < t + 0.1) b += period;
    return b - TAKT.firstBeat;
  };
  her.exposed = false;      // the song's own loop reads a stop below
  if (together === 'ok') {
    facts.song = songBuf ? 'whole' : 'no song here';
    log(`scene 4: in time${readsSteps ? '' : ' (no step rate: the song comes whole while the walker moves)'}`);
    if (songBuf) {
      const song = ctx.playSong(songBuf, { at: songAt(), share: 1 });
      beats.set({ gain: BEAT_UNDER });
      const t0 = now();
      let out = 0, lastS = now(), level = 1, toned = false;
      await ctx.until(s => {
        const dt = s.t - lastS; lastS = s.t;
        const still = heldStop(s);
        if (still !== toned) { toned = still; side.tone(still); if (still) log('scene 4: a stop under the song, it draws back'); }
        const ok = !still && (readsSteps ? inTime(s) : s.moving);
        out = ok ? 0 : out + dt;
        const want = out >= TAKT.lost ? SONG_BACK : 1;
        if (want !== level) { level = want; song.setLevel(level, 1.5); log(`scene 4: the song ${level === 1 ? 'comes forward' : 'draws back'}`); }
        return s.t >= t0 + SONG_WHOLE;
      }, { timeout: SONG_WHOLE + 5 });
      if (toned) side.tone(false);
      song.fade(4);
      beats.set({ gain: BEAT_GAIN });
      await ctx.until(() => false, { timeout: 4 });
      await ctx.until(walking, { timeout: MIN });
      await say('s4-sing');
    } else {
      log('scene 4: no song at this address');
      await pause(15);
      await say('s4-hum');
    }
  } else {
    facts.song = songBuf ? 'bits' : 'no song here';
    log('scene 4: never in time, the song only in bits');
    if (songBuf) {
      // A bit through the noise now and then: up for three seconds every
      // fifteen, down to almost nothing between.
      const song = ctx.playSong(songBuf, { at: songAt(), share: 0.08 });
      const t0 = now();
      let next = t0 + 8, upUntil = null;
      await hold(s => {
        if (s.t >= next) { next += 15; upUntil = s.t + 3; song.setLevel(0.3, 1); }
        else if (upUntil !== null && s.t >= upUntil) { upUntil = null; song.setLevel(0.08, 2); }
        return s.t >= t0 + SONG_BITS;
      }, { timeout: SONG_BITS + 5 });
      song.fade(3);
    } else {
      await pause(15);
    }
    await say('s4-hum');
  }
  her.exposed = true;
  await say('s4-air');
  await say('s4-how');
  await say('s4-place');
  await pause(2 * 60 / bpm);    // two beats, nobody says anything
  await say('s4-nod');
  her.exposed = false;
  remember(false);

  // ==== 5. The Book ====
  log('scene 5: she stands among the workers, a stop is harmless');
  beats.set({ bpm: 110, gain: 0.25 });
  her.stillSince = now();
  for (const id of ['s5-1', 's5-2', 's5-open']) await say(id);
  log('scene 5: pages (not built yet)');
  for (const id of ['s5-alien', 's5-night', 's5-free', 's5-carry', 's5-hope']) await say(id);
  if (ctx.state().band === 'run') {
    log('scene 5: the walker is running');
    await say('s5-run');
  }
  await say('s5-ask');
  nowAt = await sayNow();
  let answer = null;
  await hold(s => {
    if (knockedSince(nowAt)(s)) answer = 'knock';
    else if (heldStop(s) && stopBegan(s) >= nowAt - 0.5) answer = 'stop';
    return !!answer;
  }, { by: nowAt + KNOCK_WINDOW });
  facts.knock5 = answer || 'nothing';
  log(`scene 5: ${answer === 'knock' ? 'two knocks' : answer === 'stop' ? 'a stop' : 'no answer'}`);
  if (answer === 'knock') await say('s5-two');
  else if (answer === 'stop') {
    await say('s5-stopped');
    await ctx.until(walking, { timeout: MIN });
    await say('s5-habits');
  } else await say('s5-nothing');
  if (facts.ranAtDoor) await say('s5-runfree');
  for (const id of ['s5-asked', 's5-asked2', 's5-noword', 's5-book', 's5-quiver']) await say(id);
  // The presses slow down and stop.
  beats.set({ bpm: 80, gain: 0.15 });
  await ctx.until(() => false, { timeout: 1.5 });
  beats.stop();
  for (const id of ['s5-station', 's5-rustle', 's5-home']) await say(id);
  her.stillSince = null;
  remember(false);

  // The end. A walker who stops: her voice sinks away, the rumble (and the
  // woman humming: not built yet). A walker who goes on: she fades.
  const stoppedAtEnd = await ctx.until(s => !s.moving && s.stillFor >= 5, { timeout: 20 });
  if (stoppedAtEnd) {
    log('end');
    side.pin(true);
    await ctx.until(() => false, { timeout: 4 });
    side.breath();
    await ctx.until(() => false, { timeout: 2.5 });
  } else {
    log('end: the walker goes on');
  }
  remember(true);
  side.fade(5);
  await ctx.fadeOut(5);
}
