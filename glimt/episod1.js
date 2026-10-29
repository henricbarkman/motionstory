// Episode 1, "Det är när du går", as straight-line code against the engine.
// Manuscript: stories/glimt/episod-1.md. Its section "Logiken" is the rule
// book for this file. The English episode, "Keep Going" (episode-1.md), runs
// the same code with EN below: its answer words, its scenes following each
// other, its breaths, its asides and The Code under her last words. With no
// second argument it is the Swedish episode exactly as version 40 ran it.
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
const COUNT_BREATH = 0.8;   // s between the count under her breath and its last numbers (Swedish)
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

// What differs between the two languages. `words`: the word in a line from
// which a stop is the answer (the files' cueWords). `at`, `after`: a scene
// opens at `at` at the earliest, and at least `after` seconds after the scene
// before it ended. `end`: END_SOON and END_GAP. `gaps`: seconds of silence
// before a line (before the name, `name`, and before she goes on among the
// trees after the lamp, `lamp-tree`), where clips played back to back left
// her no breath; scene 3's lines have SCENE3 when it names none.
// `asides`: her lines to herself that only the English has. `songUnder`: The Code starts faint under her last line before
// the credits and grows when she has finished (the cue word in the line, or
// its start). `now`: the line she says after each question she asks for a
// stop, where the window opens instead (`words.now` in it); none in Swedish.
// The pauses between her lines in scene 3, under the tree: before her light,
// her weather, "near you", the landmark and the last line. About a second was
// right on Henric's walk of 23/10.
const SCENE3 = [0.8, 0.8, 1, 0.6, 1.2];
// `countBreath`: seconds of silence between the count under her breath and
// its last numbers. `gaps['off-gravel']`: the pause as she steps off the
// gravel, before she is exposed (1.6 s without one).

export const SV = {
  words: { see: 'ser', hear: 'hör', are: 'är', thirty: 'trettio', stop: 'stanna', lastStop: 'stanna' },
  now: null,
  countBreath: COUNT_BREATH,
  at: AT,
  after: { tree: 20, sky: 20, bell: 25 },
  end: { soon: END_SOON, gap: END_GAP },
  gaps: {},
  asides: {},
  songUnder: null,
};
// Henric's walk of 23/10 measured the pauses (episode-1.md, "Pauses,
// measured 23/10"): the scenes waited for fixed minutes, 47, 20 and 53 s of
// silence, and clips came with no breath. The takes have about a tenth of a
// second of silence at each end, so a gap is the silence heard.
// She promises "I will ask you a question and then say now" in her first
// question (Henric's rewrite of 28/10), so in English each question she asks
// for a stop is followed by "Now." (x-now, one take for all seven, Henric
// 29/10: "hon ska säga 'now' eftersom hon säger att hon ska säga 'now'").
//
// More air (v48, Henric 29/10 after listening to v47: "Allt är lite för
// rushed bara"). Measured in a listen of v47 (the sim's `listen` walker, the
// takes' own silent edges added, about 0.1 s before and 0.26 s after her
// words): eight places where one line ran into the next with 0.5-0.9 s of
// silence heard, the breaths of 23/10 at 1.2-2.6 s, scene 1 into scene 2 at
// 2.3 s, and the pauses between her sentences inside a take 0.5-0.6 s. So:
// those eight get 0.8 s (1.2 and 1.5 where a thought turns), every breath and
// scene 3's pauses half as long again, scene 2 opens 4 s after scene 1 and
// scene 3 8 s after scene 2. The bell (12 s, from 10) and the end (8 and 12,
// from 6 and 10) had the most already. Not touched: her Now after a question
// (x-now: the answer is read from it), the count, the lamp, scene 4's run
// for the gravel, and her answer to a stop (the go lines), which must come
// at once. `?luft=` scales all the rest (withAir).
//
// A little more again where the story turns (v49, Henric 29/10 after v48:
// "Fundera själv på var det kan passa med ett snäpp längre pauser ...
// mellan olika sektioner ... när hon börjar prata för sig själv"). Around
// her lines to herself (asides): before "What? That can't be right" 1.5 s
// (0.8), after it 2 (1.5); before the whispered "You hear me." 1.5 (0.8);
// after "Ask something real this time" 2 (1.5; before it 2.25 already);
// before "Three metres" 1.5 (0.8) and the step off the gravel after it 2.2
// (1.6); before "Up. Up, up." 0.8 (none), while she still sits, so the stop
// that lights the lamp is no likelier. Between the scenes: 2.5 s after the
// credits' song before scene 1 (none), scene 2 6 s after scene 1 (4), and
// 2.5 s once she has sat down under the tree before scene 3's first line
// (none; the 8 s before it are her walk back, exposed, and stay). The bell
// (12 s) and the end keep theirs.
//
// The count (v49, Henric 29/10: "räknar för fort ... I slutet saktar hon
// ner jättemycket, men i början ... en halv sekund kanske"): v48's takes went
// 0.56 s a number from twelve to twenty-six and 1.5 s from twenty-seven to
// thirty. The numbers are now laid a second apart in the files (1.2 s after
// thirty, her [short pause]), the last of the count a second before the
// first of the last numbers with no silence between the files.
export const EN = {
  words: { see: 'see', hear: 'hear', are: 'are', thirty: 'thirty', stop: 'stop', lastStop: 'last:stop', now: 'now' },
  now: 'x-now',
  countBreath: 0,
  at: { tree: 0, sky: 0, bell: 0 },
  after: { tree: 6, sky: 8, bell: 12 },
  end: { soon: 8, gap: 12 },
  // x-now: with the question's own tail and the take's lead, about a second
  // of silence between the question and her now. s1-walk: after the credits,
  // the same before s1-run.
  gaps: {
    's0-2': 3, 's0-ask1': 2.25, 's0-yes1-a': 1.5, 's0-yes1-b': 2, 's0-yes2': 0.8, 's0-yes2-aside': 1.5,
    's1-walk': 2.5, 's1-2': 0.8, 's1-self': 2.25, 's1-q2': 2, 's1-q2-yes': 0.8, 's1-3': 1.2,
    's2-2': 3, 's2-4': 1.5, 's2-self': 1.5, 'off-gravel': 2.2, 's2-ask': 1.5, 's2-lamp-1': 0.8, 's2-lamp-2': 0.8, 'lamp-tree': 0.8,
    's3-1': 2.5, 's3-dark': 1.2, 's3-light': 1.2, 's3-rain': 1.2, 's3-dry': 1.2, 's3-near': 1.5,
    's3-bro': 0.9, 's3-vatten': 0.9, 's3-skog': 0.9, 's3-berg': 0.9, 's3-kyrkogard': 0.9, 's3-2': 1.8,
    's4-self': 0.8, 'x-now': 0.4, name: 2.25, 's4-all': 3,
  },
  asides: { yes2: 's0-yes2-aside', gravel: 's2-self', up: 's4-self' },
  songUnder: { yes: ['s0-yes2-aside', null], no: ['s0-no2', 'talk'] },
};

// The episode's pauses at `luft` times their length: the breaths before her
// lines, when the scenes open after each other, and how long the end waits.
// Her breath before her Now (E.now) keeps its length, for the answer is read
// from the word: a walker who stopped on the question's last word and stood
// is a yes because the band sees the stop after it.
export function withAir(E, luft = 1) {
  if (luft === 1) return E;
  const times = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === E.now ? v : v * luft]));
  return { ...E, luft, gaps: times(E.gaps), after: times(E.after), end: times(E.end) };
}

// ?luft= as a link writes it: a factor from 0 to 3, a decimal comma read as
// a point (as readKlarhet). Null when there is nothing to read.
export const LUFT_MAX = 3;
export function readLuft(raw) {
  const t = raw == null ? '' : String(raw).trim().replace(',', '.');
  if (!t) return null;
  const f = Number(t);
  return Number.isFinite(f) ? Math.min(LUFT_MAX, Math.max(0, f)) : null;
}

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
const SENSOR_SETTLE = 1;    // s after the sensor is back before the band's still is a stop
const feetStill = s => s.paceSource === 'steps' && s.t - s.lastStepAt >= FEET_STOP
  && s.t - s.sensorAt < SENSOR_FRESH && !(s.sensorResetAt > s.lastStepAt);
// A stop the band reports, and not the band starting over: after a page
// hidden a moment the sensor comes back, the band begins again and calls the
// walker still until three steps have come. On the feet a stillness that
// began within SENSOR_SETTLE of that is no stop. v39 heard a yes from it in
// ask(), and the lamp lit for a walker who never stopped (in 11 of 12 short
// gaps in her exposed stretches; the feasibility review of v40, 24/10).
const heldStop = s => stopped(s)
  && !(s.paceSource === 'steps' && s.t - s.stillFor - s.sensorResetAt < SENSOR_SETTLE);
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
// Still standing, as a line that asks the walker to go needs: on the feet, not
// two steps since `since` under STRIDE apart; off them, not going. Two steps
// are enough to stop asking: "Där! Ja." is said, "Gå nu, gå." only to someone
// who still stands (v40). One was too few: a phone handled while the walker
// stands bumps about once a second, and every bump ended her go line, so the
// walker waiting for "gå" never heard it. Two cost one step more and pass a
// single bump and the random ones. They do not pass handling as measured on
// 23/10 (single gaps of 0.38-0.68 s): a walker who stands and turns the phone
// over while she says gå hears "Där! Ja." and no "gå" (walker `handled-go`),
// and no "Gå." four seconds on either, for the band reads that handling as a
// gait (walker `handled`). Three steps, or v39's `going`, would say the line
// whole to that walker, but three come about a second after the first, and
// the pauses in "Där försvann du." and "Där. Okej." are gone by then: a walker
// who walks off there, as Henric did on 23/10, would hear "gå" to its end
// (walker `walks-on`). He did not handle the phone at her questions that day.
const standing = (s, since) => s.paceSource === 'steps'
  ? !(s.prevStepAt > since && s.lastStepAt - s.prevStepAt < STRIDE) : !going(s);

export async function runEpisode1(ctx, E = SV) {
  const W = E.words;
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
  const lit = s => her.exposed && heldStop(s);
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
  // The breath before line `id`, where the episode has one (E.gaps), else
  // `seconds`. While she is exposed a stop lights the lamp, so there a link
  // with more air than the standard (?luft= over 1) gives the standard's
  // breath: a longer pause never makes the lamp likelier (review of v48).
  const breath = (id, seconds = 0) => {
    let s = E.gaps[id] ?? seconds;
    if (her.exposed && E.luft > 1) s /= E.luft;
    return s ? pause(s) : Promise.resolve('ok');
  };

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
  // finished has answered. It closes five seconds after the line on the feet
  // (askWindow: ten until v40, Henric 8/10; then 23/10, it took too long), and
  // twenty on GPS. With `patience`, a walker who stood there before she asked gets
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
  // With `then` (E.now: in English) she says that line after the question,
  // after its breath, and the window opens at its word instead: she has
  // promised to say now, and until v46 she never did, so a walker who waited
  // for it walked on through the window and was heard as a no (Henric 29/10).
  // The window is shut while she asks (askedAt Infinity), so a stop on the
  // question's words is read against her now, as one before the word was
  // read against the word: a stop the feet ended before it is no answer, and
  // one who stood from early in the question hears x-stod and the question
  // again. The band sees a stop about two seconds after the last step, and
  // counts it from then, so a walker who stopped on the question's last word
  // and stays standing is a yes, as before v46.
  async function ask(id, word = W.lastStop, patience = 0, then = null) {
    let askedAt = then ? Infinity : now() + (word ? ctx.cue(id, word) : 0);
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
      // Nor is the band starting over as the sensor comes back (heldStop).
      const began = stopBegan(s);
      if (walked && heldStop(s) && began >= askedAt && began < closes + seenLate(s)) yes = true;
      const walksOn = walking(s) && (s.paceSource === 'steps' ? s.lastStepAt >= closes && quickSteps(s) : s.t >= closes + seenLate(s));
      return yes || (s.t >= closes && walksOn) || s.t >= closes + seenLate(s) + sure(s);
    });
    await ctx.play(id);
    if (then) {
      await breath(then);
      askedAt = now() + ctx.cue(then, W.now);
      await ctx.play(then);
    }
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
  // says so, waits for them to walk, and asks once more with `again`. In
  // English both are followed by her now (E.now).
  async function question(id, word, again, againWord) {
    if (await ask(id, word, PATIENCE, E.now)) return true;
    if (!stoodThrough) return false;
    ctx.log(`${id}: the walker stood through it, she asks again`);
    await goLine('x-stod');
    await ctx.until(walking, { timeout: MIN });
    return ask(again, againWord, 0, E.now);
  }
  // A line that asks the walker to go (the nine under "breakFrom" in
  // episod-1.json). It is not said to a walker already going, and once the
  // walker takes two steps it ends at its next pause: after the sentence she is
  // in, never inside a word (Henric 23/10: "Att stanna upp om hon märker att
  // jag börjar gå är naturligt, men om ett ord blir avhugget ... så kommer det
  // inte att låta naturligt"). Past its last pause it is said to its end.
  function goLine(id) {
    const since = now();
    let over = false;
    let asked = false;
    const said = ctx.play(id, { unless: going });
    said.then(() => { over = true; }, () => { over = true; });
    ctx.until(s => {
      if (!over && !asked && !standing(s, since)) asked = ctx.breakOff(id);
      return over || asked;
    });
    return said;
  }

  // She has seen the stop and says so at once with `go`, and the go itself
  // only to a walker who still stands (goLine): "Där! Ja." and then silence
  // for one who walks off mid-line, nothing for one already going, who hears
  // her answer clear instead. Through the veil
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
  await breath('s0-2');
  await ctx.play('s0-2');
  await breath('s0-ask1');
  ctx.log('scene 0: does the walker see her');
  let hears;
  if (await question('s0-ask1', W.see, 's0-again1', W.see)) {
    ctx.log('scene 0: yes, sees her');
    her.askedFor = true;
    await goOn('s0-go1');
    await breath('s0-yes1-a');
    await ctx.play('s0-yes1-a');
    await breath('s0-yes1-b');
    hears = await question('s0-yes1-b', W.hear, 's0-again2', W.hear);
  } else {
    ctx.log('scene 0: no');
    hears = await question('s0-no1', W.hear, 's0-again2', W.hear);
  }
  // The opening credits. Vega is silent while the song plays. In English it
  // starts faint under her last line and grows once she has finished (Henric
  // 23/10); "You hear me." comes as it enters, so it stays faint till then.
  let song = null;
  const under = E.songUnder && E.songUnder[hears ? 'yes' : 'no'];
  if (hears) {
    ctx.log('scene 0: yes, hears her');
    her.askedFor = true;
    await goOn('s0-go2');
    await breath('s0-yes2');
    await ctx.play('s0-yes2');
    if (under) { ctx.log('credits, under her last words'); song = ctx.credits({ under: under[0], word: under[1] }); }
    if (E.asides.yes2) { await breath(E.asides.yes2); await ctx.play(E.asides.yes2); }
  } else {
    ctx.log('scene 0: does not hear her');
    her.heardNo = true;
    if (under) { ctx.log('credits, under her last words'); song = ctx.credits({ under: under[0], word: under[1] }); }
    await ctx.play('s0-no2');
  }
  remember(false);

  if (!song) ctx.log('credits');
  await (song || ctx.credits());

  // 1. The loop. When the song is over and the contact is full. In English a
  // breath after the song first (E.gaps, under s1-walk).
  await breath('s1-walk');
  await ctx.until(s => full(s) && s.moving && s.movingFor >= 3, { timeout: SHORT_WAIT });
  ctx.log('scene 1');
  await ctx.play(ctx.state().band === 'run' ? 's1-run' : 's1-walk');
  await breath('s1-2');
  await ctx.play('s1-2');
  await breath('s1-self');
  await ctx.play('s1-self');
  await breath('s1-q2');
  if (await question('s1-q2', null, 's1-again', W.are)) {
    ctx.log('scene 1: yes, alone');
    her.askedFor = true;
    await goOn('s1-go');
    await breath('s1-q2-yes');
    await ctx.play('s1-q2-yes');
  } else {
    ctx.log('scene 1: no, not alone');
    await ctx.play('s1-q2-no');
  }
  await breath('s1-3');
  await ctx.play('s1-3');
  remember(false);

  // 2. The tree. What she does here needs the walker's steps, so a walker
  // who has stopped for a while is waited for longer than elsewhere.
  await opens(Math.max(E.at.tree, now() + E.after.tree), LONG_WAIT);
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
    // She stops: in English the silence is the stop (E.gaps), as long as
    // the half minute has room for it with her count whole and a second to
    // spare for the lines to start. In English (v49) that is 3.7 s, so the
    // 3 s stop is whole, and "twelve" falls about 12 s after her last step
    // (until v49 at 15.5, and thirty at 30 only for her slowing down).
    const room = HALF_MINUTE - ctx.cue('s2-3', W.thirty) - ctx.seconds('s2-count') - E.countBreath - ctx.seconds('s2-2') - 1;
    if (E.gaps['s2-2'] && await pause(Math.min(E.gaps['s2-2'], Math.max(0, room))) === 'rest') continue;
    if (await line('s2-2') === 'rest') continue;
    side.lift(true);
    const lastAt = stoodAt + HALF_MINUTE - ctx.cue('s2-3', W.thirty);
    // heldStop: a page hidden a moment while the walker walks is no stop.
    let why = await hold(s => heldStop(s) || s.t >= lastAt - ctx.seconds('s2-count') - E.countBreath);
    if (why === 'rest') continue;
    let countFrom = null;
    if (!heldStop(ctx.state())) {
      ctx.log('scene 2: she counts');
      countFrom = now();
      why = await line('s2-count', undefined, heldStop);
      if (why === 'rest') continue;
    }
    if (why !== 'done') {
      ctx.log('scene 2: the walker stops while she counts');
      if (await line('s2-count-stop', { go: true }) === 'rest') continue;
      // A phone that never sees the walker walk again does not keep her waiting.
      if (await hold(walking, { by: lastAt + SHORT_WAIT }) === 'rest') continue;
    }
    // A count heard to its end at the last numbers' time goes straight on to
    // them: a wait ends at the app's next tick, up to a quarter second late,
    // and in English the count ends right there (countBreath 0), a second
    // from twenty-six to twenty-seven. It began no earlier than it was due
    // (the tick that saw it due, `countFrom`), so it ends no earlier than
    // countBreath before lastAt: in English, never early. Read from that and
    // not from now(), which is the last tick's time, not the clock's.
    const onTime = why === 'done' && countFrom + ctx.seconds('s2-count') >= lastAt;
    if (!onTime && await hold(s => s.t >= lastAt) === 'rest') continue;
    ctx.log('scene 2: the last numbers');
    if (await line('s2-3') === 'rest') continue;
    break;
  }
  side.lift(false);
  await breath('s2-4');
  await say('s2-4');
  if (E.asides.gravel) { await breath(E.asides.gravel); await say(E.asides.gravel); }

  // She steps off the gravel. From here a stop lights the lamp.
  her.stillSince = null;
  await pause(E.gaps['off-gravel'] ?? 1.6);
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
    if (asked) { await say('s2-lamp-mine'); await breath('s2-lamp-1'); }
    await say('s2-lamp-1');
    if (asked) {
      // [svarade nej i starten]: she had decided the walker cannot hear her.
      if (her.heardNo) { await breath('s2-lamp-2'); await say('s2-lamp-2'); }
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
    // After the lamp, a breath before she goes back to what she was doing.
    const from = again ? next : next + 1;
    await lampAtTheTree();
    if (from < beats.length) await breath('lamp-tree');
    for (let i = from; i < beats.length; i++) {
      const why = await beats[i]();
      if (why === 'rest') i--;
    }
  } else {
    // No stop since she stepped off: she asks for one, walking round the tree.
    // A walker in the middle of a stop has decided already; it shows first.
    let askedAt = null;
    let why = ctx.state().moving ? 'ok' : await hold(s => s.moving, { timeout: 4 });
    if (why !== 'lamp') why = await breath('s2-ask');
    if (why !== 'lamp') {
      ctx.log('scene 2: she asks');
      askedAt = now() + ctx.cue('s2-ask', W.stop);
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
  // Air beyond the standard's (?luft= over 1) comes once she has sat down,
  // so that a longer wait does not light the lamp more often.
  const exposedSky = E.luft > 1 ? E.after.sky / E.luft : E.after.sky;
  if (await opens(Math.max(E.at.sky, now() + exposedSky)) === 'lamp') {
    await lampAtTheTree();
    await opens(now() + 10);
  }
  her.exposed = false;
  if (her.stillSince === null) her.stillSince = now();
  ctx.log(`scene 3: ${ctx.world.light}, ${ctx.world.rain ? 'rain' : 'dry'}, ${ctx.world.landmark}`);
  if (E.after.sky > exposedSky) await opens(now() + E.after.sky - exposedSky);
  await breath('s3-1');
  await say('s3-1');
  const light = ctx.world.light === 'dark' ? 's3-dark' : 's3-light';
  const weather = ctx.world.rain ? 's3-rain' : 's3-dry';
  const landmark = `s3-${ctx.world.landmark}`;
  for (const [i, id] of [light, weather, 's3-near', landmark, 's3-2'].entries()) {
    await breath(id, SCENE3[i]);
    await say(id);
  }

  // 4. The bell. She is still under the tree and has to get onto the gravel
  // before the shift comes round the bend: a stop lights the lamp until she
  // is there. A stop, not a walker who has stood there all along: if the wait
  // ran out on one, she gets back unseen, and episode 2 is not told of a
  // suspicion the walker never caused.
  const into4 = await opens(Math.max(E.at.bell, now() + E.after.bell), LONG_WAIT);
  ctx.log('scene 4');
  side.bell();
  await ctx.until(() => false, { timeout: 2.2 });
  await say('s4-1');
  // A breath before she mutters "Up", while she still sits (not exposed).
  if (E.asides.up) await breath(E.asides.up);
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
    let why = E.asides.up ? await line(E.asides.up) : 'done';
    if (why === 'lamp') return why;
    why = await line('s4-2');
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
  await ctx.until(s => s.t >= end4 + E.end.soon && (
    (s.distToStart !== null && s.approaching && s.distToStart < 300) ||
    s.t >= end4 + E.end.gap));
  ctx.log('scene 4: the end');
  const last = ctx.state();
  // On the way back, or away from the start, each only when the distance shows it.
  // A walker who stands, or a phone without GPS, hears neither: she does not say where they go if she cannot see it.
  let where = null;
  if (last.approaching && last.distToStart !== null) where = 's4-back';
  else if (last.distToStart !== null && last.moving && last.receding) where = 's4-onward';
  if (where) {
    await ctx.play(where);
    await breath('name');
  }

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
  await breath('s4-all');
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
