// Episode 1, "Det är när du går", as straight-line code against the engine.
// Manuscript: stories/glimt/episod-1.md. Its section "Logiken" is the rule
// book for this file:
//
//   - The walker walks: the Company reads the walker's steps as hers, and
//     sees a worker on her round whatever she does.
//   - The walker stands still: it reads her own steps. If she takes them
//     where she may not walk, the lamp lights.
//   - Both stand still: nothing to read. After half a minute the snäcka asks
//     what she is doing, she says she is resting, and the story goes on when
//     the walker walks.
//   - Her voice is always dull while the walker stands still, and her side is
//     heard instead. Her own steps are never heard (Henric 21/10). The app does that part (the veil in app.js); here it is
//     only pinned on while a line on her side must be heard to its end.
//
// So a stop is harmless while she walks her round (scenes 0 and 1) or sits
// still (scene 3), and lights the lamp while she moves where she must not be:
// scene 2 from the moment she steps off the gravel, and scene 4 until she is
// back on it. `her.exposed` is that fact, and `lit` is the one place a stop
// is turned into the lamp.
//
// When she asks for a stop, her answer is a stop that begins after the word
// that asks. A walker who stood there already, at a kerb or a red light, has
// not said anything.
//
// Between scene 0 and scene 1 come the opening credits: a whole song down the
// line, Vega silent (ctx.credits()).
//
// ctx as in chapter1.js, plus:
//   side            her side of the line (herside.js): walk, other, hand,
//                   tone, bell, lift, pin, fade, breath, and say(lineId, kind)
//   cut()           stops the voice line that is playing
//   play(id, { unless })  a line not said at all if `unless(state)` holds as
//                   its turn comes; resolves 'skipped' then
//   breakOff(id)    ends line `id` at its next pause, after the sentence she
//                   is in (the chapter's "breaks"); false while `id` is not
//                   playing yet, true once done
//   credits()       plays the opening credits, resolves when the song is over
//   seconds(id)     length of a line
//   cue(id, word)   seconds into a line where a word falls, measured from
//                   the rendered file ("last:nu" is the line's last "nu")
//   remember(facts) what episode 2 will want to know

const MIN = 60;
// s she waits for a stop she asked for, after the line: five when the feet
// decide, twenty on GPS, which reads a stop late. Ten on the feet until v40
// (Henric 2026-10-08); after his walk of 23/10 it was too long a wait for a
// no ("det tog lite väl lång tid innan Vega uppfattade att jag inte stannade").
const askWindow = s => s.paceSource === 'steps' ? 5 : 20;
// The same at the tree in scene 2, where the answer is the lamp: it reads a
// stop with the band, three seconds after the last step on the feet, so the
// window keeps its ten seconds there.
const treeWindow = s => s.paceSource === 'steps' ? 10 : 20;
const HALF_MINUTE = 30;     // s without steps before the snäcka asks
const COUNT_BREATH = 0.8;   // s between the count under her breath and its last numbers
const RESERVE_MAX = 3;      // times it asks in one walk, then it lets her be
const SHORT_WAIT = 2.5 * MIN; // s a scene waits for a walker who is not walking
const LONG_WAIT = 10 * MIN;   // the same, when the feet say the walker stands
const PATIENCE = 30;        // s a walker who stood before she asked gets to walk first
const FULL = 0.95;          // the contact scene 1 waits for after the credits
// s after scene 4 before the end: 15 for a walker nearly back, 25 for all the
// others. A walk longer than the episode must not wait a minute and more in
// the hum, after a line that sounds like an end (dramaturg 20/10).
const END_SOON = 15;
const END_GAP = 25;
// Poor GPS (over 40 m) caps the contact at half (engine.js, Contact), so full
// is measured against the cap, or scene 1 would wait out its deadline in silence.
const full = s => s.contact >= FULL * (s.accuracy != null && s.accuracy > 40 ? 0.5 : 1);

// When each scene may open at the earliest, in seconds from the start: the
// episode's pace for a walker who walks all the way, with the credits in it.
// The trigger lines in the manuscript say the same in minutes.
const AT = {
  tree: 5 * MIN,          // scene 2
  sky: 7.5 * MIN,         // scene 3
  bell: 9.5 * MIN,        // scene 4
};

// A stop the walker means. The feet say it two seconds after the last step,
// so one second more is enough; GPS alone needs longer to be sure.
const sure = s => s.paceSource === 'steps' ? 1 : 3;
const stopped = s => !s.moving && s.stillFor >= sure(s);
// How late the phone sees that a stop began: the feet two seconds after the
// last step, GPS a fix or two after the speed drops. A stop that began
// before her window closed is her answer even when it shows after it.
const seenLate = s => s.paceSource === 'steps' ? 2.5 : 4;
export const walking = s => s.moving && s.movingFor >= 1.5;
// A stop on the feet, for an answer: this long since the walk's last step,
// with the sensor still reporting (SENSOR_FRESH), so a page that stopped
// getting samples is not a walker who stopped. The band needs about three
// seconds for the same (STEP_GONE and sure()); this answers a second sooner.
// 1.5 s was tried against every saved walk on the feet (28/9 to 23/10, 45
// minutes): 45 gaps that long opened in a walk, against 31 of two seconds,
// and of the 14 between, 8 were walking on (GPS at a walking pace, no stop
// after), 2 hesitations just before a real stop, 2 knocks while walking and
// 2 unclear. Gaps of two seconds were already a yes (the gap rule, below), so
// this adds no false yes; 1.5 s would add about one every six minutes of walking.
// The lamp keeps the band: a stop there is costly to see that is not one.
const FEET_STOP = 2.0;
const SENSOR_FRESH = 0.5;   // s: the newest motion sample, at most this old
const feetStill = s => s.paceSource === 'steps' && s.t - s.lastStepAt >= FEET_STOP
  && s.t - s.sensorAt < SENSOR_FRESH && !(s.sensorResetAt > s.lastStepAt);
// Going again, by the feet: the band says moving, and the last three steps
// came at a gait's pace, just now. The band wants a second and a half of
// moving before it calls it walking, and a walker who stood two and a half
// seconds for a yes is often off again by the time she has seen it (Henric's
// walk 23/10: "Gå igen" to someone already going). Two steps are not enough:
// a phone handled by someone standing bumps about once a second, and two
// bumps read as steps. Nor are three without the band: standing in Labb 2
// (1/10, 5:20) his phone's bumps came 0.70 and 0.30 s apart, while the band
// rightly said still. On the walk of 23/10, in four restarts after a stop,
// his first steps came 0.42-0.77 s apart (a small sample, and 0.77 is close
// to the line), and the band said moving on the same tick as the steps did.
// A slower walker falls back on `walking`, as before.
const STRIDE = 0.8;
export const quickSteps = s => s.paceSource === 'steps' && s.t - s.lastStepAt < STRIDE
  && s.lastStepAt - s.prevStepAt < STRIDE && s.prevStepAt - s.prev2StepAt < STRIDE;
export const going = s => walking(s) || (s.moving && quickSteps(s));
// Still standing, as a line that asks the walker to go needs: on the feet, no
// step since `since`; off them, not going. One step is enough to stop asking:
// "Där! Ja." is said, "Gå nu, gå." only to someone who still stands (v40).
const standing = (s, since) => s.paceSource === 'steps' ? !(s.lastStepAt > since) : !going(s);

export async function runEpisode1(ctx) {
  const side = ctx.side;
  const now = () => ctx.state().t;
  const her = {
    exposed: false,     // her own steps would give her away
    stillSince: null,   // since when she stands or sits still; null while she walks
    reserves: 0,        // times the snäcka has asked if she needs help
    askedFor: false,    // the walker has stopped when she asked for it
    heardNo: false,     // the walker walked on when she asked "hör du mig?"
    lampTree: false,    // the lamp lit among the trees
    lamp4: false,       // the lamp lit when the shift came round the bend
  };
  const remember = klar => ctx.remember({ svarade: her.askedFor, misstanke: her.lamp4, klar });

  // The gate. A stop lights the lamp only while she is exposed.
  const lit = s => her.exposed && stopped(s);
  // Both still for half a minute: the snäcka has had nothing to read. She is
  // never exposed and still at once: `stillSince` is null whenever she walks.
  const resting = s => her.stillSince !== null && her.reserves < RESERVE_MAX &&
    Math.min(s.stillFor, s.t - her.stillSince) >= HALF_MINUTE;
  // When the walker's stop began, as far as the phone knows.
  const stopBegan = s => s.t - s.stillFor;
  let lampStop = 0;           // when the stop that last lit the lamp began

  // The reserve. It asks, she answers, and the story waits for the walker.
  async function reserve() {
    her.reserves++;
    ctx.log('reserve: both still for half a minute');
    side.pin(true);
    await side.say('r-hjalp', 'snacka');
    await ctx.play('r-vilar');
    side.pin(false);
    await ctx.until(walking, { timeout: 3 * MIN });
    her.stillSince = now();
  }

  // Waits for `pred` or the deadline. Says how it ended: 'ok', 'late', 'lamp'
  // (a stop lit the lamp first) or 'rest' (the reserve ran first).
  async function hold(pred, opts) {
    let why = null;
    const hit = await ctx.until(s => {
      if (lit(s)) { why = 'lamp'; lampStop = stopBegan(s); }
      else if (resting(s)) why = 'rest';
      else if (pred(s)) why = 'ok';
      return !!why;
    }, opts);
    if (!hit) return 'late';
    if (why === 'rest') await reserve();
    return why;
  }
  const pause = seconds => hold(() => false, { timeout: seconds });

  // Plays a line. 'done' when it reached its end; 'lamp' or 'rest' when a
  // stop cut it short, with the share of it that was heard in `heard`.
  // With `stop`, a state it holds for cuts the line too, as 'stop'.
  // With `go`, it is a line that asks the walker to go (goLine).
  let heard = 1;
  async function line(id, opts, stop = null) {
    let why = null;
    const began = now();
    const playing = (opts && opts.go ? goLine(id) : ctx.play(id, opts)).then(() => { if (!why) why = 'done'; });
    const watch = ctx.until(s => {
      if (why) return true;
      if (lit(s)) { why = 'lamp'; lampStop = stopBegan(s); }
      else if (resting(s)) why = 'rest';
      else if (stop && stop(s)) why = 'stop';
      return !!why;
    });
    await Promise.race([playing, watch]);
    if (why !== 'done') ctx.cut();
    await playing;
    heard = why === 'done' ? 1 : Math.min(1, (now() - began) / (ctx.seconds(id) || 1));
    if (why === 'rest') await reserve();
    return why;
  }
  // A line she says to the end: after the reserve she says it again.
  async function say(id, opts) {
    for (;;) {
      const why = await line(id, opts);
      if (why !== 'rest') return why;
    }
  }

  // Scenes open when the walker is walking, so a line never starts into a
  // stop. The deadline is for a phone that cannot tell: the episode goes on.
  // With `patience` she waits longer, but only while the feet say the walker
  // stands: the step sensor can be trusted on that, GPS alone cannot.
  // 'lamp' if a stop lit the lamp while it waited, 'late' at the deadline.
  async function opens(at, patience = SHORT_WAIT) {
    let by = at + SHORT_WAIT;
    for (;;) {
      const why = await hold(s => s.t >= at && s.moving && s.movingFor >= 3, { by });
      if (why === 'rest') continue;
      if (why === 'late' && by < at + patience && ctx.state().paceSource === 'steps') { by = at + patience; continue; }
      return why;
    }
  }

  // She asks for a stop with line `id`, where she is not exposed. The window
  // opens at `word` in the line (the line's start without one), not at its
  // end: a walker who stops on the word and walks again before she has
  // finished has answered. It closes ten seconds after the line (twenty on
  // GPS). With `patience`, a walker who stood there before she asked gets
  // that long to walk again first.
  // The answer is a stop out of walking: someone waiting at a kerb who shifts
  // their weight makes the phone see a new stop, and that is not one.
  // The window is about when the stop began, not when the phone saw it: she
  // keeps listening `seenLate` past the close, and long enough to be sure.
  // The open is not moved the same way, on purpose: a stop the phone sees
  // after the word can have begun just before it, and a walker stopping as
  // she starts to ask has answered. Moving it would cost the quick ones.
  // On the feet the stop is the walk's last step, which they know to the
  // sample, so it needs no `seenLate`: FEET_STOP after it while the walker
  // still stands, or a gap that long once the next step comes (a stop
  // shorter than the band sees: Henric's walk 21/10).
  // A window that closes on a walker still walking is a no without waiting
  // out the rest (Henric 23/10: the no came 13.6 s after the line). On the
  // feet that is a step after the close, the band calling it walking, and the
  // last three steps at a gait's pace (quickSteps): a phone in the hand
  // bumps, a bump is a step, and bumps at 70 a minute make the band say walk,
  // but they do not come under STRIDE apart twice in a row (HANDLED_2310 in
  // the tests; with the band alone the field walker heard a no in 4 of 10).
  // A slower walker waits out the window as before. On GPS it is the band
  // once `seenLate` has passed, for GPS sees a stop just before the close
  // only then.
  async function ask(id, word = 'stanna', patience = 0) {
    const askedAt = now() + (word ? ctx.cue(id, word) : 0);
    let walked = false;
    let yes = false;
    let closes = Infinity;
    let step = null;            // the newest step, and whether it came in a walk
    let inWalk = false;
    const answer = ctx.until(s => {
      if (s.t >= askedAt - 2 && walking(s)) walked = true;
      if (s.lastStepAt !== step) {
        // The gap between two steps the feet took one after the other, read
        // from the engine, not between the two this check happened to see: a
        // throttled page can skip steps. A gap the sensor was silent through
        // is no stop.
        const gapFrom = s.prevStepAt;
        if (inWalk && s.paceSource === 'steps' && s.lastStepAt - gapFrom >= FEET_STOP && gapFrom >= askedAt && gapFrom < closes
          && !(s.sensorResetAt > gapFrom)) yes = true;
        step = s.lastStepAt;
        inWalk = walking(s);
      }
      if (inWalk && feetStill(s) && s.lastStepAt >= askedAt && s.lastStepAt < closes) yes = true;
      const began = stopBegan(s);
      if (walked && stopped(s) && began >= askedAt && began < closes + seenLate(s)) yes = true;
      const walksOn = walking(s) && (s.paceSource === 'steps' ? s.lastStepAt >= closes && quickSteps(s) : s.t >= closes + seenLate(s));
      return yes || (s.t >= closes && walksOn) || s.t >= closes + seenLate(s) + sure(s);
    });
    await ctx.play(id);
    const s = ctx.state();
    if (!yes && patience && !s.moving && stopBegan(s) < askedAt) await ctx.until(s => yes || walking(s), { timeout: patience });
    closes = now() + askWindow(ctx.state());
    await answer;
    const end = ctx.state();
    stoodThrough = !yes && !end.moving && stopBegan(end) < askedAt;
    return yes;
  }
  let stoodThrough = false;   // the last ask closed on a walker who stood since before it

  // A question with its second chance. A walker who stood still since before
  // she asked, at a red light or waiting for her "gå", has not answered: she
  // says so, waits for them to walk, and asks once more with `again`.
  async function question(id, word, again, againWord) {
    if (await ask(id, word, PATIENCE)) return true;
    if (!stoodThrough) return false;
    ctx.log(`${id}: the walker stood through it, she asks again`);
    await goLine('x-stod');
    await ctx.until(walking, { timeout: MIN });
    return ask(again, againWord);
  }
  // A line that asks the walker to go (the nine under "breakFrom" in
  // episod-1.json). It is not said to a walker already going, and once the
  // walker takes a step it ends at its next pause: after the sentence she is
  // in, never inside a word (Henric 23/10: "Att stanna upp om hon märker att
  // jag börjar gå är naturligt, men om ett ord blir avhugget ... så kommer det
  // inte att låta naturligt"). Past its last pause it is said to its end.
  function goLine(id) {
    const since = now();
    let over = false;
    let asked = false;
    const said = ctx.play(id, { unless: going });
    said.then(() => { over = true; });
    ctx.until(s => {
      if (!over && !asked && !standing(s, since)) asked = ctx.breakOff(id);
      return over || asked;
    });
    return said;
  }

  // She has seen the stop and says so at once with `go`: "Där! Ja." always,
  // the go itself only to a walker who still stands (goLine). A walker going
  // on by the time it is due hears her answer clear instead. Through the veil
  // the word is all that carries, so each go line ends on "gå", and a walker
  // still standing four seconds on hears it once more. Until v40 she waited
  // two seconds first (GO_ON), and with the band's three seconds that was
  // five from the stop to her voice on Henric's walk 23/10.
  async function goOn(go) {
    if (go) await goLine(go);
    if (await ctx.until(going, { timeout: 4 })) return;
    await goLine('x-ga-igen');
    await ctx.until(walking, { timeout: 10 });
  }

  // 0. Start. Not clear: the contact builds from low, so her first words come
  // as through a wall. It never decays in this episode; standing still dulls
  // her at once instead, and walking brings her straight back. Two questions,
  // each answered by a stop: does the walker see her, does the walker hear
  // her. Both stops are harmless: she walks her round.
  ctx.hold(true);
  await ctx.play('s0-1');
  await ctx.play('s0-2');
  ctx.log('scene 0: does the walker see her');
  let hears;
  if (await question('s0-ask1', 'ser', 's0-again1', 'ser')) {
    ctx.log('scene 0: yes, sees her');
    her.askedFor = true;
    await goOn('s0-go1');
    await ctx.play('s0-yes1-a');
    hears = await question('s0-yes1-b', 'hör', 's0-again2', 'hör');
  } else {
    ctx.log('scene 0: no');
    hears = await question('s0-no1', 'hör', 's0-again2', 'hör');
  }
  if (hears) {
    ctx.log('scene 0: yes, hears her');
    her.askedFor = true;
    await goOn('s0-go2');
    await ctx.play('s0-yes2');
  } else {
    ctx.log('scene 0: does not hear her');
    her.heardNo = true;
    await ctx.play('s0-no2');
  }
  remember(false);

  // The opening credits. Vega is silent while the song plays.
  ctx.log('credits');
  await ctx.credits();

  // 1. The loop. When the song is over and the contact is full.
  await ctx.until(s => full(s) && s.moving && s.movingFor >= 3, { timeout: SHORT_WAIT });
  ctx.log('scene 1');
  await ctx.play(ctx.state().band === 'run' ? 's1-run' : 's1-walk');
  await ctx.play('s1-2');
  await ctx.play('s1-self');
  if (await question('s1-q2', null, 's1-again', 'är')) {
    ctx.log('scene 1: yes, alone');
    her.askedFor = true;
    await goOn('s1-go');
    await ctx.play('s1-q2-yes');
  } else {
    ctx.log('scene 1: no, not alone');
    await ctx.play('s1-q2-no');
  }
  await ctx.play('s1-3');
  remember(false);

  // 2. The tree. What she does here needs the walker's steps, so a walker
  // who has stopped for a while is waited for longer than elsewhere.
  await opens(Math.max(AT.tree, now() + 20), LONG_WAIT);
  ctx.log('scene 2');
  await ctx.play('s2-1');

  // She stands still while the walker walks. From her last step to "trettio"
  // is half a minute on the clock: the last counting line starts so that the
  // word falls there, and the count under her breath ends where it begins.
  // A walker who stops while she counts is told to walk, and she says the
  // last numbers once they do. If the walker stands still through it the
  // snäcka does ask, and she starts over.
  for (;;) {
    const stoodAt = now();
    her.stillSince = stoodAt;
    ctx.log('scene 2: she stands still');
    if (await line('s2-2') === 'rest') continue;
    side.lift(true);
    const lastAt = stoodAt + HALF_MINUTE - ctx.cue('s2-3', 'trettio');
    let why = await hold(s => stopped(s) || s.t >= lastAt - ctx.seconds('s2-count') - COUNT_BREATH);
    if (why === 'rest') continue;
    if (!stopped(ctx.state())) {
      ctx.log('scene 2: she counts');
      why = await line('s2-count', undefined, stopped);
      if (why === 'rest') continue;
    }
    if (why !== 'done') {
      ctx.log('scene 2: the walker stops while she counts');
      if (await line('s2-count-stop', { go: true }) === 'rest') continue;
      // A phone that never sees the walker walk again does not keep her waiting.
      if (await hold(walking, { by: lastAt + SHORT_WAIT }) === 'rest') continue;
    }
    if (await hold(s => s.t >= lastAt) === 'rest') continue;
    ctx.log('scene 2: the last numbers');
    if (await line('s2-3') === 'rest') continue;
    break;
  }
  side.lift(false);
  await say('s2-4');

  // She steps off the gravel. From here a stop lights the lamp.
  her.stillSince = null;
  await pause(1.6);
  her.exposed = true;
  ctx.log('scene 2: off the gravel');

  // The lamp in scene 2, from the tone on. `askedAt`: when she asked for a
  // stop, if she did. The stop is her answer if it began after that.
  async function lampAtTheTree(askedAt = null) {
    const asked = askedAt !== null && lampStop >= askedAt;
    her.lampTree = true;
    ctx.log(`scene 2: lamp${asked ? ', she asked' : ''}`);
    side.pin(true);
    side.tone(true);             // she hears it and freezes
    await ctx.until(() => false, { timeout: 1.3 });
    await side.say('x-avvikelse', 'snacka');
    side.pin(false);
    if (!ctx.state().moving) {
      await goLine('s2-lamp-plea');
      // Ten seconds more and she asks again, closer.
      if (!await ctx.until(walking, { timeout: 10 }) && !ctx.state().moving) await goLine('s2-lamp-plea2');
    }
    await ctx.until(walking, { timeout: 1.5 * MIN });
    side.tone(false);
    her.exposed = false;
    her.stillSince = now();      // she does not move from the tree again
    // She asked for the stop and forgot that she was walking: hers, not the walker's.
    if (asked) await say('s2-lamp-mine');
    await say('s2-lamp-1');
    if (asked) {
      // [svarade nej i starten]: she had decided the walker cannot hear her.
      if (her.heardNo) await say('s2-lamp-2');
      her.askedFor = true;
    }
  }

  // What she does among the trees, one beat at a time, so a stop can come in
  // anywhere and the rest still gets said.
  // `again`: the beat a stop broke off is done once more after the lamp.
  let again = false;
  const said = async id => { const why = await line(id); again = heard < 0.5; return why; };
  const beats = [
    () => said('s2-5'),
    async () => {
      again = true;
      const why = await pause(0.8);
      if (why === 'lamp') return why;
      side.hand();
      again = false;
      const after = await pause(1.4);
      return after === 'lamp' ? after : 'ok';
    },
    () => said('s2-6'),
  ];
  let next = 0;
  for (; next < beats.length; next++) {
    const why = await beats[next]();
    if (why === 'rest') next--;                 // said again after the reserve
    else if (why === 'lamp') break;
  }
  if (next < beats.length) {
    // The walker stopped by themselves while she walked among the trees.
    const from = again ? next : next + 1;
    await lampAtTheTree();
    for (let i = from; i < beats.length; i++) {
      const why = await beats[i]();
      if (why === 'rest') i--;
    }
  } else {
    // No stop since she stepped off: she asks for one, walking round the tree.
    // A walker in the middle of a stop has decided already; it shows first.
    let askedAt = null;
    let why = ctx.state().moving ? 'ok' : await hold(s => s.moving, { timeout: 4 });
    if (why !== 'lamp') {
      ctx.log('scene 2: she asks');
      askedAt = now() + ctx.cue('s2-ask', 'stanna');
      why = await line('s2-ask');
    }
    if (why !== 'lamp') why = await pause(treeWindow(ctx.state()));
    if (why === 'lamp') {
      await lampAtTheTree(askedAt);
    } else {
      ctx.log('scene 2: no');
      why = await line('s2-no');
      if (why === 'lamp') await lampAtTheTree();
    }
  }
  remember(false);

  // 3. The sky. She sits down under the tree; a short stop is harmless again.
  // Until she does, she is still walking out there, and a stop still shows.
  if (await opens(Math.max(AT.sky, now() + 20)) === 'lamp') {
    await lampAtTheTree();
    await opens(now() + 10);
  }
  her.exposed = false;
  if (her.stillSince === null) her.stillSince = now();
  ctx.log(`scene 3: ${ctx.world.light}, ${ctx.world.rain ? 'rain' : 'dry'}, ${ctx.world.landmark}`);
  await say('s3-1');
  await pause(0.8);
  await say(ctx.world.light === 'dark' ? 's3-dark' : 's3-light');
  await pause(0.8);
  await say(ctx.world.rain ? 's3-rain' : 's3-dry');
  await pause(1);
  await say('s3-near');
  await pause(0.6);
  await say(`s3-${ctx.world.landmark}`);
  await pause(1.2);
  await say('s3-2');

  // 4. The bell. She is still under the tree and has to get onto the gravel
  // before the shift comes round the bend: a stop lights the lamp until she
  // is there. A stop, not a walker who has stood there all along: if the wait
  // ran out on one, she gets back unseen, and episode 2 is not told of a
  // suspicion the walker never caused.
  const into4 = await opens(Math.max(AT.bell, now() + 25), LONG_WAIT);
  ctx.log('scene 4');
  side.bell();
  await ctx.until(() => false, { timeout: 2.2 });
  await say('s4-1');
  her.stillSince = null;          // she gets up
  her.exposed = into4 !== 'late' || ctx.state().moving;
  if (!her.exposed) ctx.log('scene 4: the walker stands, no lamp');

  async function lampOnTheLoop() {
    her.lamp4 = true;
    ctx.log('scene 4: lamp');
    side.pin(true);
    side.tone(true);
    await ctx.until(() => false, { timeout: 1.2 });
    await side.say('x-avvikelse', 'snacka');
    side.pin(false);
    if (!ctx.state().moving) await goLine('s4-lamp-1');
    await ctx.until(walking, { timeout: 1.5 * MIN });
    side.tone(false);
    her.exposed = false;
    side.other('past', 8);
    await ctx.play('s4-lamp-2');
  }

  const getsUp = async () => {
    let why = await line('s4-2');
    if (why === 'lamp') return why;
    // She runs for the gravel. Far off, the shift.
    side.lift(true);
    side.other('distant', 8, { many: true });
    const safeAt = now() + 11;
    why = await pause(5);
    if (why === 'lamp') return why;
    why = await line('s4-3');
    if (why === 'lamp') return why;
    return hold(s => s.t >= safeAt);
  };
  if (await getsUp() === 'lamp') {
    await lampOnTheLoop();
  } else {
    // The walker walked all the way. She is on the gravel among the others,
    // and from here a stop gives nothing away.
    her.exposed = false;
    ctx.log('scene 4: on the gravel');
    side.other('past', 8);
    await ctx.play(her.lampTree ? 's4-ok-lamp' : 's4-ok');
  }
  side.lift(false);
  side.other(null);
  remember(false);

  // The end. She is on the gravel on her way in: a walker nearly back hears it
  // a little sooner, everyone else a little later, never a minute of hum.
  const end4 = now();
  await ctx.until(s => s.t >= end4 + END_SOON && (
    (s.distToStart !== null && s.approaching && s.distToStart < 300) ||
    s.t >= end4 + END_GAP));
  ctx.log('scene 4: the end');
  const last = ctx.state();
  // On the way back, or away from the start, each only when the distance shows it.
  // A walker who stands, or a phone without GPS, hears neither: she does not say where they go if she cannot see it.
  if (last.approaching && last.distToStart !== null) await ctx.play('s4-back');
  else if (last.distToStart !== null && last.moving && last.receding) await ctx.play('s4-onward');

  if (her.askedFor) {
    await ctx.play('s4-yes');
  } else {
    ctx.log('scene 4: she asks once more');
    if (await ask('s4-never-1')) {
      ctx.log('scene 4: yes');
      her.askedFor = true;
      await ctx.play('s4-never-yes-1');
      // A walker who is home stays standing. She goes on after half a minute.
      await ctx.until(walking, { timeout: HALF_MINUTE });
      await ctx.play('s4-never-yes-2');
    } else {
      ctx.log('scene 4: no');
      await ctx.play('s4-never-no');
    }
  }
  await ctx.play('s4-all');
  remember(false);

  // The walker's own stop ends it: her voice sinks away, her side comes
  // forward, and under the hum, for a second, something else. No words.
  // A walker who goes on hears her fade out instead, and the thing under the
  // hum waits for episode 2.
  const stoppedAtEnd = await ctx.until(s => !s.moving && s.stillFor >= 5, { timeout: 20 });
  if (stoppedAtEnd) {
    ctx.log('end');
    side.pin(true);
    await ctx.until(() => false, { timeout: 4 });
    side.breath();
    await ctx.until(() => false, { timeout: 2.5 });
  } else {
    ctx.log('end: the walker goes on');
  }
  remember(true);
  side.fade(5);
  await ctx.fadeOut(5);
}
