// Contact engine for Glimt. Pure logic, no DOM, no audio: everything here is
// driven by tick(t, sample) and can run in node with a simulated walk.
//
// Units: t in seconds since start, speed in m/s, distances in metres.

export const RUN_MS = 7 / 3.6;      // above this the walker is running
export const STILL_MS = 0.5;         // below this the walker stands still

// Hysteresis so a band does not flap on GPS noise.
const ENTER = { walk: 0.6, run: RUN_MS + 0.15 };
const LEAVE = { walk: 0.4, run: RUN_MS - 0.15 };

export function haversine(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Speed history and tempo band. Speed samples come from the GPS layer already
// smoothed over a few fixes; this class only keeps a window and derives events.
export class Tempo {
  constructor() {
    this.samples = [];          // [{t, v}]
    this.band = 'still';
    this.bandSince = 0;
    this.stillSince = 0;        // t when the walker last became still
    this.movingSince = null;    // t when the walker last started moving
    this.lastIncreaseAt = -Infinity;
    this.increaseCount = 0;
  }

  push(t, v) {
    this.samples.push({ t, v });
    while (this.samples.length && this.samples[0].t < t - 120) this.samples.shift();
    this._updateBand(t, v);
    this._detectIncrease(t);
  }

  _updateBand(t, v) {
    let next = this.band;
    if (this.band === 'still' && v > ENTER.walk) next = 'walk';
    if (this.band === 'walk' && v < LEAVE.walk) next = 'still';
    if (this.band !== 'run' && v > ENTER.run) next = 'run';
    if (this.band === 'run' && v < LEAVE.run) next = v > ENTER.walk ? 'walk' : 'still';
    if (next !== this.band) {
      const from = this.band;
      this.band = next;
      this.bandSince = t;
      if (next === 'still') this.stillSince = t;
      if (from === 'still') this.movingSince = t;
      if (rank(next) > rank(from) && from !== 'still') this._increase(t);
    }
  }

  // Average speed over [t-from, t-to].
  avg(t, from, to = 0) {
    let sum = 0, n = 0;
    for (const s of this.samples) {
      if (s.t >= t - from && s.t <= t - to) { sum += s.v; n++; }
    }
    return n ? sum / n : null;
  }

  // A tempo increase is the last 15 s clearly faster than the minute before
  // it. Band steps up count too (handled in _updateBand). One event per 60 s.
  _detectIncrease(t) {
    const recent = this.avg(t, 15);
    const before = this.avg(t, 75, 15);
    if (recent === null || before === null || before < 0.3) return;
    if (recent >= before * 1.25 && recent - before >= 0.3) this._increase(t);
  }

  _increase(t) {
    if (t - this.lastIncreaseAt < 60) return;
    this.lastIncreaseAt = t;
    this.increaseCount++;
  }

  // The pace pushed at or just before `t`; 0 before the first.
  speedAt(t) {
    for (let i = this.samples.length - 1; i >= 0; i--) if (this.samples[i].t <= t) return this.samples[i].v;
    return 0;
  }

  get moving() { return this.band !== 'still'; }

  stillFor(t) { return this.moving ? 0 : t - this.stillSince; }
  movingFor(t) { return this.moving ? t - this.bandSince : 0; }
}

function rank(band) { return { still: 0, walk: 1, run: 2 }[band]; }

// The single meter. Movement raises it, stillness lets it decay unless a hold
// scene is running, and poor GPS accuracy caps it: when the phone does not
// know where the walker is, neither does Vega.
export class Contact {
  constructor(init = 0.35) {
    this.value = init;
    this.hold = false;
    this.rise = 0.018;     // per second while moving: 0 -> 0.8 in ~45 s
    this.decay = 0.04;     // per second while still: 1 -> 0 in 25 s
    this.poorCap = 0.5;
  }

  step(dt, { moving, accuracy }) {
    const cap = accuracy != null && accuracy > 40 ? this.poorCap : 1;
    if (moving) {
      this.value += this.rise * dt;
    } else if (!this.hold) {
      this.value -= this.decay * dt;
    }
    if (this.value > cap) this.value = Math.max(cap, this.value - 0.02 * dt);
    this.value = Math.min(1, Math.max(0, this.value));
    return this.value;
  }
}

// Distance to an anchor, and whether it is shrinking. Without an anchor the
// first fix becomes one (distance to start); with one it is a target such as
// the landmark from the previous chapter.
export class Homing {
  constructor(anchor = null) { this.samples = []; this.start = anchor; }

  push(t, coord) {
    if (!this.start) this.start = coord;
    const d = haversine(this.start, coord);
    this.samples.push({ t, d });
    while (this.samples.length && this.samples[0].t < t - 120) this.samples.shift();
    return d;
  }

  distance() {
    return this.samples.length ? this.samples[this.samples.length - 1].d : null;
  }

  // Approaching = at least 40 m closer than 45 s ago.
  approaching(t) {
    if (this.samples.length < 2) return false;
    const now = this.samples[this.samples.length - 1].d;
    let then = null;
    for (const s of this.samples) { if (s.t <= t - 45) then = s.d; }
    return then !== null && then - now > 40;
  }

  // Receding = at least 50 m farther away than 90 s ago. Over a longer span
  // than approaching, so that a winding road counts too: walking out along
  // streets, only half of the steps may point away from the start, and 40 m
  // in 45 s asked for nearly all of them (code review 20/10). Two fixes near
  // the 50 m accuracy limit can still disagree by more than that, so a walker
  // going sideways may count as receding. One on the way back cannot: 90 s at
  // walking pace is about 100 m closer, and the episode asks approaching first.
  receding(t) {
    if (this.samples.length < 2) return false;
    const now = this.samples[this.samples.length - 1].d;
    let then = null;
    for (const s of this.samples) { if (s.t <= t - 90) then = s.d; }
    return then !== null && now - then > 50;
  }
}

// Turns raw fixes into a smoothed speed. Uses coords.speed when the device
// gives one, otherwise distance between the kept fixes. Fixes with poor
// accuracy still count as "seen" (for the contact cap) but do not move the
// estimate. `source` says which of the two the last value came from.
//
// Phones do not all report once a second. A coarse fix (±70 m, before the
// satellites lock) can come every five or ten seconds, and the first field
// test read a walker as standing still for its whole minute and a half
// because the window then never held more than one fix.
const MAX_GAP = 20;   // two fixes further apart say nothing about the pace now
const JUMP_MS = 8;    // implied speed above this, beyond 60 m, is jitter

export class GpsSpeed {
  constructor() { this.fixes = []; this.accuracy = null; this.last = null; this.lastT = null; this.source = null; }

  push(t, coord) {
    this.accuracy = coord.accuracy ?? null;
    // Poor accuracy lowers contact (see Contact) but still counts for tempo:
    // a Doppler speed from a 80 m fix is usually fine, and treating fog as
    // stillness would make Vega say the walker stopped while they walk on.
    if (this.accuracy !== null && this.accuracy > 150) return this.value();
    // A 60 m jump in one second is jitter; 60 m in twenty is a runner.
    if (this.last && haversine(this.last, coord) > Math.max(60, JUMP_MS * (t - this.lastT))) {
      this.last = coord;
      this.lastT = t;
      return this.value();
    }
    this.last = coord;
    this.lastT = t;
    this.fixes.push({ t, coord, speed: coord.speed });
    // Four seconds: long enough to smooth one bad fix, short enough that a
    // stop shows within a few seconds instead of ten. Never fewer than two
    // fixes, though, unless they are too far apart to mean anything.
    while (this.fixes.length > 2 && this.fixes[0].t < t - 4) this.fixes.shift();
    while (this.fixes.length > 1 && this.fixes[0].t < t - MAX_GAP) this.fixes.shift();
    return this.value();
  }

  value() {
    if (this.fixes.length === 0) { this.source = null; return 0; }
    // Doppler speed is measured, not derived, so one fix is enough. Only the
    // last four seconds count: with sparse fixes an older one would hold a
    // stop back by a whole interval.
    const newest = this.fixes[this.fixes.length - 1].t;
    const withSpeed = this.fixes.filter(f => f.t >= newest - 4 && typeof f.speed === 'number' && f.speed >= 0);
    if (withSpeed.length) {
      this.source = 'doppler';
      return withSpeed.reduce((s, f) => s + f.speed, 0) / withSpeed.length;
    }
    if (this.fixes.length < 2) { this.source = null; return 0; }
    this.source = 'distance';
    const a = this.fixes[0], b = this.fixes[this.fixes.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return 0;
    let dist = 0;
    for (let i = 1; i < this.fixes.length; i++) dist += haversine(this.fixes[i - 1].coord, this.fixes[i].coord);
    return dist / dt;
  }
}

// Step detection from the accelerometer. The second field test showed why
// GPS cannot decide moving or still: one fix every six seconds, and the
// phone's own speed read 4-11 km/h walking and 1-3 km/h standing in a shop,
// straddling the 1.4 km/h still threshold. Feet do not have that problem.
//
// Only the magnitude of the acceleration is used, so the phone may sit any
// way in any pocket. Two averages with time constants (not per-sample
// factors, so the sensor rate does not matter): a fast one follows the step
// wave, a slow one follows gravity. A step is the wave rising STEP_PEAK above
// gravity after it has dipped below it since the last step.
const STEP_FAST = 0.05;      // s
const STEP_SLOW = 1.5;       // s
const STEP_PEAK = 1.0;       // m/s² above the slow average
const STEP_MIN_GAP = 0.25;   // s; more than 240 steps a minute is not feet
// A step sooner than this share of the walker's own recent interval is a
// bump inside a step, not a new one. The first recorded pocket (Henric's,
// 2026-09-28) gave a second peak about 0.28 s into many 0.5 s steps: the
// cadence read 150-170 at 4.8 km/h, the band said running, and running mutes
// knocks. With the guard the same walk reads 110-119 throughout. Capped at
// 0.3 s: a rejected step never becomes part of the rhythm the guard compares
// with, so at a higher cap an amble straight into a sprint was locked at half
// the sprint's cadence for as long as it lasted (review, 2026-09-28). Up to
// 200 steps a minute is always accepted; the pocket's bumps came at 0.28.
const STEP_RHYTHM = 0.6;
const STEP_RHYTHM_CAP = 0.3; // s
const STEP_WINDOW = 6;       // s of steps behind the cadence
const STEP_GONE = 2;         // s without a step and the walker has stopped
const STEP_FLOOR = 0.9;      // m/s; any rhythm of steps is at least a walk
// Gait lies between these. Picking the phone up once a second is slower,
// and a detector hearing two peaks per step would be faster.
const STEP_MIN_CADENCE = 70;
const STEP_MAX_CADENCE = 220;
// Feet silent this long while every GPS fix says clearly moving: the pocket
// has stopped passing steps through (or the phone is in a hand), so GPS takes
// over again until a new rhythm appears. Standing, this phone read at most
// 0.8 m/s, so 1.0 is not reached by a walker who has really stopped.
const FEET_QUIET = 15;       // s
const GPS_CLEARLY_MOVING = 1.0;  // m/s

// Stride grows with cadence: about 5 km/h at 120 steps a minute, and past the
// running threshold from about 145.
export function cadencePace(c) {
  const stride = Math.min(1.2, Math.max(0.5, 0.55 + (c - 100) * 0.0075));
  return c / 60 * stride;
}

export class Steps {
  constructor() {
    this.fast = null;
    this.slow = null;
    this.armed = false;
    this.times = [];             // step times, last ten seconds
    this.lastStepAt = -Infinity;
    this.prevStepAt = -Infinity;  // the step before it: the true gap, however seldom it is read
    this.prev2StepAt = -Infinity; // and the one before that: three in a row is a gait, two can be a bump
    this.resetAt = -Infinity;     // when the sensor last came back after a silence
    this.lastT = null;
    this.samples = 0;
    this.trusted = false;        // on a steady rhythm, off when GPS overrules
    this.trustedCadence = null;
    this.trustCount = 0;
    this.impacts = [];           // {t, peak} per step, last minute
    this.peak = null;            // the step being measured: {t, peak}
  }

  push(t, mag) {
    if (!Number.isFinite(mag)) return;
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    this.samples++;
    // First sample, or the sensor was silent: start the averages afresh,
    // and drop a step still being measured. Kept, the first bump after the
    // gap (the phone settling in the pocket) was written into that step's
    // impact, and one inflated step can turn Tassa's verdict (2026-09-25).
    if (this.fast === null || dt > 1) {
      this.resetAt = t;
      this.fast = this.slow = mag;
      this.armed = false;
      this.peak = null;
      return;
    }
    if (dt <= 0) return;
    this.fast += (1 - Math.exp(-dt / STEP_FAST)) * (mag - this.fast);
    this.slow += (1 - Math.exp(-dt / STEP_SLOW)) * (mag - this.slow);
    const x = this.fast - this.slow;
    if (this.armed && x > STEP_PEAK) {
      const last = this.times[this.times.length - 1];
      if (last === undefined || t - last >= this._minGap()) {
        this._step(t);
        this.peak = { t, peak: x };
      }
      this.armed = false;
    } else if (!this.armed && x < 0) {
      this.armed = true;
      this._impact();
    } else if (this.peak && x > this.peak.peak) {
      this.peak.peak = x;
    }
  }

  _step(t) {
    this.times.push(t);
    this.prev2StepAt = this.prevStepAt;
    this.prevStepAt = this.lastStepAt;
    this.lastStepAt = t;
    while (this.times.length && this.times[0] < t - 10) this.times.shift();
    // Trust the feet once they have shown a rhythm: six steps at a gait's
    // cadence, evenly spaced (no gap more than twice another). Handling the
    // phone makes bumps, not a rhythm. Until then (no sensor, or a detector
    // that hears nothing in this pocket) GPS decides, as before.
    if (this.trusted || this.times.length < 6) return;
    const six = this.times.slice(-6);
    const gaps = six.slice(1).map((s, i) => s - six[i]);
    const c = 5 / (six[5] - six[0]) * 60;
    const even = Math.max(...gaps) <= 2 * Math.min(...gaps);
    if (c >= STEP_MIN_CADENCE && c <= STEP_MAX_CADENCE && even) {
      this.trusted = true;
      this.trustedCadence = c;
      this.trustCount++;
    }
  }

  // The shortest gap a new step may follow the last one with: a share of the
  // median of the recent gaps within a walk, once there are three of them.
  _minGap() {
    const recent = this.times.slice(-7);
    const gaps = recent.slice(1).map((s, i) => s - recent[i]).filter(g => g < STEP_GONE);
    if (gaps.length < 3) return STEP_MIN_GAP;
    gaps.sort((a, b) => a - b);
    const n = gaps.length;
    const median = n % 2 ? gaps[(n - 1) / 2] : (gaps[n / 2 - 1] + gaps[n / 2]) / 2;
    return Math.min(STEP_RHYTHM_CAP, Math.max(STEP_MIN_GAP, STEP_RHYTHM * median));
  }

  // How hard a step landed: the highest the fast average rose over the slow
  // one, from the step until the wave came back down. Tassa compares these
  // before and after it asks for soft steps.
  _impact() {
    if (!this.peak) return;
    this.impacts.push(this.peak);
    this.peak = null;
    const t = this.impacts[this.impacts.length - 1].t;
    while (this.impacts.length && this.impacts[0].t < t - 60) this.impacts.shift();
  }

  // GPS overruled the feet: forget the rhythm, so trust needs a new one.
  // `reason` is for the log: 'gps' when the feet went quiet while samples
  // kept coming, 'silent' when the sensor itself had stopped. The first field
  // lab (2026-09-28) logged the second as the first and hid a dead sensor.
  distrust(reason = 'gps') {
    this.trusted = false;
    this.times = [];
    this.distrustReason = reason;
  }

  // Samples arriving. The sensor stops with the screen.
  live(t) { return this.lastT !== null && t - this.lastT < 2; }

  // Steps per minute over the last few seconds; 0 once the feet have stopped,
  // and 0 for anything slower than a gait.
  cadence(t) {
    let recent = this.times.filter(s => s >= t - STEP_WINDOW);
    // Only the steps since the last stop. Counted together with the walk
    // before it, one bump from handling the phone right after stopping read
    // as 75 steps a minute and Frys failed a walker who stood still (the
    // lab simulation, 2026-09-25).
    for (let i = recent.length - 1; i > 0; i--) {
      if (recent[i] - recent[i - 1] > STEP_GONE) { recent = recent.slice(i); break; }
    }
    if (recent.length < 3 || t - recent[recent.length - 1] > STEP_GONE) return 0;
    const c = (recent.length - 1) / (recent[recent.length - 1] - recent[0]) * 60;
    return c >= STEP_MIN_CADENCE ? c : 0;
  }
}

// Whether the phone is swaying with a gait, for the knock detector's two
// bars. Steps cannot say it: a knock is read as a step too, so three knocks
// standing still (Hon knackar's answer) look like three steps, and the knock
// simulation lost them that way (2026-09-28). The sway between knocks can:
// the spread of the signal over the last second, after a five-sample median
// has taken out anything as short as a knock. Henric's recorded pocket gave
// 2.6-5 walking and 0.0-0.5 standing.
//
// Two limits a review found (2026-09-28), left until a pocket shows them:
// the window trails by about a second, so a walker who stops and knocks
// slower than KNOCK_PAIR_WALKING within that second is judged walking and
// the knocks fall apart (Vega's retry line asks for two knocks close
// together); and a soft enough gait (Tassa) may sway under the threshold,
// so its heel strikes meet the standing bar. Labb 2's recording has Tassa.
const SWAY_WALKING = 1.0;    // m/s², standard deviation
const SWAY_WINDOW = 1.0;     // s, ending SWAY_SKIP before the moment asked about
const SWAY_SKIP = 0.1;
const SWAY_MIN_SAMPLES = 20;

export class Sway {
  constructor() {
    this.raw = [];               // the last five samples: {t, m}
    this.smooth = [];            // median of five, at the middle sample's time: {t, m}
    this.held = null;            // {verdict, until}: what stands over a stretch not pushed
  }

  // The samples from `from` to `until` will not be pushed: the phone's own
  // motor is running (Walk.buzz). The verdict from before stands until the
  // sway has been seen again. With an empty window the answer was "standing",
  // and a walker who kept walking through the buzz had a heel strike right
  // after it meet the standing bar and count as a knock (review, 2026-10-06).
  // `feet`: whether the feet were going then. Held, a sway without them was a
  // walker standing and shifting about, and her prompt first knock met the
  // walking bar (the second review, same day); it is held as standing.
  hold(from, until, feet = true) {
    this.held = { verdict: this.walkingAt(from) && feet, until: until + SWAY_WINDOW + SWAY_SKIP };
  }

  push(t, mag) {
    if (!Number.isFinite(mag)) return;
    this.raw.push({ t, m: mag });
    if (this.raw.length > 5) this.raw.shift();
    if (this.raw.length < 5) return;
    const mid = this.raw[2];
    const sorted = this.raw.map(s => s.m).sort((a, b) => a - b);
    this.smooth.push({ t: mid.t, m: sorted[2] });
    while (this.smooth.length && this.smooth[0].t < t - SWAY_WINDOW - 1) this.smooth.shift();
  }

  // The spread over the window before t; null with too little in it to tell.
  _spread(t) {
    const xs = this.smooth.filter(s => s.t >= t - SWAY_WINDOW - SWAY_SKIP && s.t < t - SWAY_SKIP).map(s => s.m);
    if (xs.length < SWAY_MIN_SAMPLES) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  }

  walkingAt(t) {
    const sd = this._spread(t);
    if (sd === null) return !!this.held && t < this.held.until && this.held.verdict;
    return sd > SWAY_WALKING;
  }

  // Known to stand still at t: the sway seen and under a gait's, or held so
  // from before the phone's own buzz. Not the opposite of walkingAt: a sensor
  // with too little to tell is walking to neither, and standing to neither.
  standingAt(t) {
    const sd = this._spread(t);
    if (sd === null) return !!this.held && t < this.held.until && !this.held.verdict;
    return sd <= SWAY_WALKING;
  }
}

// What the motion sensor made of a vibration pattern (Hon knackar). The motor
// turns several times between two samples, so a buzz shows as samples that
// jump about, not as a wave: the reading is the mean step between neighbouring
// samples, in m/s², while the motor ran (`on`) and in the pauses between and
// after (`off`), and `n` the fewer of the two counts of steps. `before` is
// the same over the moment before the buzz was asked for: `on` and `off`
// take the motor to start when asked, and one that starts 0.15 s late puts
// its shake in the pauses (review, 2026-10-06). Against `before` a buzz shows
// wherever it landed. A pocket at rest gives a few hundredths.
//
// Whether a buzz shows at all is not known yet. On 2026-10-06 the phone never
// buzzed (Chrome said yes; it leaves the motor alone on a silent phone and
// does not tell the page) and the sensor lay flat, 0.03 while and 0.01-0.03
// between, which says nothing until a buzz that was felt has been read too.
// So this is logged, and decides nothing.
//
// `samples` are {t, m} in time order, `pattern` is navigator.vibrate's
// (milliseconds on, off, on, ...) and `t0` when it was asked for, in the
// samples' seconds.
const BUZZ_RISE = 0.05;        // s for the motor to get going
const BUZZ_FALL = 0.1;         // s for it to stop
const BUZZ_AFTER = 0.4;        // s read as quiet after the last buzz
const BUZZ_BEFORE = 0.4;       // s read as the level before the buzz
const BUZZ_NEIGHBOURS = 0.1;   // s; samples further apart are not neighbours

export function buzzReading(samples, pattern, t0) {
  const on = [], off = [];
  let t = t0;
  for (let i = 0; i < pattern.length; i += 2) {
    const end = t + pattern[i] / 1000;
    const pause = (pattern[i + 1] || 0) / 1000;
    on.push([t + BUZZ_RISE, end]);
    off.push([end + BUZZ_FALL, end + (i + 2 >= pattern.length ? BUZZ_AFTER : pause)]);
    t = end + pause;
  }
  const restless = windows => {
    let sum = 0, n = 0;
    for (const [a, b] of windows) {
      let prev = null;
      for (const s of samples) {
        if (s.t < a) continue;
        if (s.t >= b) break;      // the sample at a window's end belongs to what comes next
        if (prev && s.t - prev.t <= BUZZ_NEIGHBOURS) { sum += Math.abs(s.m - prev.m); n++; }
        prev = s;
      }
    }
    return { mean: n ? sum / n : null, n };
  };
  const a = restless(on), b = restless(off);
  return { before: restless([[t0 - BUZZ_BEFORE, t0]]).mean, on: a.mean, off: b.mean, n: Math.min(a.n, b.n) };
}

// Knocks on the phone through a pocket (the lab's "Knacket"). A knock is a
// spike one or two samples wide; a step, even a running one, is a wave over
// many. So the detector asks how far a sample stands out from the two
// samples either side of it (the curvature), not how far it rises above an
// average: a first version did the latter and read simulated running as
// seventy knocks a minute, because a fast wave outruns any average.
//
// Heel strikes are sharp too, and a running one can stand out as much as a
// knock. So knocks are read in groups: knocks less than KNOCK_PAIR apart
// belong together, and a group closes when that much time passes without
// one. A closed group of two or three, with a second of quiet before it, is
// a double knock. Four or more is a rhythm, and steps are a rhythm. Knocks
// do not count while running at all (the Walk mutes them). With simulated
// heel strikes and neither guard, one lab read 59 doubles nobody knocked.
//
// Three counts as a double on purpose: someone asked to knock twice who is
// not sure it registered knocks again. An earlier version cancelled a double
// on any knock close after it, and a review found that three eager knocks
// then gave nothing at all (2026-09-25). A retry after a pause is a group of
// its own and counts again.
//
// Every spike, knock or not, is kept in `spikes` so the lab can log what the
// sensor actually saw.
//
// Walking needs its own bar. The first recorded pocket (Henric's, 2026-09-28,
// a front trouser pocket) put a heel strike over KNOCK_JUMP at nearly every
// step, peaks up to 13, and his knocks walking at 18-60. At the standing bar
// the strikes broke every double (no second of quiet, or a strike swallowing
// the knock inside KNOCK_GAP) and made false ones (two in a one-minute
// Takten). So while the feet are going, a knock must clear KNOCK_JUMP_WALKING,
// and the two knocks of a double must come closer than the next step would:
// his came 0.15-0.27 s apart, his steps 0.5 s. Standing keeps the low bar;
// his standing knocks in the first walk were 3-16.
//
// And one knock of a walking double must be hard. Turning round in labb 2
// (2026-10-01) put two heel strikes of 16.6 and 15.9 0.14 s apart, a double
// nobody knocked. In each of his three real doubles one knock was 39-61
// (19/39, 43/19, 32/61); a knuckle on a pocket lands one blow hard even when
// the other is soft. KNOCK_TOP_WALKING sits between the strike pair's 16.6
// and the softest real hard knock, 38.9, a little under their geometric mean
// (25.4). Single heel strikes reach 36 brisk, but a double needs two blows
// inside 0.4 s, and in the five recorded minutes only that one pair came.
// Walking or not is judged at the group's first knock, and the sway trails
// a second: a double knocked right after stopping, its first knock 15-25,
// is held to this bar and can be lost (Sway's first limit, a little wider).
//
// The walking bars follow the gait (2026-10-09). 15 and 25 were set on
// pockets whose heel strikes hit hard, and in a gentle walk they ask for
// knocks harder than a walker gives: Knacket gående heard one double of
// three that day (21.9 and 13.7 lost, 12.3 and 12.6 lost), though all three
// stood out in the sensor. So the gait sets the bars: its level is the
// median of the biggest curvature per half second over the last GAIT_WINDOW
// seconds of walking (quiet half seconds count, a gentle gait leaves many),
// and a knock must clear GAIT_JUMP levels, a double's hard knock GAIT_TOP,
// never less than the soft floors and never more than the fixed bars.
//
// The floors are what keeps it honest. In a gentle gait heel strikes and a
// phone taken out of the pocket still clear 9-17 now and then, two of them
// close enough to be a double (9.3 and 20.8 in labb 2 5/10; 13.0 and 16.7 at
// 12:24 9/10, the phone out of the pocket). So a walking knock must clear
// 11, and one of a double 19: of the nine doubles he was asked for in three
// walks (one knocked standing, read as walking), eight are heard, and in all
// thirteen saved walks no double that nobody knocked that version 26 did not
// hear as well (a few as the phone is pocketed at the start). His softest,
// 12.3 and 12.6, is as soft as those steps and is lost. The floors hold from 10 to 12 and from 18 to 20: 9 lets labb 2's
// step through, 13 loses a knock of 28/9, 16 the phone out of the pocket,
// 22 his 21.9 and 13.7.
//
// The level rises at once and falls slowly: the last GAIT_RECENT half
// seconds count on their own, by their second lowest. Without that, the
// first hard strides after ten slow seconds in labb 2 (6/10, 1:54, 20.8 and
// 11.5 0.30 s apart) met a bar still lowered and made a double nobody
// knocked. Not by their median: his own knocks are in the level too, and a
// missed double and the first knock of the retry fill three of five, which
// held the retry to the fixed bars. These have the least room: GAIT_RECENT
// 4 and 5 hold, 3 loses a knock and 6 lets labb 2's 1:54 through, and by
// the lowest of the five it is through as well. GAIT_JUMP holds 2 to 3.5.
//
// Under a lowered bar a heel strike's bounce clears it too, 0.12-0.14 s
// after the strike in three recordings (labb 2 turning round, 16.6 and 15.9;
// 12.1 and 12.9; 10.7 and 14.3). So there a spike within KNOCK_GAP_SOFT of a
// knock is the same blow, also when the bars rose between the two. His
// knocks come 0.21-0.33 s apart. At the fixed bars nothing changes from
// version 26.
const KNOCK_JUMP = 3.0;      // m/s² above the mean of the two neighbours
const KNOCK_JUMP_WALKING = 15;
const KNOCK_TOP_WALKING = 25;
const KNOCK_JUMP_SOFT = 11;  // the lowest the walking bars go
const KNOCK_TOP_SOFT = 19;
const GAIT_JUMP = 3;         // gait levels a walking knock must clear
const GAIT_TOP = 4.5;        // and one knock of a walking double
const GAIT_BIN = 0.5;        // s
const GAIT_WINDOW = 8;       // s of walking half seconds the level is read from
const GAIT_MIN_BINS = 10;    // fewer than this: the fixed bars
const GAIT_RECENT = 5;       // half seconds; a harder gait raises the bars at once
const GAIT_RECENT_RANK = 1;  // by the second lowest of them
const KNOCK_SEEN = 1.5;      // smaller spikes are logged, not counted
const KNOCK_GAP = 0.12;      // s; spikes closer than this are the same knock
const KNOCK_GAP_SOFT = 0.18; // the same, walking under lowered bars
const KNOCK_PAIR = 0.8;      // s; knocks closer than this are one group
const KNOCK_PAIR_WALKING = 0.4;
const KNOCK_ALONE = 1.0;     // s of quiet before a group for it to count
const KNOCK_MOST = 3;        // knocks in a group that can still be a double

export class Knocks {
  // `walking(t)` says whether the feet were going at t; without it every
  // knock is judged as standing.
  constructor({ walking = () => false } = {}) {
    this.walking = walking;
    this.prev = null;          // {t, m}: the sample before the one being judged
    this.cur = null;           // {t, m}: the sample being judged
    this.times = [];           // knock times, last ten seconds
    this.group = null;         // {alone, n, last}: the knocks still coming in
    this.doubles = [];         // double-knock times, last minute
    this.spikes = [];          // {t, peak, knock}, last minute
    this.mutedUntil = -Infinity;
    this.count = 0;
    this.history = [];         // every double-knock time this walk (capped)
    this.bins = [];            // {start, max, walking}: the gait, last forty seconds
    this.prevSoft = false;     // the last knock was judged under lowered bars
  }

  // The phone's own vibration shakes the sensor; nothing counts meanwhile.
  mute(until) { this.mutedUntil = Math.max(this.mutedUntil, until); }

  // Judges the previous sample once its successor has arrived.
  push(t, mag) {
    if (!Number.isFinite(mag)) return;
    const next = { t, m: mag };
    if (this.cur && t - this.cur.t > 1) { this.prev = null; this.cur = next; return; }
    if (this.prev && this.cur) {
      const peak = this.cur.m - (this.prev.m + next.m) / 2;
      if (this.cur.t >= this.mutedUntil) this._gait(this.cur.t, peak);
      if (peak > KNOCK_SEEN) this._spike(this.cur.t, peak);
    }
    this.prev = this.cur;
    this.cur = next;
  }

  // Every sample's curvature into its half second, the motor's excepted.
  _gait(t, peak) {
    const start = Math.floor(t / GAIT_BIN) * GAIT_BIN;
    let bin = this.bins[this.bins.length - 1];
    if (!bin || bin.start !== start) {
      bin = { start, max: 0, walking: this.walking(t) };
      this.bins.push(bin);
      while (this.bins[0].start < t - 40) this.bins.shift();
    }
    bin.max = Math.max(bin.max, peak);
  }

  // How hard the gait strikes before t: the median of the walking half
  // seconds over GAIT_WINDOW, or the second lowest of the last GAIT_RECENT
  // if that is higher. Null with too little walking to tell.
  gaitLevel(t) {
    const done = this.bins.filter(b => b.walking && b.start + GAIT_BIN <= t);
    const window = done.filter(b => b.start >= t - GAIT_WINDOW - GAIT_BIN);
    if (window.length < GAIT_MIN_BINS) return null;
    const sorted = bins => bins.map(b => b.max).sort((a, b) => a - b);
    const median = sorted(window)[Math.floor((window.length - 1) / 2)];
    const recent = sorted(done.slice(-GAIT_RECENT))[GAIT_RECENT_RANK];
    return Math.max(median, recent);
  }

  // The walking bars at t: {jump, top, soft}, soft when the gait lowered them.
  walkingBars(t) {
    const level = this.gaitLevel(t);
    if (level === null) return { jump: KNOCK_JUMP_WALKING, top: KNOCK_TOP_WALKING, soft: false, level };
    const jump = Math.min(KNOCK_JUMP_WALKING, Math.max(KNOCK_JUMP_SOFT, GAIT_JUMP * level));
    const top = Math.min(KNOCK_TOP_WALKING, Math.max(KNOCK_TOP_SOFT, GAIT_TOP * level));
    return { jump, top, soft: jump < KNOCK_JUMP_WALKING, level };
  }

  _spike(t, peak) {
    const walking = this.walking(t);
    const bars = walking ? this.walkingBars(t) : null;
    const knock = peak > (walking ? bars.jump : KNOCK_JUMP) && t >= this.mutedUntil;
    this.spikes.push({ t, peak, knock, walking, bar: bars ? bars.jump : KNOCK_JUMP });
    while (this.spikes.length && this.spikes[0].t < t - 60) this.spikes.shift();
    if (!knock) return;
    const prevKnock = this.times[this.times.length - 1];
    if (prevKnock !== undefined && t - prevKnock < (bars?.soft || this.prevSoft ? KNOCK_GAP_SOFT : KNOCK_GAP)) {
      // The same knock a sample or two on; its height is still the knock's.
      if (this.group) this.group.top = Math.max(this.group.top, peak);
      return;
    }
    this.times.push(t);
    this.prevSoft = !!bars?.soft;   // the blow's bounce is judged as the blow was
    this.count++;
    while (this.times.length && this.times[0] < t - 10) this.times.shift();
    this.settle(t);
    if (this.group && t - this.group.last <= this.group.pair) {
      this.group.n++;
      this.group.last = t;
      this.group.top = Math.max(this.group.top, peak);
    } else {
      this.group = {
        alone: prevKnock === undefined || t - prevKnock > KNOCK_ALONE, n: 1, last: t,
        walking, top: peak, pair: walking ? KNOCK_PAIR_WALKING : KNOCK_PAIR,
        hard: walking ? bars.top : 0,
      };
    }
  }

  // Closes the group once its pair gap has passed since its last knock, and
  // counts it if it was a double. Called on every tick and every knock.
  settle(t) {
    const g = this.group;
    if (!g || t - g.last <= g.pair) return;
    this.group = null;
    if (!g.alone || g.n < 2 || g.n > KNOCK_MOST) return;
    if (g.walking && g.top < g.hard) return;
    this.doubles.push(g.last);
    while (this.doubles.length && this.doubles[0] < t - 60) this.doubles.shift();
    if (this.history.length < 2000) this.history.push(g.last);
  }

  // Forgets the doubles from `from` on that `which` picks, and any group
  // still open.
  retract(from, which = () => true) {
    this.group = null;
    const keep = d => d < from || !which(d);
    this.doubles = this.doubles.filter(keep);
    this.history = this.history.filter(keep);
  }

  lastDoubleAt() { return this.doubles.length ? this.doubles[this.doubles.length - 1] : -Infinity; }

  // Knocks in (from, to]. For "knock as many times as I did".
  countBetween(from, to) { return this.times.filter(k => k > from && k <= to).length; }

  // Forgets every knock from `from` on, and the doubles they made: they were
  // a jump's blows (Jumps), not a hand on the pocket.
  forget(from) {
    this.retract(from);
    const kept = this.times.filter(k => k < from);
    this.count -= this.times.length - kept.length;
    this.times = kept;
    this.spikes.forEach(s => { if (s.t >= from) s.knock = false; });
  }
}

// A jump (Hoppet, 2026-10-17). While both feet are off the ground the phone
// falls with the walker, and a falling phone feels almost nothing: the
// magnitude of accelerationIncludingGravity drops from 9.8 towards zero, then
// the landing hits. Air time is 2·sqrt(2h/g): 0.20 s for a skip of 5 cm,
// 0.29 for 10, 0.40 for 20.
//
// A gait dips too, between push-off and heel strike, but briefly. In the nine
// recorded walks (scripts/recordings, some 33 minutes of walking, standing,
// knocking and turning, no running) the longest stretch under JUMP_FALL, from
// the first sample under it to the first back over, was 134 ms (labb 2,
// 1/10, 2:42); the five longest 116-134. Under 3 m/s² it was 106 ms, under 5
// already 165. So a jump is JUMP_AIR under JUMP_FALL: 46 ms over the longest
// a gait gave, and a hop of 4 cm still clears it. The bar is 4, not 3,
// because a pocket in the air is not quite weightless: the leg moves under
// the body while it flies, and a single sample over the bar ends the fall.
//
// Then a landing within JUMP_LAND of the fall's end, over JUMP_LANDING. It
// says the fall ended on the feet, not that it was no step: the gait's own
// longest dips ended in 16-58 m/s², and the half-second maxima of the walks
// had a median of 20 and a 90th percentile of 43. A landing cannot be told
// from a heel strike by its height, only by the fall before it. 15 (one and a
// half g) is what a 5 cm drop stopped over some 5 cm of bent knees gives
// (v²/2d + g, about 20) with room for a softer one.
//
// Running has flights of its own, about a tenth of a second when jogging, and
// no recording has any: whether a run's falls stay under JUMP_AIR is not
// known. Hoppet logs the longest of them.
//
// Every fall of JUMP_KEEP or more is kept in `falls` so the lab can log what
// the sensor saw. A gap in the samples ends a fall: what the phone felt
// meanwhile is not known.
const JUMP_FALL = 4.0;        // m/s²
const JUMP_AIR = 0.18;        // s under JUMP_FALL
const JUMP_LAND = 0.3;        // s after the fall for the landing
const JUMP_LANDING = 15;      // m/s²
const JUMP_GAP = 0.1;         // s between samples that breaks a fall
const JUMP_KEEP = 0.03;       // s; shorter falls are not kept
const JUMP_EDGE = 0.04;       // s a fall may last past its last sample under the bar
// A fall this long holds the knocks' groups open until it ends: a push-off
// pair settled mid-flight was a double for the moment until the landing
// (review, 2026-10-17). A gait's dips last up to 0.134 s, so this delays a
// walking double by a few hundredths at most.
const JUMP_HOLD = 0.1;        // s
// The landing is as sharp as a knock and harder, and the first steps after
// it strike hard too: knocks are deaf for JUMP_DEAF after it, and any knock
// from JUMP_BEFORE before the take-off on is forgotten (the push-off and the
// landing are a pair of blows a few tenths apart, a double nobody knocked).
export const JUMP_DEAF = 1.0;  // s
const JUMP_BEFORE = 0.5;       // s

export class Jumps {
  constructor() {
    this.lastT = null;
    this.fallFrom = null;      // t of the first sample under the bar, in a fall
    this.lastUnder = null;     // t of the last sample under it
    this.pending = null;       // {from, air, end}: a fall long enough, waiting for its landing
    this.open = null;          // the jump whose landing window is still running
    this.falls = [];           // {t, air, jump}, last ten minutes
    this.older = 0;            // s, the longest fall no jump that has left `falls`
    this.history = [];         // {t, from, air, landing} per jump this walk (capped)
    this.count = 0;
    this.flights = 0;          // falls of JUMP_AIR or more, landed or not
    this.flightFrom = null;    // when the last of them began
  }

  // One sample. Returns the jump read on it, or null: read on the first
  // sample of the landing over JUMP_LANDING, so the knocks can be told before
  // they judge the landing. A fall long enough to be one counts in `flights`
  // as it ends, landing or not: a soft landing is still the end of a flight,
  // and its push-off still a blow (review, 2026-10-17).
  push(t, mag) {
    if (!Number.isFinite(mag)) return null;
    if (this.lastT !== null && t - this.lastT > JUMP_GAP) { this.fallFrom = null; this.pending = null; this.open = null; }
    if (this.lastT !== null && t <= this.lastT) return null;
    this.lastT = t;
    if (this.open) {
      if (t - this.open.end <= JUMP_LAND) this.open.landing = Math.max(this.open.landing, mag);
      else this.open = null;
    }
    if (mag < JUMP_FALL) {
      if (this.fallFrom === null) this.fallFrom = t;
      this.lastUnder = t;
      return null;
    }
    if (this.fallFrom !== null) {
      // To the first sample back over the bar, but no more than JUMP_EDGE
      // past the last one under it: sparse samples (a throttled sensor) would
      // otherwise stretch a gait's dip by most of an interval.
      const air = Math.min(t, this.lastUnder + JUMP_EDGE) - this.fallFrom;
      const fall = { t: this.fallFrom, air, jump: false };
      if (air >= JUMP_KEEP) {
        this.falls.push(fall);
        while (this.falls.length && this.falls[0].t < t - 600) {
          const old = this.falls.shift();
          if (!old.jump) this.older = Math.max(this.older, old.air);
        }
      }
      if (air >= JUMP_AIR) {
        this.pending = { from: this.fallFrom, air, end: t, fall };
        this.flights++;
        this.flightFrom = this.fallFrom;
      }
      this.fallFrom = null;
    }
    const p = this.pending;
    if (!p) return null;
    if (t - p.end > JUMP_LAND) { this.pending = null; return null; }
    if (mag < JUMP_LANDING) return null;
    this.pending = null;
    p.fall.jump = true;
    const jump = { t, from: p.from, air: p.air, end: p.end, landing: mag };
    this.open = jump;
    this.count++;
    if (this.history.length < 2000) this.history.push(jump);
    return jump;
  }

  // In a fall that has lasted `min` seconds at t: the knocks wait to close
  // their groups until it is over (Walk.tick). Not once the samples have
  // stopped: a fall the sensor went quiet in is no longer known to go on.
  falling(t, min = JUMP_HOLD) {
    return this.fallFrom !== null && t - this.fallFrom >= min && t - this.lastT <= JUMP_GAP;
  }

  // The longest fall that was no jump, this whole walk.
  longestFall() { return this.falls.reduce((a, f) => f.jump ? a : Math.max(a, f.air), this.older); }

  lastAt() { return this.history.length ? this.history[this.history.length - 1].t : -Infinity; }

  // The jumps nobody asked for: outside every window [a, b] one was asked
  // for in, and not after `asking`, when a question is still open (a walk
  // stopped mid-question).
  unasked(windows = [], asking = null) {
    return this.history.filter(j => !windows.some(([a, b]) => j.t >= a && j.t <= b) && !(asking !== null && j.t > asking));
  }
}

// Heading from GPS: the bearing from the newest fix back to the last one at
// least HEADING_SPAN metres away, within HEADING_AGE seconds. Null when the
// walker has not moved far enough to tell. Sparse fixes (one per six seconds
// on Henric's phone) make it slow, never fast: it says where the walker went,
// not where they are turning right now.
const HEADING_SPAN = 12;
const HEADING_AGE = 25;

export function bearing(a, b) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(b.longitude - a.longitude)) * Math.cos(toRad(b.latitude));
  const x = Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(toRad(b.longitude - a.longitude));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Signed difference b - a in degrees, in (-180, 180]. Positive is clockwise,
// a right turn.
export function angleDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

export function headingOf(track, t) {
  if (track.length < 2) return null;
  const newest = track[track.length - 1];
  for (let i = track.length - 2; i >= 0; i--) {
    const f = track[i];
    if (f.t < t - HEADING_AGE) break;
    if (haversine(f, newest) >= HEADING_SPAN) return bearing(f, newest);
  }
  return null;
}

// Acceleration magnitude for a simulated walker: one wave per step at the
// cadence that matches the speed, plus sensor noise. For ?sim and the tests.
export function simulatedMagnitude(t, speed) {
  const noise = (Math.random() - 0.5) * 0.3;
  if (speed < 0.3) return 9.81 + noise;
  let c = 60;
  while (c < 200 && cadencePace(c) < speed) c++;
  const amp = speed > RUN_MS ? 6 : 3;
  return 9.81 + amp * Math.sin(2 * Math.PI * c / 60 * t) + noise;
}

// ---------- the gyro: turns from the phone's own rotation ----------
// GPS reads a turn 12-15 s after it (Riktning, 2026-10-12, Chrome, ±5 m),
// and Henric found that "lite för lång tid". The gyro sees it as it happens.
//
// What the page is given. rotationRate is the phone's rotation about its own
// axes in degrees per second, and the axes are where the trouble is: the W3C
// spec of today says alpha is about x, beta y, gamma z; the spec before it,
// and MDN still, say alpha is about z. Chromium fills alpha, beta, gamma from
// the Android gyroscope's x, y, z, converted from radians
// (device_motion_event_pump.cc, read 2026-10-12), and Chrome m66 once sent
// radians. So the mapping here is Chrome's, the gyro is used only in Chrome
// on Android (Walk's `gyro` option, set by the app), and three checks below
// stand between a wrong assumption and a wrong answer.
//
// The turn. accelerationIncludingGravity points up (a phone flat on a table
// gives z +9.8, Android and the spec alike); averaged over a second it is the
// up direction in the phone's axes, whatever pocket the phone is in. The
// rotation about it is the walker's turn: ω·up, by the right-hand rule
// counter-clockwise seen from above, so a left turn is positive. `yaw` here is
// clockwise degrees, like a compass and angleDiff: right positive. The gait
// rotates the thigh fast, but about a level axis, at right angles to up, so
// it stays out of the projection; the hips' twist does not, and cancels over
// a stride.
//
// The checks, each of which makes the GPS read as before:
//  - units: a gait turns a trouser pocket at some 40-100 deg/s (rms), which
//    in radians would be 1-2. Under GYRO_UNITS_MIN (8) it is not degrees.
//  - axes: walking, almost all of the rotation is the thigh's swing, about a
//    level axis. If over GYRO_VERT_MAX of it lies along up, the axes are not
//    what this code thinks.
//  - handedness: while the walker stands and the phone is handled (put in the
//    pocket at the start), the up direction moves in the phone's axes, and the
//    gyro must say the same: a fixed direction seen from a turning phone
//    turns the other way, d(up)/dt = -ω × up. A gyro reporting the other
//    hand of rotation correlates negatively (about -0.7 in the simulated
//    pocket); a right one positively, if less than 1, for the quick up lags
//    the gyro by HAND_TAU. So only a negative correlation blocks.
//  - the phone's orientation (deviceorientation): Android works it out from
//    the same sensors inside the phone, before any browser has mapped an
//    axis, so it is a second opinion on every number the turns are made of.
//    From two orientations a few hundredths of a second apart comes the
//    rotation in the phone's own axes, and each of the gyro's three axes must
//    rise and fall with it (correlation ORIENT_MIN) at its size
//    (ORIENT_RATIO: degrees from the gyro per radian, 57.3), on every axis
//    that turns enough to judge (ORIENT_RMS), and every
//    axis that carries up must be among them. The thigh's swing turns one
//    axis, the hips' twist the one along up. And up from the accelerometer
//    must be up from the orientation (ORIENT_UP). Each axis on its own,
//    because a test of ω·up alone was fooled: with one axis mirrored the
//    swing leaks into it in step with the twist (2026-10-12, 2 pockets in
//    40). And the whole vector too (ORIENT_RESIDUAL): a gait turns the phone
//    mostly about one axis, so with the axes swapped each one can still rise
//    and fall with the orientation, only at the wrong size (0.94/0.97/0.90 at
//    51/85/38 deg/rad in one simulated pocket). The gyro is taken as its mean
//    over the same stretch of time the orientation turned in, not one sample
//    against the last rate seen, and the orientation may come late: Android
//    works it out by filtering, and the page gets both when it gets them. A
//    second review (2026-10-13) showed a right gyro failing the checks with
//    the orientation 40 ms late. So the stretch is tried shifted by each of
//    ORIENT_LAGS, one shift for all three axes, and the best is judged. The
//    shifts stop at a tenth of a second: a mirrored axis would need half a
//    period of what turns it to look right, a quarter of a second for the
//    steps and half for the stride. The sums forget over ORIENT_TAU, so a
//    phone handled at the start does not weigh on the whole walk; the
//    evidence (how far the orientation has turned) does not.
//    It catches one axis mirrored (rotation about up is invisible to the
//    handedness check), up pointing down, units, axes swapped (review,
//    2026-10-12: the first two gave the wrong side with every other check
//    passing). The side, left or right, is read only once this check has had
//    ORIENT_EVIDENCE to judge by, and agreed; until then the gyro reads
//    turning back (its sign does not matter) and the GPS tells the side. A
//    fault must never give the wrong side.
const GYRO_BIN = 0.25;        // s per bin of yaw and up kept
const GYRO_KEEP = 40;         // s of bins kept
const GRAV_TAU = 1.0;         // s: the up direction, averaged over a stride
const HAND_TAU = 0.1;         // s: the quick up, for the handedness check
const GYRO_STAT_TAU = 20;     // s: how far back units and axes are judged
const GYRO_STAT_MIN = 5;      // s of walking before they are judged at all
const GYRO_UNITS_MIN = 8;     // deg/s rms walking
const GYRO_VERT_MAX = 0.35;   // share of the walking rotation along up
export const HAND_EVIDENCE = 1.0;    // rad the up direction must have turned (predicted)
const HAND_MIN = 0;           // correlation below this, with evidence: wrong hand
const ORIENT_GAP = 0.2;       // s between orientation events, longer: no rate from them
const ORIENT_BASE = 0.04;     // s at least between the two orientations a rate is taken from
const ORIENT_LAGS = [-0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08, 0.1];  // s the orientation may trail the gyro by
const ORIENT_KEEP = 0.5;      // s of gyro samples kept to compare with
const ORIENT_TAU = 60;        // s of walking the comparison reaches back, decaying
export const ORIENT_EVIDENCE = 6.0;  // rad turned walking, by the orientation (some 4 s of gait)
const ORIENT_MIN = 0.8;       // correlation per axis, gyro against orientation
const ORIENT_RATIO = [45, 70];  // deg/s of gyro per rad/s of orientation: 57.3 if degrees, 1 if radians
const ORIENT_RESIDUAL = 0.3;  // of the orientation's rotation left over when the gyro's (in rad/s) is taken from it
const ORIENT_RMS = 0.05;      // rad/s (3 deg/s) rms on an axis, walking, to judge it: twice a phone gyro's noise at worst
const ORIENT_CARRY = 0.3;     // of up along an axis: it carries turns, so it must be judged
const ORIENT_UP = 0.9;        // mean cosine, up from the accelerometer against the orientation's
const GYRO_SILENT = 1.0;      // s without a rotation sample: the gyro is quiet
// The reading. A turn is the mean yaw over the last GYRO_AFTER seconds
// against the mean over GYRO_BEFORE seconds of walking at least GYRO_GAP
// before them. Two seconds is two strides at the cadences seen (91-124 steps
// a minute), so the hips' twist cancels in each mean. Three for the turn
// itself: a walker takes one to three seconds round a corner. The walker must
// be walking in both windows; standing between them is allowed (deciding at
// the crossing, turning on the spot) up to GYRO_SPAN in all. The new heading
// must hold, with both halves of the after window within GYRO_STEADY of each
// other, for GYRO_HOLD more: a turn shows as a heading kept for three seconds,
// a step round a puddle or a person (some two seconds) does not. And the up
// direction must stay within GYRO_HANDLED of where it was before: a phone
// taken out of the pocket and put back can come back facing another way, and
// to the gyro that is a turn as large as any.
const GYRO_AFTER = 2.0;
const GYRO_BEFORE = 2.0;
const GYRO_GAP = 3.0;
const GYRO_SPAN = 15;
const GYRO_STEADY = 25;       // degrees
const GYRO_HOLD = 1.0;        // s
const GYRO_HANDLED = 30;      // degrees

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : null; };
// The spec's device orientation as a matrix, phone axes to earth axes:
// Rz(alpha)·Rx(beta)·Ry(gamma), degrees.
export function rotationOf(alpha, beta, gamma) {
  const r = Math.PI / 180;
  const ca = Math.cos(alpha * r), sa = Math.sin(alpha * r), cb = Math.cos(beta * r), sb = Math.sin(beta * r);
  const cg = Math.cos(gamma * r), sg = Math.sin(gamma * r);
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}
const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;

// Sample i of a saved sensor file as Walk.motion takes it, or null: files
// before version 2 (app version 30) kept only |a|, and replay them as before.
// ax, ay, az centi m/s²; ra, rb, rg centi deg/s, absent or null without a gyro.
// The orientation events of a saved file, [{t, o}], or [] before version 2:
// `orient` is [ms, alpha, beta, gamma] with the angles in centidegrees.
export function savedOrient(rec) {
  return (rec.orient || []).map(([t, a, b, g]) => ({ t: t / 1000, o: { alpha: a / 100, beta: b / 100, gamma: g / 100 } }));
}

export function savedSensor(rec, i) {
  if (!rec.ax || rec.ax[i] == null) return null;
  const acc = { x: rec.ax[i] / 100, y: rec.ay[i] / 100, z: rec.az[i] / 100 };
  const r = rec.ra && rec.ra[i] != null ? { alpha: rec.ra[i] / 100, beta: rec.rb[i] / 100, gamma: rec.rg[i] / 100 } : null;
  return { acc, rate: r };
}

export class Gyro {
  // `enabled`: this browser's rotationRate is known (Chrome on Android).
  // `side`: up is known to point up, so left and right can be told too.
  constructor({ enabled = false, side = false } = {}) {
    this.enabled = enabled;
    this.side = enabled && side;
    this.up = null;             // slow up direction, unit, phone axes
    this.quick = null;          // quick up, for the handedness check
    this.lastT = null;
    this.lastRateT = -Infinity;
    this.rateSeen = false;
    this.yaw = 0;               // clockwise degrees, integrated
    this.bins = [];             // {start, yaw, n, up: [x,y,z], walk, rate}
    // Walking: decayed sums of |ω|² and (ω·up)² over the time they cover.
    this.walkW = 0; this.walkE = 0; this.walkV = 0;
    // Handling: predicted and seen movement of the quick up.
    this.hDot = 0; this.hPred = 0; this.hSeen = 0; this.hPath = 0;
    // The orientation: its last rotation matrix, its turns not yet compared
    // ({t0, t1, w, up}), the gyro's recent samples, and per shift in
    // ORIENT_LAGS decayed sums of the two against each other, walking.
    this.baseR = null; this.baseT = null; this.lastOT = null; this.orientSeen = false;
    this.oPend = []; this.gHist = [];
    this.oLag = ORIENT_LAGS.map(() => ({ dot: [0, 0, 0], M: [0, 0, 0], O: [0, 0, 0], res: 0 }));
    this.oPath = 0; this.oUp = 0; this.oUpW = 0;
  }

  // One deviceorientation event, {alpha, beta, gamma} in degrees. The spec's
  // rotation from the phone's axes to the earth's (x east, y north, z up) is
  // Rz(alpha)·Rx(beta)·Ry(gamma). Built as a matrix, not used as angles: in a
  // trouser pocket beta is near 90 degrees, where alpha and gamma lose their
  // meaning but the matrix keeps it.
  orient(t, o) {
    if (!o || ![o.alpha, o.beta, o.gamma].every(v => v !== null && v !== undefined && Number.isFinite(+v))) return;
    if (this.lastOT !== null && t <= this.lastOT) return;
    const gap = this.lastOT === null ? Infinity : t - this.lastOT;
    this.lastOT = t; this.orientSeen = true;
    const R = rotationOf(+o.alpha, +o.beta, +o.gamma);
    if (gap > ORIENT_GAP) { this.baseR = R; this.baseT = t; return; }
    const dt = t - this.baseT;
    if (dt < ORIENT_BASE) return;
    // pᵀ·R is the turn between the two in the phone's own axes; for a small
    // one its skew part over dt is the angular velocity there, rad/s, right-
    // handed. Up in the phone's axes is the earth's z: R's bottom row.
    const p = this.baseR;
    const D = (i, j) => p[0][i] * R[0][j] + p[1][i] * R[1][j] + p[2][i] * R[2][j];
    const w = [(D(2, 1) - D(1, 2)) / 2 / dt, (D(0, 2) - D(2, 0)) / 2 / dt, (D(1, 0) - D(0, 1)) / 2 / dt];
    this.oPend.push({ t0: this.baseT, t1: t, w, up: R[2] });
    if (this.oPend.length > 50) this.oPend.shift();   // no motion coming
    this.baseR = R; this.baseT = t;
  }

  // One motion sample. `acc` {x, y, z}: accelerationIncludingGravity; `rate`
  // {alpha, beta, gamma} or null; `walking`: the feet were going.
  push(t, acc, rate, walking) {
    if (!acc) return;
    const a = norm([+acc.x, +acc.y, +acc.z]);
    if (!a || a.some(v => !Number.isFinite(v))) return;
    const mag = Math.hypot(+acc.x, +acc.y, +acc.z);
    const dt = this.lastT === null ? null : t - this.lastT;
    this.lastT = t;
    let w = null;
    if (rate && [rate.alpha, rate.beta, rate.gamma].every(v => v !== null && v !== undefined && Number.isFinite(+v))) {
      w = [+rate.alpha, +rate.beta, +rate.gamma];
      this.rateSeen = true;
      this.lastRateT = t;
    }
    // A gap in the samples: start the averages afresh. What turned during
    // it is not known, so its bins stay empty and no turn spans them.
    // Two samples stamped alike (two events in one tick): the second is
    // skipped, not taken for a gap, which would throw the averages away.
    if (dt !== null && dt <= 0) { this.lastT = t - dt; return; }
    if (dt === null || dt > 0.5) {
      this.up = a; this.quick = a;
      return;
    }
    const prevQuick = this.quick;
    const k = 1 - Math.exp(-dt / GRAV_TAU);
    this.up = norm([this.up[0] + (a[0] - this.up[0]) * k, this.up[1] + (a[1] - this.up[1]) * k, this.up[2] + (a[2] - this.up[2]) * k]) || a;
    const q = 1 - Math.exp(-dt / HAND_TAU);
    this.quick = norm([prevQuick[0] + (a[0] - prevQuick[0]) * q, prevQuick[1] + (a[1] - prevQuick[1]) * q, prevQuick[2] + (a[2] - prevQuick[2]) * q]) || a;
    const bin = this._bin(t);
    bin.n++;
    bin.up[0] += this.up[0]; bin.up[1] += this.up[1]; bin.up[2] += this.up[2];
    if (walking) bin.walk++;
    if (!w || !this.enabled) return;
    bin.rate++;
    const vert = dot(w, this.up);
    this.yaw -= vert * dt;                // counter-clockwise from above is left
    bin.yaw += this.yaw;
    this.gHist.push({ t, w });
    while (this.gHist[0].t < t - ORIENT_KEEP) this.gHist.shift();
    this._compare(t, walking);
    if (walking) {
      const d = Math.exp(-dt / GYRO_STAT_TAU);
      this.walkW = this.walkW * d + dt;
      this.walkE = this.walkE * d + dot(w, w) * dt;
      this.walkV = this.walkV * d + vert * vert * dt;
    } else if (Math.abs(mag - 9.81) < 2) {
      // Standing, and little besides gravity in the reading: how far the
      // gyro says the quick up should have moved, against how far it did.
      const wr = w.map(v => v * Math.PI / 180);
      const c = cross(wr, prevQuick);
      const pred = [-c[0] * dt, -c[1] * dt, -c[2] * dt];
      const seen = [this.quick[0] - prevQuick[0], this.quick[1] - prevQuick[1], this.quick[2] - prevQuick[2]];
      this.hDot += dot(pred, seen);
      this.hPath += Math.sqrt(dot(pred, pred));
      this.hPred += dot(pred, pred);
      this.hSeen += dot(seen, seen);
    }
  }

  // The orientation's turns the gyro has caught up with (the latest shift
  // looks ahead of them): each against the gyro's mean over the same
  // stretch, shifted by each lag. Only walking, as the other figures.
  _compare(t, walking) {
    while (this.oPend.length && this.oPend[0].t1 - ORIENT_LAGS[0] < t) {
      const p = this.oPend.shift();
      if (!walking) continue;
      const means = ORIENT_LAGS.map(L => {
        let n = 0; const m = [0, 0, 0];
        for (const g of this.gHist) {
          if (g.t > p.t0 - L && g.t <= p.t1 - L) { n++; m[0] += g.w[0]; m[1] += g.w[1]; m[2] += g.w[2]; }
        }
        return n ? m.map(v => v / n) : null;
      });
      if (means.some(m => !m)) continue;
      const dt = p.t1 - p.t0, d = Math.exp(-dt / ORIENT_TAU);
      means.forEach((g, k) => {
        const s = this.oLag[k];
        let res = 0;
        for (let i = 0; i < 3; i++) {
          s.dot[i] = s.dot[i] * d + g[i] * p.w[i] * dt;
          s.M[i] = s.M[i] * d + g[i] * g[i] * dt;
          s.O[i] = s.O[i] * d + p.w[i] * p.w[i] * dt;
          res += (g[i] * Math.PI / 180 - p.w[i]) ** 2;
        }
        s.res = s.res * d + res * dt;
      });
      this.oPath += Math.hypot(p.w[0], p.w[1], p.w[2]) * dt;
      this.oUp = this.oUp * d + dot(this.up, p.up) * dt;
      this.oUpW = this.oUpW * d + dt;
    }
  }

  _bin(t) {
    const start = Math.floor(t / GYRO_BIN) * GYRO_BIN;
    let bin = this.bins[this.bins.length - 1];
    if (!bin || bin.start !== start) {
      bin = { start, yaw: 0, n: 0, rate: 0, walk: 0, up: [0, 0, 0] };
      this.bins.push(bin);
      while (this.bins[0].start < t - GYRO_KEEP) this.bins.shift();
    }
    return bin;
  }

  // The figures behind the checks, for the log.
  figures() {
    const rms = this.walkW ? Math.sqrt(this.walkE / this.walkW) : null;
    const vert = this.walkE ? this.walkV / this.walkE : null;
    const evidence = this.hPath;
    const hand = this.hPred && this.hSeen ? this.hDot / Math.sqrt(this.hPred * this.hSeen) : null;
    // The shift the two agree best at, by what is left over; then per axis
    // the correlation and size against the orientation, and how much the
    // orientation saw it turn (rms, rad/s).
    let best = null;
    this.oLag.forEach((s, k) => {
      const all = s.O[0] + s.O[1] + s.O[2];
      if (all && (!best || s.res / all < best.res)) best = { s, res: s.res / all, lag: ORIENT_LAGS[k] };
    });
    const s = best && best.s;
    const axes = [0, 1, 2].map(i => ({
      corr: s && s.M[i] && s.O[i] ? s.dot[i] / Math.sqrt(s.M[i] * s.O[i]) : null,
      ratio: s && s.O[i] ? s.dot[i] / s.O[i] : null,
      rms: s && this.oUpW ? Math.sqrt(s.O[i] / this.oUpW) : 0,
    }));
    const judged = axes.filter(a => a.rms >= ORIENT_RMS && a.corr !== null);
    const oCorr = judged.length ? Math.min(...judged.map(a => a.corr)) : null;
    const oUp = this.oUpW ? this.oUp / this.oUpW : null;
    const oRes = best ? best.res : null;
    const oLag = best ? best.lag : null;
    return { rms, vert, evidence, hand, walking: this.walkW, axes, oCorr, oUp, oRes, oLag, oEvidence: this.oPath, orientSeen: this.orientSeen };
  }

  // Whether the gyro may read a turn at t: {ok, why}. `side`: left or right
  // asked for, not only how much.
  status(t, { side = false } = {}) {
    const why = this.faults(t, { side });
    return why.length ? { ok: false, why: why[0] } : { ok: true, why: null };
  }

  // Every reason the gyro may not read at t, in the order the log tells
  // them. The first four stand alone: without them the rest mean nothing.
  // The others are all listed, so the tests can ask what each check stops
  // on its own, not only what it is first to stop.
  faults(t, { side = false } = {}) {
    if (!this.enabled) return ['används inte i den här webbläsaren'];
    if (!this.rateSeen) return ['telefonen ger ingen vridning'];
    if (t - this.lastRateT > GYRO_SILENT) return ['tyst'];
    const f = this.figures();
    if (f.walking < GYRO_STAT_MIN) return ['för lite gång än för att kolla det'];
    const out = [];
    if (f.rms < GYRO_UNITS_MIN) out.push(`vridningen i gång bara ${f.rms.toFixed(1)}/s, inte grader (radianer?)`);
    if (f.vert > GYRO_VERT_MAX) out.push(`axlarna stämmer inte (${Math.round(f.vert * 100)} % av vridningen runt lodlinjen)`);
    if (f.evidence >= HAND_EVIDENCE && f.hand !== null && f.hand < HAND_MIN) out.push(`gyrot och accelerometern är oense om vridningen (${f.hand.toFixed(2)})`);
    const judged = f.oEvidence >= ORIENT_EVIDENCE;
    if (judged) {
      const names = ['alpha', 'beta', 'gamma'];
      for (let i = 0; i < 3; i++) {
        const a = f.axes[i];
        if (a.rms < ORIENT_RMS) continue;
        if (a.corr === null) { out.push(`gyrot ger ingen vridning om ${names[i]}, telefonens riktning gör det`); continue; }
        if (a.corr < ORIENT_MIN) out.push(`gyrot och telefonens riktning är oense om ${names[i]} (${a.corr.toFixed(2)})`);
        if (a.ratio < ORIENT_RATIO[0] || a.ratio > ORIENT_RATIO[1]) out.push(`gyrot och telefonens riktning är oense om storleken på ${names[i]} (${a.ratio.toFixed(1)} per radian, inte 57)`);
      }
      if (f.oRes !== null && f.oRes > ORIENT_RESIDUAL) out.push(`gyrot och telefonens riktning är oense (${Math.round(f.oRes * 100)} % av vridningen skiljer)`);
      if (f.oUp !== null && f.oUp < ORIENT_UP) out.push(`accelerometern och telefonens riktning är oense om vad som är upp (${f.oUp.toFixed(2)})`);
    }
    if (side && !this.side) out.push('höger och vänster bara i Chrome på Android');
    if (side && !judged) {
      out.push(this.orientSeen ? 'höger och vänster inte prövade mot telefonens riktning än' : 'telefonen ger ingen riktning att pröva höger och vänster mot');
    }
    // Every axis up leans along must have been judged: a mirrored one that
    // barely turned while walking would still turn the reading round.
    if (side && this.up && f.axes.some((a, i) => Math.abs(this.up[i]) >= ORIENT_CARRY && (a.rms < ORIENT_RMS || a.corr === null))) {
      out.push('höger och vänster inte prövade på varje axel som bär upp');
    }
    return out;
  }

  // The turn read at t, or null: {deg, mid, dur}, deg clockwise (right
  // positive), mid when it was half done, dur from a tenth to nine tenths
  // of it. `since`: only turns half done after then. `min`, `max`: degrees.
  // Held: the same turn, same way, read at every bin of the last GYRO_HOLD.
  turn(t, { since = -Infinity, min = 50, max = Infinity } = {}) {
    let last = null;
    for (let h = 0; h <= GYRO_HOLD + 1e-9; h += GYRO_BIN) {
      const r = this.turnAt(t - h, { min, max });
      if (!r || (last && Math.sign(r.deg) !== Math.sign(last.deg))) return null;
      if (!last) last = r;
    }
    return last && last.mid >= since ? last : null;
  }

  // The same, unheld: the windows ending at t.
  turnAt(t, { min = 50, max = Infinity } = {}) {
    const end = Math.floor(t / GYRO_BIN + 1e-9) * GYRO_BIN;     // bins wholly before t
    const byStart = new Map(this.bins.map(b => [Math.round(b.start / GYRO_BIN), b]));
    const at = s => byStart.get(Math.round(s / GYRO_BIN));
    const span = (from, to) => {
      const out = [];
      for (let s = from; s < to - 1e-9; s += GYRO_BIN) out.push(at(s));
      return out;
    };
    const full = b => b && b.n > 0 && b.rate > b.n / 2;
    const walked = b => full(b) && b.walk > b.n / 2;
    const mean = bs => bs.reduce((a, b) => a + b.yaw, 0) / bs.reduce((a, b) => a + b.rate, 0);
    // A window is steady when its halves agree: the heading held, not still
    // turning. Both windows must be, or a slow turn is measured from its
    // middle: half a turn back over six seconds read as 114 degrees to one
    // side, a Vägval (2026-10-13, a simulated walker turning back at the
    // crossing).
    const steady = bs => Math.abs(mean(bs.slice(0, bs.length / 2)) - mean(bs.slice(bs.length / 2))) <= GYRO_STEADY;
    const after = span(end - GYRO_AFTER, end);
    if (!after.every(walked) || !steady(after)) return null;
    const yawAfter = mean(after);
    // The latest steady stretch of walking far enough before.
    let before = null, beforeEnd = null;
    for (let e = end - GYRO_AFTER - GYRO_GAP; e - GYRO_BEFORE >= end - GYRO_SPAN - 1e-9; e -= GYRO_BIN) {
      const bs = span(e - GYRO_BEFORE, e);
      if (bs.every(walked) && steady(bs)) { before = bs; beforeEnd = e; break; }
    }
    if (!before) return null;
    // Nothing missing between, and the phone where it was.
    const all = span(beforeEnd - GYRO_BEFORE, end);
    if (!all.every(full)) return null;
    const upOf = bs => norm(bs.reduce((a, b) => [a[0] + b.up[0], a[1] + b.up[1], a[2] + b.up[2]], [0, 0, 0]));
    const up0 = upOf(before);
    if (!up0 || all.some(b => angleBetween(up0, norm(b.up) || up0) > GYRO_HANDLED)) return null;
    const yawBefore = mean(before);
    const deg = yawAfter - yawBefore;
    if (Math.abs(deg) < min || Math.abs(deg) > max) return null;
    // When it turned, from the bins between: the first to pass a tenth,
    // half and nine tenths of the way.
    const between = span(beforeEnd, end - GYRO_AFTER + 1e-9);
    const passed = share => {
      const b = between.find(x => (x.yaw / x.rate - yawBefore) / deg >= share);
      return b ? b.start + GYRO_BIN / 2 : end - GYRO_AFTER;
    };
    return { deg, mid: passed(0.5), dur: Math.max(GYRO_BIN, passed(0.9) - passed(0.1)) };
  }
}

const RECENT = 20;   // s of raw samples kept, for reading a buzz afterwards

// Everything the chapter script can look at on a tick.
export class Walk {
  constructor(opts = {}) {
    this.tempo = new Tempo();
    this.contact = new Contact(opts.initialContact ?? 0.35);
    this.homing = new Homing();
    this.target = null;
    this.gps = new GpsSpeed();
    this.steps = new Steps();
    this.sway = new Sway();
    this.knocks = new Knocks({ walking: t => this.sway.walkingAt(t) });
    this.jumps = new Jumps();
    this.gyro = new Gyro(opts.gyro || {});
    this.track = [];            // decent fixes, last two minutes: {t, latitude, longitude, accuracy}
    this.odo = 0;               // metres, the pace integrated over time
    this.t = 0;
    this.lastTick = 0;
    this.speed = 0;
    this.pace = 0;
    this.paceSource = 'gps';
    this.gpsSpeeds = [];        // [{t, v}] per fix, last 30 s
    this.gpsSeen = false;
    this.sensorSecs = [];       // whole seconds with a sensor sample, last five minutes
    this.recent = [];           // every sample of the last RECENT seconds: {t, m}
    this.buzzUntil = -Infinity; // the phone's own motor runs until then
    this.running = false;       // a run that mutes knocks, as of the last tick
  }

  // The phone is about to vibrate, from `from` until `until` (the motor's
  // tail included). Its motor shakes the sensor, and the shake is not the
  // walker: nothing counts as a knock meanwhile, and motion() below keeps it
  // from the sway and from the feet. Left in the sway it would hold the knocks
  // answered right after a buzz to the walking bar for the second the sway
  // trails, and a knock on a pocket standing still does not clear that bar.
  buzz(from, until) {
    // A time that is no number would mute knocks for the rest of the walk.
    if (!Number.isFinite(from) || !Number.isFinite(until)) return;
    this.buzzUntil = Math.max(this.buzzUntil, until);
    this.knocks.mute(this.buzzUntil);
    this.sway.hold(from, this.buzzUntil, this.steps.cadence(from) > 0);
  }

  // The sensor's reading of a buzz that is over (buzzReading above).
  buzzSeen(pattern, t0) { return buzzReading(this.recent, pattern, t0); }

  // Called for every accelerometer sample: |acceleration including gravity|,
  // and, when the page has them, `sensor` {acc: {x, y, z}, rate: {alpha,
  // beta, gamma} or null} for the gyro. Without them nothing else changes.
  // A deviceorientation event, for the gyro's second opinion.
  orient(t, o) { this.gyro.orient(t, o); }

  motion(t, magnitude, sensor = null) {
    // While the phone's own motor runs the sample is the motor's. The sway
    // is given nothing and keeps its verdict (Sway.hold). The feet are given
    // the level they had: each buzz rises like a step, and three of them with
    // the knocks back close behind read as a rhythm fast enough to be a run,
    // which mutes knocks (review, 2026-10-06). A sample all the same, so the
    // sensor still counts as live.
    const own = t < this.buzzUntil;
    this.steps.push(t, own && this.steps.slow !== null ? this.steps.slow : magnitude);
    if (!own) this.sway.push(t, magnitude);
    // A jump is read on its landing's first sample, before the knocks judge
    // the landing (they judge a sample once the next has come): they are
    // deaf from then, and forget what the push-off gave (Jumps).
    const flights = this.jumps.flights;
    const jump = this.jumps.push(t, magnitude);
    if (jump || this.jumps.flights > flights) {
      this.knocks.forget((jump ? jump.from : this.jumps.flightFrom) - JUMP_BEFORE);
      this.knocks.mute(t + JUMP_DEAF);
    }
    this.knocks.push(t, magnitude);
    if (sensor) this.gyro.push(t, sensor.acc, sensor.rate, this.steps.cadence(t) > 0);
    if (Number.isFinite(magnitude)) {
      this.recent.push({ t, m: magnitude });
      while (this.recent[0].t < t - RECENT) this.recent.shift();
    }
    const sec = Math.floor(t);
    if (this.sensorSecs[this.sensorSecs.length - 1] !== sec) {
      this.sensorSecs.push(sec);
      while (this.sensorSecs.length && this.sensorSecs[0] < sec - 300) this.sensorSecs.shift();
    }
  }

  // Share of the whole seconds in [a, b) the sensor delivered in. "No
  // spikes" from a sensor that was not running is no answer about knocks,
  // and the first field lab could not tell the two apart (2026-09-28).
  sensorShare(a, b) {
    const from = Math.floor(a), to = Math.max(from + 1, Math.ceil(b));
    return this.sensorSecs.filter(s => s >= from && s < to).length / (to - from);
  }

  // What the tempo bands see. Once the feet are trusted and the sensor is
  // live they decide moving or still, and cadence decides how fast; otherwise
  // the GPS speed does, as before.
  _pace(t) {
    if (this.steps.trusted && this._feetQuietWhileGpsMoves(t)) this.steps.distrust(this.steps.live(t) ? 'gps' : 'silent');
    if (!this.steps.trusted || !this.steps.live(t)) {
      this.paceSource = 'gps';
      return this.speed;
    }
    this.paceSource = 'steps';
    const c = this.steps.cadence(t);
    return c ? Math.max(STEP_FLOOR, cadencePace(c)) : 0;
  }

  _feetQuietWhileGpsMoves(t) {
    if (t - this.steps.lastStepAt < FEET_QUIET) return false;
    const recent = this.gpsSpeeds.filter(f => f.t >= t - FEET_QUIET);
    return recent.length >= 2 && recent.every(f => f.v >= GPS_CLEARLY_MOVING);
  }

  // A place the chapter wants the walker to reach. Can be set late (the map
  // answer arrives seconds after start); distance is null until then.
  setTarget(coord) {
    this.target = coord ? new Homing({ latitude: coord.latitude, longitude: coord.longitude }) : null;
  }

  // Called for every GPS fix (or simulated one).
  fix(t, coord) {
    this.gpsSeen = true;
    this.speed = this.gps.push(t, coord);
    this.gpsSpeeds.push({ t, v: this.speed });
    while (this.gpsSpeeds.length && this.gpsSpeeds[0].t < t - 30) this.gpsSpeeds.shift();
    // Distance to start only from decent fixes. A stationary phone with 200 m
    // accuracy drifts hundreds of metres, which would read as walking home.
    if (coord.accuracy == null || coord.accuracy <= 50) {
      this.homing.push(t, coord);
      if (this.target) this.target.push(t, coord);
      this.track.push({ t, latitude: coord.latitude, longitude: coord.longitude, accuracy: coord.accuracy ?? null });
      while (this.track.length && this.track[0].t < t - 120) this.track.shift();
    }
  }

  // Where the walker was `ago` seconds back: the newest decent fix at or
  // before then. Null without one.
  positionAgo(t, ago) {
    let best = null;
    for (const f of this.track) { if (f.t <= t - ago) best = f; }
    return best;
  }

  // The newest decent fix, or null.
  position() { return this.track.length ? this.track[this.track.length - 1] : null; }

  // Called on a steady clock, e.g. every 250 ms.
  tick(t) {
    const dt = Math.max(0, t - this.lastTick);
    this.lastTick = t;
    this.t = t;
    this.pace = this._pace(t);
    this.odo += this.pace * dt;
    this.tempo.push(t, this.pace);
    // Running heel strikes are as sharp as knocks; nothing asks for a knock
    // mid-run, so none counts until a second after it. The band trails the
    // feet by up to the cadence window, so when running begins the doubles
    // heard in that window go too: in the simulation the first seconds of
    // Flykten left one in ten walks with a double nobody knocked.
    //
    // The band alone does not make it a run. A knock is read as a step too,
    // and so is a hand landing on the pocket: with one such bump a third of a
    // second before them, three knocks standing still are a rhythm of 150
    // steps a minute, and the mute took the third knock of Hon knackar's
    // answer (the lab simulation's field phone, nine walks in a hundred,
    // 2026-10-06). A phone known to be still is not running, whatever its
    // feet seem to say. (A pocket soft enough to hide a run's sway is not
    // muted either; its heel strikes already meet the standing bar walking.)
    // A run the GPS reads is left as it was: that is a walker on wheels, the
    // phone may well lie still, and a road's bumps are sharp too.
    const running = this.tempo.band === 'run' && !(this.paceSource === 'steps' && this.sway.standingAt(t));
    if (running) {
      // Only doubles heard on the move: one knocked standing still stays,
      // even if a run starts right after it (review, 2026-09-25).
      if (!this.running) this.knocks.retract(t - STEP_WINDOW, d => this.tempo.speedAt(d) > STILL_MS);
      this.knocks.mute(t + 1);
    }
    this.running = running;
    if (!this.jumps.falling(t)) this.knocks.settle(t);
    this.contact.step(dt, { moving: this.tempo.moving, accuracy: this.gps.accuracy });
    return this.state();
  }

  state() {
    const t = this.t;
    return {
      t,
      speed: this.speed,
      pace: this.pace,
      paceSource: this.paceSource,
      cadence: this.steps.cadence(t),
      band: this.tempo.band,
      moving: this.tempo.moving,
      stillFor: this.tempo.stillFor(t),
      movingFor: this.tempo.movingFor(t),
      lastIncreaseAt: this.tempo.lastIncreaseAt,
      contact: this.contact.value,
      hold: this.contact.hold,
      accuracy: this.gps.accuracy,
      distToStart: this.homing.distance(),
      approaching: this.homing.approaching(t),
      receding: this.homing.receding(t),
      distToTarget: this.target ? this.target.distance() : null,
      approachingTarget: this.target ? this.target.approaching(t) : false,
      gpsSeen: this.gpsSeen,
      odo: this.odo,
      heading: headingOf(this.track, t),
      lastStepAt: this.steps.lastStepAt,
      prevStepAt: this.steps.prevStepAt,
      prev2StepAt: this.steps.prev2StepAt,
      sensorResetAt: this.steps.resetAt,
      stepsTrusted: this.steps.trusted,
      // The sensor has answered at some point this walk, and is answering
      // now. The phone stops it when the screen goes dark.
      sensorSeen: this.steps.samples > 0,
      sensorLive: this.steps.live(t),
      knocks: this.knocks.count,
      lastDoubleKnockAt: this.knocks.lastDoubleAt(),
      jumps: this.jumps.count,
      lastJumpAt: this.jumps.lastAt(),
    };
  }
}

// Lets the chapter script be written as straight-line async code:
//   await ctx.until(s => s.contact > 0.8, { timeout: 90 })
//   await ctx.until(s => s.contact > 0.8, { by: 150 })
// Predicates are checked on each tick; the promise resolves true when the
// predicate holds and false when the deadline passes first. `timeout` is
// seconds from when the wait began, `by` is an absolute t in seconds. Use
// `by` for clock fallbacks, otherwise the fallback fires relative to the end
// of the previous line and can land before the condition's own earliest time.
export class Waiter {
  constructor() { this.pending = []; }

  until(pred, { timeout = Infinity, by = null } = {}) {
    return new Promise(resolve => {
      this.pending.push({ pred, resolve, deadline: by, timeout });
    });
  }

  check(state) {
    const keep = [];
    for (const p of this.pending) {
      if (p.deadline === null) p.deadline = state.t + p.timeout;
      let ok = false;
      try { ok = !!p.pred(state); } catch (e) { ok = false; }
      if (ok) p.resolve(true);
      else if (state.t >= p.deadline) p.resolve(false);
      else keep.push(p);
    }
    this.pending = keep;
  }

  // Ends every wait with false, so a chapter script that is no longer being
  // ticked (the walker pressed stop) runs to its end instead of dangling.
  abort() {
    for (const p of this.pending) p.resolve(false);
    this.pending = [];
  }
}
