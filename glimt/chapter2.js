// Chapter 2, "Stanna för ja", as straight-line code against the engine.
// Manuscript: stories/glimt/kapitel-2.md. Same ctx contract as chapter 1
// (see chapter1.js), plus two state fields: distToTarget and
// approachingTarget, the landmark from the previous chapter when its
// position is known.
//
// The chapter's mechanic: the walker answers with the body. Vega asks, then
// a short stop within the window is yes and walking on is no. While a
// question is open the contact meter holds, so stopping to answer never
// costs her voice.

const MIN = 60;

// Plays a question and waits for the answer. Resolves true when the walker
// is still for a few seconds within `window` seconds of the line ending,
// false otherwise. A walker who already stands still when the question ends
// (they stopped to listen, or they arrived) counts as yes: standing there is
// the answer, whenever it began. Leaves the hold on for a yes so the caller
// can play the reply into the stop, then call release().
//
// The window is counted from the end of the line. A stop registers three to
// seven seconds after the feet stop (speed smoothing, then stillFor), so
// twenty seconds gives the walker about ten to react.
async function ask(ctx, lineId, { window = 20 } = {}) {
  ctx.hold(true);
  await ctx.play(lineId);
  const yes = await ctx.until(s => s.stillFor >= 3, { timeout: window });
  if (!yes) ctx.hold(false);
  return yes;
}

// After a yes: wait for the walker to move again, then let contact run.
async function release(ctx) {
  await ctx.until(s => s.moving && s.movingFor >= 2, { timeout: MIN });
  ctx.hold(false);
}

export async function runChapter2(ctx) {
  const lm = ctx.world.landmark;
  const hasMap = !!ctx.world.landmarkCoord;

  // 0. Start. She recognises the steps, or decides to.
  ctx.hold(true);
  await ctx.play('s0', { clear: true });
  ctx.hold(false);

  // 1. The code. First question: can you hear me? A no gets one retry.
  await ctx.until(s => s.contact >= 0.8 && s.t >= 0.75 * MIN, { by: 2.5 * MIN });
  ctx.log('scene 1');
  let heard = await ask(ctx, 's1-1');
  if (heard) {
    ctx.log('scene 1: yes');
    await ctx.play('s1-yes');
    await release(ctx);
  } else {
    ctx.log('scene 1: no, retry');
    heard = await ask(ctx, 's1-no');
    if (heard) {
      ctx.log('scene 1: yes on retry');
      await ctx.play('s1-yes');
      await release(ctx);
    } else {
      ctx.log('scene 1: no answer');
      await ctx.play('s1-give');
    }
  }

  // 2. The control question: something she already knows (the light).
  await ctx.until(s => s.contact >= 0.6 && s.t >= 3 * MIN, { by: 4 * MIN });
  ctx.log(`scene 2: ${ctx.world.light}`);
  const light = await ask(ctx, ctx.world.light === 'dark' ? 's2-dark' : 's2-light');
  ctx.log(`scene 2: ${light ? 'yes' : 'no'}`);
  await ctx.play(light ? 's2-yes' : 's2-no');
  if (light) await release(ctx);

  // 3. A question with no right answer.
  await ctx.until(s => s.contact >= 0.6 && s.t >= 4.5 * MIN, { by: 5.5 * MIN });
  ctx.log('scene 3');
  const alone = await ask(ctx, 's3-1');
  ctx.log(`scene 3: ${alone ? 'yes' : 'no'}`);
  await ctx.play(alone ? 's3-yes' : 's3-no');
  if (alone) await release(ctx);

  // 4. Go there. The landmark from chapter 1, or the walker's own choice.
  await ctx.until(s => s.contact >= 0.6 && s.t >= 6 * MIN, { by: 7 * MIN });
  ctx.log(`scene 4: ${hasMap ? lm : 'no map'}`);
  await ctx.play(hasMap ? `s4-${lm}` : 's4-nomap');

  // 5. On the way. The distance to the target shrinking, or the clock.
  await ctx.until(s => (s.approachingTarget && s.distToTarget !== null && s.distToTarget < 400) || s.t >= 7.5 * MIN,
    { timeout: 90 });
  ctx.log('scene 5');
  await ctx.play('s5');

  // 6. Arrived. Within 50 m of the landmark, or a stop after scene 5 when
  // there is no map, or the clock. Longer answer window: they are looking.
  await ctx.until(s =>
    (hasMap ? (s.distToTarget !== null && s.distToTarget < 50) : s.stillFor >= 8) ||
    s.t >= 9.5 * MIN,
    { by: 9.5 * MIN });
  ctx.log(`scene 6: ${hasMap ? lm : 'no map'}`);
  const key = hasMap ? lm : 'nomap';
  const there = await ask(ctx, `s6-${key}-q`, { window: 25 });
  ctx.log(`scene 6: ${there ? 'yes' : 'no'}`);
  await ctx.play(`s6-${key}-${there ? 'yes' : 'no'}`);
  if (there) await release(ctx);

  // 7. Run. Not a question. The next 60 s decide the follow-up.
  await ctx.until(s => s.contact >= 0.5 && s.moving && s.movingFor >= 10, { timeout: 45 });
  ctx.log('scene 7');
  await ctx.play('s7-1');
  const asked = ctx.state().t;
  const up = await ctx.until(s => s.lastIncreaseAt >= asked, { timeout: 60 });
  ctx.log(`scene 7: ${up ? 'tempo up' : 'no increase'}`);
  await ctx.play(up ? 's7-up' : 's7-noup');

  // 8. What she did not say. The cost, once, then not spoken of.
  await ctx.until(s => s.contact >= 0.5 && s.t >= 10 * MIN, { timeout: 75 });
  ctx.log('scene 8');
  await ctx.play('s8');

  // 9. Back. The last question; the walker's own final stop is the answer.
  await ctx.until(s =>
    (s.distToStart !== null && s.distToStart < 300 && s.approaching) ||
    s.t >= 12 * MIN ||
    (s.t >= 11 * MIN && s.stillFor >= 30),
    { by: 14 * MIN });
  ctx.log('scene 9');
  ctx.hold(true);
  await ctx.play('s9-1');
  const stopped = await ctx.until(s => s.stillFor >= 8, { timeout: 3 * MIN });
  ctx.log(`end: fading${stopped ? '' : ', walker never stopped'}`);
  await ctx.fadeOut(4);
  await ctx.until(() => false, { timeout: 2 });
  // She only hears a yes if there was one.
  if (stopped) {
    await ctx.playQuiet('s9-yes');
    await ctx.until(() => false, { timeout: 2 });
  }
  await ctx.playQuiet('s9-other');
  ctx.log('end');
}
