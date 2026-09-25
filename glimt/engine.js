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
    this.lastT = null;
    this.samples = 0;
    this.trusted = false;        // set once, on the first steady rhythm
    this.trustedCadence = null;
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
    while (this.times.length && this.times[0] < t - 10) this.times.shift();
    // Trust the feet once they have shown a rhythm: six steps inside seven
    // seconds. Until then (no sensor, or a detector that hears nothing in
    // this pocket) GPS decides, as before.
    const n = this.times.length;
    if (!this.trusted && n >= 6 && t - this.times[n - 6] <= 7) {
      this.trusted = true;
      this.trustedCadence = this.cadence(t);
    }
  }

  // Samples arriving. The sensor stops with the screen.
  live(t) { return this.lastT !== null && t - this.lastT < 2; }

  // Steps per minute over the last few seconds; 0 once the feet have stopped.
  cadence(t) {
    const recent = this.times.filter(s => s >= t - STEP_WINDOW);
    if (recent.length < 3 || t - recent[recent.length - 1] > STEP_GONE) return 0;
    return (recent.length - 1) / (recent[recent.length - 1] - recent[0]) * 60;
  }
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
    this.t = 0;
    this.lastTick = 0;
    this.speed = 0;
    this.pace = 0;
    this.paceSource = 'gps';
    this.gpsSeen = false;
  }

  // Called for every accelerometer sample: |acceleration including gravity|.
  motion(t, magnitude) { this.steps.push(t, magnitude); }

  // What the tempo bands see. Once the feet are trusted and the sensor is
  // live they decide moving or still, and cadence decides how fast; otherwise
  // the GPS speed does, as before.
  _pace(t) {
    if (!this.steps.trusted || !this.steps.live(t)) {
      this.paceSource = 'gps';
      return this.speed;
    }
    this.paceSource = 'steps';
    const c = this.steps.cadence(t);
    return c ? Math.max(STEP_FLOOR, cadencePace(c)) : 0;
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
    // Distance to start only from decent fixes. A stationary phone with 200 m
    // accuracy drifts hundreds of metres, which would read as walking home.
    if (coord.accuracy == null || coord.accuracy <= 50) {
      this.homing.push(t, coord);
      if (this.target) this.target.push(t, coord);
    }
  }

  // Called on a steady clock, e.g. every 250 ms.
  tick(t) {
    const dt = Math.max(0, t - this.lastTick);
    this.lastTick = t;
    this.t = t;
    this.pace = this._pace(t);
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
