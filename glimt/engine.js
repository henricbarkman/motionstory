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
    this.lastT = null;
    this.samples = 0;
    this.trusted = false;        // on a steady rhythm, off when GPS overrules
    this.trustedCadence = null;
    this.trustCount = 0;
  }

  push(t, mag) {
    if (!Number.isFinite(mag)) return;
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    this.samples++;
    // First sample, or the sensor was silent: start the averages afresh.
    if (this.fast === null || dt > 1) {
      this.fast = this.slow = mag;
      this.armed = false;
      return;
    }
    if (dt <= 0) return;
    this.fast += (1 - Math.exp(-dt / STEP_FAST)) * (mag - this.fast);
    this.slow += (1 - Math.exp(-dt / STEP_SLOW)) * (mag - this.slow);
    const x = this.fast - this.slow;
    if (this.armed && x > STEP_PEAK) {
      const last = this.times[this.times.length - 1];
      if (last === undefined || t - last >= STEP_MIN_GAP) this._step(t);
      this.armed = false;
    } else if (!this.armed && x < 0) {
      this.armed = true;
    }
  }

  _step(t) {
    this.times.push(t);
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

  // GPS overruled the feet: forget the rhythm, so trust needs a new one.
  distrust() {
    this.trusted = false;
    this.times = [];
  }

  // Samples arriving. The sensor stops with the screen.
  live(t) { return this.lastT !== null && t - this.lastT < 2; }

  // Steps per minute over the last few seconds; 0 once the feet have stopped,
  // and 0 for anything slower than a gait.
  cadence(t) {
    const recent = this.times.filter(s => s >= t - STEP_WINDOW);
    if (recent.length < 3 || t - recent[recent.length - 1] > STEP_GONE) return 0;
    const c = (recent.length - 1) / (recent[recent.length - 1] - recent[0]) * 60;
    return c >= STEP_MIN_CADENCE ? c : 0;
  }
}

// Knocks on the phone through a pocket (the lab's "Knacket"). A knock is a
// spike one or two samples wide; a step, even a running one, is a wave over
// many. So the detector asks how far a sample stands out from the two
// samples either side of it (the curvature), not how far it rises above an
// average: a first version did the latter and read simulated running as
// seventy knocks a minute, because a fast wave outruns any average.
//
// Nothing here has met a real pocket yet (2026-09-25). Every spike, knock or
// not, is kept in `spikes` so the lab can log what the sensor actually saw
// and the thresholds can be set from a walk instead of a guess.
const KNOCK_JUMP = 3.0;      // m/s² above the mean of the two neighbours
const KNOCK_SEEN = 1.5;      // smaller spikes are logged, not counted
const KNOCK_GAP = 0.12;      // s; spikes closer than this are the same knock
const KNOCK_PAIR = 0.8;      // s; two knocks within this are a double knock

export class Knocks {
  constructor() {
    this.prev = null;          // {t, m}: the sample before the one being judged
    this.cur = null;           // {t, m}: the sample being judged
    this.times = [];           // knock times, last ten seconds
    this.doubles = [];         // double-knock times, last minute
    this.spikes = [];          // {t, peak, knock}, last minute
    this.mutedUntil = -Infinity;
    this.count = 0;
    this.history = [];         // every double-knock time this walk (capped)
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
      if (peak > KNOCK_SEEN) this._spike(this.cur.t, peak);
    }
    this.prev = this.cur;
    this.cur = next;
  }

  _spike(t, peak) {
    const knock = peak > KNOCK_JUMP && t >= this.mutedUntil;
    this.spikes.push({ t, peak, knock });
    while (this.spikes.length && this.spikes[0].t < t - 60) this.spikes.shift();
    if (!knock) return;
    const last = this.times[this.times.length - 1];
    if (last !== undefined && t - last < KNOCK_GAP) return;
    this.times.push(t);
    this.count++;
    while (this.times.length && this.times[0] < t - 10) this.times.shift();
    const prev = this.times[this.times.length - 2];
    const lastDouble = this.doubles[this.doubles.length - 1];
    // A double is two knocks close together, and a third right after does
    // not make a second double out of knocks two and three.
    if (prev !== undefined && t - prev <= KNOCK_PAIR && !(lastDouble !== undefined && lastDouble >= prev)) {
      this.doubles.push(t);
      while (this.doubles.length && this.doubles[0] < t - 60) this.doubles.shift();
      if (this.history.length < 2000) this.history.push(t);
    }
  }

  lastDoubleAt() { return this.doubles.length ? this.doubles[this.doubles.length - 1] : -Infinity; }

  // Knocks in (from, to]. For "knock as many times as I did".
  countBetween(from, to) { return this.times.filter(k => k > from && k <= to).length; }
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

// Everything the chapter script can look at on a tick.
export class Walk {
  constructor(opts = {}) {
    this.tempo = new Tempo();
    this.contact = new Contact(opts.initialContact ?? 0.35);
    this.homing = new Homing();
    this.target = null;
    this.gps = new GpsSpeed();
    this.steps = new Steps();
    this.knocks = new Knocks();
    this.track = [];            // decent fixes, last two minutes: {t, latitude, longitude}
    this.odo = 0;               // metres, the pace integrated over time
    this.t = 0;
    this.lastTick = 0;
    this.speed = 0;
    this.pace = 0;
    this.paceSource = 'gps';
    this.gpsSpeeds = [];        // [{t, v}] per fix, last 30 s
    this.gpsSeen = false;
  }

  // Called for every accelerometer sample: |acceleration including gravity|.
  motion(t, magnitude) {
    this.steps.push(t, magnitude);
    this.knocks.push(t, magnitude);
  }

  // What the tempo bands see. Once the feet are trusted and the sensor is
  // live they decide moving or still, and cadence decides how fast; otherwise
  // the GPS speed does, as before.
  _pace(t) {
    if (this.steps.trusted && this._feetQuietWhileGpsMoves(t)) this.steps.distrust();
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
      this.track.push({ t, latitude: coord.latitude, longitude: coord.longitude });
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
      distToTarget: this.target ? this.target.distance() : null,
      approachingTarget: this.target ? this.target.approaching(t) : false,
      gpsSeen: this.gpsSeen,
      odo: this.odo,
      heading: headingOf(this.track, t),
      lastStepAt: this.steps.lastStepAt,
      stepsTrusted: this.steps.trusted,
      knocks: this.knocks.count,
      lastDoubleKnockAt: this.knocks.lastDoubleAt(),
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
