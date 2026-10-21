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
//   credits()       plays the opening credits, resolves when the song is over
//   seconds(id)     length of a line
//   cue(id, word)   seconds into a line where a word falls, measured from
//                   the rendered file ("last:nu" is the line's last "nu")
//   remember(facts) what episode 2 will want to know

const MIN = 60;
// s she waits for a stop she asked for, after the line: ten when the feet
// decide (Henric 2026-10-08), twenty on GPS, which reads a stop late.
const askWindow = s => s.paceSource === 'steps' ? 10 : 20;
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
const walking = s => s.moving && s.movingFor >= 1.5;
// A stop too short for the band. The feet call a walker still two seconds
// after the last step and sure() wants one more, so a walker who stopped for
// two seconds when she asked, and walked on, was a no (Henric's walk 21/10).
// A gap this long between a walk's last step and the next is a stop all the
// same. Outside a real stop the gaps in the recorded pockets (28/9 to 12/10)
// reached 2.2 s at most.
const GAP_YES = 2.3;

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
  let heard = 1;
  async function line(id, opts, stop = null) {
    let why = null;
    const began = now();
    const playing = ctx.play(id, opts).then(() => { if (!why) why = 'done'; });
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
  // A stop shorter than the band sees counts too, on the feet: the gap
  // between the walk's last step and the next (GAP_YES). It starts at that
  // last step, which the feet know to the sample, so it needs no `seenLate`.
  async function ask(id, word = 'stanna', patience = 0) {
    const askedAt = now() + (word ? ctx.cue(id, word) : 0);
    let walked = false;
    let yes = false;
    let closes = Infinity;
    let walkStep = null;        // the newest step of a walk, from when she asks
    const answer = ctx.until(s => {
      if (s.t >= askedAt - 2 && walking(s)) { walked = true; walkStep = s.lastStepAt; }
      else if (walkStep !== null && s.paceSource === 'steps' && s.lastStepAt - walkStep >= GAP_YES &&
        walkStep >= askedAt && walkStep < closes) yes = true;
      const began = stopBegan(s);
      if (walked && stopped(s) && began >= askedAt && began < closes + seenLate(s)) yes = true;
      return yes || s.t >= closes + seenLate(s) + sure(s);
    });
    await ctx.play(id);
    const s = ctx.state();
    if (!yes && patience && !s.moving && stopBegan(s) < askedAt) await ctx.until(s => yes || walking(s), { timeout: patience });
    closes = now() + askWindow(ctx.state());
    await answer;
    return yes;
  }
  // She has seen the stop. A walker who walks on at once hears her answer
  // clear. One who stands, as scene 0 asks ("stå kvar tills jag säger till"),
  // hears her say so with `go`, and her answer once they walk. The lab's
  // Stanna för ja did the same and was walked right (8/10): standing until
  // she said "Gå igen" gave the phone the seconds it needs to see a stop.
  async function goOn(go) {
    if (await ctx.until(walking, { timeout: 1.5 })) return;
    if (go) await ctx.play(go);
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
  if (await ask('s0-ask1', 'last:nu', PATIENCE)) {
    ctx.log('scene 0: yes, sees her');
    her.askedFor = true;
    await goOn('s0-go1');
    await ctx.play('s0-yes1-a');
    hears = await ask('s0-yes1-b', 'last:nu', PATIENCE);
  } else {
    ctx.log('scene 0: no');
    hears = await ask('s0-no1', 'last:nu', PATIENCE);
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
  if (await ask('s1-q2', null, PATIENCE)) {
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
      if (await line('s2-count-stop') === 'rest') continue;
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
      await ctx.play('s2-lamp-plea');
      // Ten seconds more and she asks again, closer.
      if (!await ctx.until(walking, { timeout: 10 }) && !ctx.state().moving) await ctx.play('s2-lamp-plea2');
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
    if (why !== 'lamp') why = await pause(askWindow(ctx.state()));
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
    if (!ctx.state().moving) await ctx.play('s4-lamp-1');
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
