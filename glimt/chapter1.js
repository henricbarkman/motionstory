// Chapter 1 as straight-line code against the engine. Scene timing follows
// stories/glimt/kapitel-1.md: each scene fires on a condition, with a clock
// fallback so a walk with bad GPS still gets the whole chapter.
//
// ctx contract (see app.js and scripts/test_glimt.mjs):
//   play(lineId, {clear})  -> resolves when the line has finished
//   until(pred, {timeout}) -> true if pred held, false on timeout (seconds)
//   hold(bool)             pause contact decay during a hold scene
//   variant                'a' (bound to the walker) or 'b' (free)
//   world                  {light: 'light'|'dark', rain: bool, landmark: string}
//   log(msg)
//   fadeOut(seconds)       fade bed and voice to silence
//   playQuiet(lineId)      the other voice, faint, after the fade

const MIN = 60;

export async function runChapter1(ctx) {
  const v = (base, suffix = '') => `${base}${ctx.variant}${suffix ? '-' + suffix : ''}`;

  // 0. Start. Clear and held: she has just found the walker.
  ctx.hold(true);
  await ctx.play('s0', { clear: true });
  ctx.hold(false);

  // 1. Contact. Strong contact after roughly a minute of steady walking. A
  // walker whose phone never gets a good fix still hears it by 2.5 min.
  await ctx.until(s => s.contact >= 0.8 && s.t >= 0.75 * MIN, { timeout: 2.5 * MIN });
  ctx.log('scene 1');
  await ctx.play(v('s1'));

  // 2. Stillness. Either the walker stops on their own before minute three,
  // or she asks for it (a hold scene: her stopping is part of the story).
  // stillFor lags the real stop by a few seconds of speed smoothing, so seven
  // here is roughly ten seconds on the ground.
  const stopped = await ctx.until(s => s.stillFor >= 7, { timeout: 3 * MIN - ctx.state().t });
  if (stopped) {
    ctx.log('scene 2: walker stopped');
    await ctx.play(v('s2', 'stop-1'));
    if (ctx.variant === 'a') await ctx.play('s2a-stop-2');
    await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 2 * MIN });
    await ctx.play(v('s2', 'resume'));
  } else {
    ctx.log('scene 2: she asks');
    ctx.hold(true);
    await ctx.play(v('s2', 'ask-1'));
    const didStop = await ctx.until(s => s.stillFor >= 4, { timeout: 30 });
    if (didStop) {
      await ctx.until(s => s.moving && s.movingFor >= 3, { timeout: 2 * MIN });
      ctx.hold(false);
      await ctx.play(v('s2', 'ask-2'));
    } else {
      // She asked, the walker did not stop. She says nothing about it.
      ctx.hold(false);
      ctx.log('scene 2: walker did not stop');
    }
  }

  // 3. Glimpse. Light and weather chosen at start.
  await ctx.until(s => s.contact >= 0.7 && s.t >= 3.5 * MIN, { timeout: 1.5 * MIN });
  ctx.log(`scene 3: ${ctx.world.light}, ${ctx.world.rain ? 'rain' : 'dry'}`);
  await ctx.play('s3-1');
  await ctx.play(ctx.world.light === 'dark' ? 's3-dark' : 's3-light');
  await ctx.play('s3-2');
  await ctx.play(ctx.world.rain ? 's3-rain' : 's3-dry');

  // 4. Faster. She asks; the next 60 s decide which follow-up plays.
  await ctx.until(s => s.contact >= 0.5 && s.t >= 4.75 * MIN, { timeout: 1 * MIN });
  ctx.log('scene 4');
  await ctx.play(v('s4', '1'));
  const asked = ctx.state().t;
  const up = await ctx.until(s => s.lastIncreaseAt >= asked, { timeout: 60 });
  ctx.log(`scene 4: ${up ? 'tempo up' : 'no increase'}`);
  await ctx.play(v('s4', up ? 'up' : 'noup'));

  // 5. The crossing. No turn detection; she cannot know.
  await ctx.until(s => s.contact >= 0.6 && s.t >= 6.75 * MIN, { timeout: 1.25 * MIN });
  ctx.log('scene 5');
  await ctx.play('s5');

  // 6. The landmark, from map data when available, otherwise a guess.
  await ctx.until(s => s.contact >= 0.6 && s.t >= 8.25 * MIN, { timeout: 1 * MIN });
  ctx.log(`scene 6: ${ctx.world.landmark}`);
  await ctx.play(`s6-${ctx.world.landmark}`);

  // 7. Back. Distance to start shrinking, or the clock, or a long stop late.
  await ctx.until(s =>
    (s.distToStart !== null && s.distToStart < 300 && s.approaching) ||
    s.t >= 10 * MIN ||
    (s.t >= 9 * MIN && s.stillFor >= 30),
    { timeout: 2 * MIN });
  ctx.log('scene 7');
  await ctx.play(v('s7'));

  // The chapter ends on the walker's own stop. Contact fades naturally; the
  // bed follows, and then the other voice.
  await ctx.until(s => s.stillFor >= 8, { timeout: 3 * MIN });
  ctx.log('end: fading');
  await ctx.fadeOut(4);
  await ctx.until(() => false, { timeout: 3 });
  await ctx.playQuiet('s7-other');
  ctx.log('end');
}
