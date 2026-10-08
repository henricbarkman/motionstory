// Episode 1, "Det är när du går", as straight-line code against the engine.
// Manuscript: stories/glimt/episod-1.md. Its section "Logiken" is the rule
// book for this file:
//
//   - The walker walks: the snäcka in her ear reads the walker's steps, and
//     the Company sees a worker on her round whatever she does.
//   - The walker stands still: it reads her own steps. If she takes them
//     where she may not walk, the lamp lights.
//   - Both stand still: nothing to read. After half a minute the snäcka asks
//     what she is doing, she says she is resting, and the story goes on when
//     the walker walks.
//   - Her voice is always dull while the walker stands still, and her side is
//     heard instead. The app does that part (the veil in app.js); here it is
//     only pinned on while a line on her side must be heard to its end.
//
// So a stop is harmless while she walks her round (scene 2) or sits still
// (scene 4), and lights the lamp while she moves where she must not be:
// scene 3 from the moment she steps off the gravel, and scene 5 until the
// other woman has passed. `her.exposed` is that fact, and `lit` is the one
// place a stop is turned into the lamp.
//
// When she asks for a stop, her answer is a stop that begins after the word
// that asks. A walker who stood there already, at a kerb or a red light, has
// not said anything.
//
// ctx as in chapter1.js, plus:
//   side            her side of the line (herside.js): walk, other, hand,
//                   tone, bell, lift, pin, fade, and say(lineId, kind)
//   cut()           stops the voice line that is playing
//   seconds(id)     length of a line
//   cue(id, word)   seconds into a line where a word falls, measured from
//                   the rendered file
//   remember(facts) what episode 2 will want to know

const MIN = 60;
const ASK_WINDOW = 20;      // s she waits for a stop she asked for
const HALF_MINUTE = 30;     // s without steps before the snäcka asks
const RESERVE_MAX = 3;      // times it asks in one walk, then it lets her be
const SHORT_WAIT = 2.5 * MIN; // s a scene waits for a walker who is not walking
const LONG_WAIT = 10 * MIN;   // the same, when the feet say the walker stands

// A stop the walker means. The feet say it two seconds after the last step,
// so one second more is enough; GPS alone needs longer to be sure.
const stopped = s => !s.moving && s.stillFor >= (s.paceSource === 'steps' ? 1 : 3);
const walking = s => s.moving && s.movingFor >= 1.5;

export async function runEpisode1(ctx) {
  const side = ctx.side;
  const now = () => ctx.state().t;
  const her = {
    exposed: false,     // her own steps would give her away
    stillSince: null,   // since when she stands or sits still; null while she walks
    reserves: 0,        // times the snäcka has asked if she needs help
    askedFor: false,    // the walker has stopped when she asked for it
    lamp5: false,       // the lamp lit when the other woman came
  };
  const remember = klar => ctx.remember({ svarade: her.askedFor, misstanke: her.lamp5, klar });

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
  let heard = 1;
  async function line(id, opts) {
    let why = null;
    const began = now();
    const playing = ctx.play(id, opts).then(() => { if (!why) why = 'done'; });
    const watch = ctx.until(s => {
      if (why) return true;
      if (lit(s)) { why = 'lamp'; lampStop = stopBegan(s); }
      else if (resting(s)) why = 'rest';
      return !!why;
    });
    await Promise.race([playing, watch]);
    if (why === 'lamp' || why === 'rest') ctx.cut();
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
  // opens at the word that asks, not at the end of the line: a walker who
  // stops on the word and walks again before she has finished has answered.
  // It closes twenty seconds after the line. With `patience`, a walker who
  // stood there before she asked gets that long to walk again first.
  // The answer is a stop out of walking: someone waiting at a kerb who shifts
  // their weight makes the phone see a new stop, and that is not one.
  async function ask(id, patience = 0) {
    const askedAt = now() + ctx.cue(id, 'stanna');
    let walked = false;
    let yes = false;
    let closes = Infinity;
    const answer = ctx.until(s => {
      if (s.t >= askedAt - 2 && walking(s)) walked = true;
      if (walked && stopped(s) && stopBegan(s) >= askedAt) yes = true;
      return yes || s.t >= closes;
    });
    await ctx.play(id);
    const s = ctx.state();
    if (!yes && patience && !s.moving && stopBegan(s) < askedAt) await ctx.until(s => yes || walking(s), { timeout: patience });
    closes = now() + ASK_WINDOW;
    await answer;
    return yes;
  }

  // 0. Start. Not clear: the contact builds from low, so her first words come
  // as through a wall. It never decays in this episode; standing still dulls
  // her at once instead, and walking brings her straight back.
  ctx.hold(true);
  side.walk('grus', { rate: 104 });
  await ctx.play('s0');

  // 1. The loop.
  await ctx.until(s => s.contact >= 0.8 && s.t >= 0.75 * MIN, { by: 2.5 * MIN });
  ctx.log('scene 1');
  await ctx.play(ctx.state().band === 'run' ? 's1-run' : 's1-walk');
  await ctx.play('s1-2');

  // 2. The question. She walks her round, so the stop costs nothing.
  await opens(2.5 * MIN);
  ctx.log('scene 2');
  if (await ask('s2-1', MIN)) {
    ctx.log('scene 2: yes');
    her.askedFor = true;
    await ctx.play('s2-yes-1');
    await ctx.until(walking, { timeout: MIN });
    await ctx.play('s2-yes-2');
  } else {
    ctx.log('scene 2: no');
    await ctx.play('s2-no');
  }
  remember(false);

  // 3. The tree. What she does here needs the walker's steps, so a walker
  // who has stopped for a while is waited for longer than elsewhere.
  await opens(Math.max(4 * MIN, now() + 20), LONG_WAIT);
  ctx.log('scene 3');
  await ctx.play('s3-1');

  // She stands still while the walker walks. From her last step to "trettio"
  // is half a minute on the clock: the counting line starts so that the word
  // falls there. If the walker stands still through it the snäcka does ask,
  // and she starts over.
  for (;;) {
    side.walk(null);
    const stoodAt = now();
    her.stillSince = stoodAt;
    ctx.log('scene 3: she stands still');
    if (await line('s3-2') === 'rest') continue;
    side.lift(true);
    if (await hold(s => s.t >= stoodAt + HALF_MINUTE - ctx.cue('s3-3', 'trettio')) === 'rest') continue;
    ctx.log('scene 3: she counts');
    if (await line('s3-3') === 'rest') continue;
    break;
  }
  side.lift(false);
  await say('s3-4');

  // She steps off the gravel. From here a stop lights the lamp.
  her.stillSince = null;
  side.walk('grus', { rate: 92 });
  await pause(1.6);
  side.walk('mjukt', { rate: 78 });
  her.exposed = true;
  ctx.log('scene 3: off the gravel');

  // The lamp in scene 3, from the tone on. `askedAt`: when she asked for a
  // stop, if she did. The stop is her answer if it began after that.
  async function lampAtTheTree(askedAt = null) {
    const asked = askedAt !== null && lampStop >= askedAt;
    ctx.log(`scene 3: lamp${asked ? ', she asked' : ''}`);
    side.pin(true);
    side.tone(true);
    side.walk(null);             // she hears it and freezes
    await ctx.until(() => false, { timeout: 1.3 });
    await side.say('x-avvikelse', 'snacka');
    side.pin(false);
    if (!ctx.state().moving) await ctx.play('s3-lamp-plea');
    await ctx.until(walking, { timeout: 1.5 * MIN });
    side.tone(false);
    her.exposed = false;
    her.stillSince = now();      // she does not move from the tree again
    await say('s3-lamp-1');
    if (asked) {
      if (!her.askedFor) await say('s3-lamp-2');
      her.askedFor = true;
    }
  }

  // What she does among the trees, one beat at a time, so a stop can come in
  // anywhere and the rest still gets said.
  // `again`: the beat a stop broke off is done once more after the lamp.
  let again = false;
  const said = async id => { const why = await line(id); again = heard < 0.5; return why; };
  const beats = [
    () => said('s3-5'),
    async () => {
      again = true;
      side.walk(null);
      const why = await pause(0.8);
      if (why === 'lamp') return why;
      side.hand();
      again = false;
      const after = await pause(1.4);
      // Her hand stays on the trunk and she walks slowly round it. After the
      // lamp she does not: she stands where she stood.
      if (her.exposed && after !== 'lamp') side.walk('mjukt', { rate: 62 });
      return after === 'lamp' ? after : 'ok';
    },
    () => said('s3-6'),
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
      ctx.log('scene 3: she asks');
      askedAt = now() + ctx.cue('s3-ask', 'stanna');
      why = await line('s3-ask');
    }
    if (why !== 'lamp') why = await pause(ASK_WINDOW);
    if (why === 'lamp') {
      await lampAtTheTree(askedAt);
    } else {
      ctx.log('scene 3: no');
      why = await line('s3-no');
      if (why === 'lamp') await lampAtTheTree();
    }
  }
  remember(false);

  // 4. The sky. She sits down under the tree; a short stop is harmless again.
  // Until she does, she is still walking out there, and a stop still shows.
  if (await opens(Math.max(6 * MIN, now() + 20)) === 'lamp') {
    await lampAtTheTree();
    await opens(now() + 10);
  }
  side.walk(null);
  her.exposed = false;
  if (her.stillSince === null) her.stillSince = now();
  ctx.log(`scene 4: ${ctx.world.light}, ${ctx.world.rain ? 'rain' : 'dry'}, ${ctx.world.landmark}`);
  await say('s4-1');
  await pause(0.8);
  await say(ctx.world.light === 'dark' ? 's4-dark' : 's4-light');
  await pause(0.8);
  await say(ctx.world.rain ? 's4-rain' : 's4-dry');
  await pause(1);
  await say(`s4-${ctx.world.landmark}`);

  // 5. Someone is coming. She is still off the gravel and has to get back
  // before she is seen: a stop lights the lamp. A stop, not a walker who has
  // stood there all along: if the wait ran out on one, she gets back unseen,
  // and episode 2 is not told of a suspicion the walker never caused.
  const into5 = await opens(Math.max(8 * MIN, now() + 25), LONG_WAIT);
  ctx.log('scene 5');
  her.stillSince = null;
  her.exposed = into5 !== 'late' || ctx.state().moving;
  if (!her.exposed) ctx.log('scene 5: the walker stands, no lamp');
  side.walk('mjukt', { rate: 66, level: 0.8 });

  async function lampOnTheLoop() {
    her.lamp5 = true;
    ctx.log('scene 5: lamp');
    side.pin(true);
    side.tone(true);
    side.walk(null);
    side.other('near', 2.5);
    await ctx.until(() => false, { timeout: 1.2 });
    await side.say('x-avvikelse', 'snacka');
    side.other('stop');
    await ctx.until(() => false, { timeout: 0.7 });
    await side.say('s5-hon-fraga', 'nara');
    await ctx.play('s5-lamp-sten');
    side.pin(false);
    await ctx.until(walking, { timeout: 1.5 * MIN });
    side.tone(false);
    her.exposed = false;
    side.other('go');
    side.other('past', 6);
    side.walk('grus', { rate: 104 });
    await ctx.play('s5-lamp-after');
    side.other(null);
  }

  const approach = async () => {
    let why = await line('s5-1');
    if (why === 'lamp') return why;
    // Her steps, fast, soft ground and then gravel. The others come closer.
    side.lift(true);
    side.walk('mjukt', { rate: 150 });
    side.other('near', 11);
    const nearAt = now() + 11;
    why = await pause(3.5);
    if (why === 'lamp') return why;
    side.walk('grus', { rate: 128 });
    why = await pause(1.5);
    if (why === 'lamp') return why;
    why = await line('s5-2');
    if (why === 'lamp') return why;
    return hold(s => s.t >= nearAt);
  };
  if (await approach() === 'lamp') {
    await lampOnTheLoop();
  } else {
    // The walker walked all the way. She is on the gravel when the other
    // woman reaches her, and from here a stop gives nothing away.
    her.exposed = false;
    const pace = ctx.state().band === 'run' ? 'run' : 'walk';
    ctx.log(`scene 5: passed, ${pace}`);
    side.walk('grus', { rate: 104 });
    await ctx.play(`s5-hon-${pace}`);
    side.other('past', 7);
    await ctx.until(() => false, { timeout: 7 });
    side.other(null);
    await ctx.play(`s5-ok-${pace}`);
  }
  side.lift(false);
  remember(false);

  // 6. The bell. The walker is nearly back, or the clock says so, or they
  // have stopped for good. She is on the gravel on her way in.
  const end5 = now();
  await ctx.until(s => s.t >= end5 + 15 && (
    (s.distToStart !== null && s.approaching && s.distToStart < 300) ||
    s.t >= Math.max(10.5 * MIN, end5 + 40) ||
    (s.t >= 10 * MIN && s.stillFor > 30)));
  ctx.log('scene 6');
  side.bell();
  await ctx.until(() => false, { timeout: 2.2 });
  await ctx.play('s6-1');
  const s6 = ctx.state();
  if (s6.approaching && s6.distToStart !== null) await ctx.play('s6-back');

  if (her.askedFor) {
    await ctx.play('s6-yes');
  } else {
    ctx.log('scene 6: she asks once more');
    if (await ask('s6-never-1')) {
      ctx.log('scene 6: yes');
      her.askedFor = true;
      await ctx.play('s6-never-yes-1');
      // A walker who is home stays standing. She goes on after half a minute.
      await ctx.until(walking, { timeout: HALF_MINUTE });
      await ctx.play('s6-never-yes-2');
    } else {
      ctx.log('scene 6: no');
      await ctx.play('s6-never-no');
    }
  }
  await ctx.play('s6-all');
  remember(false);

  // The end comes on the walker's own stop: her voice sinks away, her side
  // comes forward, and then someone else is there.
  await ctx.until(s => !s.moving && s.stillFor >= 5, { timeout: 4 * MIN });
  ctx.log('end');
  side.walk(null);
  side.pin(true);
  await ctx.until(() => false, { timeout: 4 });
  await side.say('s6-other', 'annan');
  await ctx.until(() => false, { timeout: 1.5 });
  remember(true);
  side.fade(5);
  await ctx.fadeOut(5);
}
