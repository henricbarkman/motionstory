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

// Distance to the start position, and whether it is shrinking.
export class Homing {
  constructor() { this.samples = []; this.start = null; }

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
// gives one, otherwise distance over the last ~8 s. Fixes with poor accuracy
// still count as "seen" (for the contact cap) but do not move the estimate.
export class GpsSpeed {
  constructor() { this.fixes = []; this.accuracy = null; this.last = null; }

  push(t, coord) {
    this.accuracy = coord.accuracy ?? null;
    // Poor accuracy lowers contact (see Contact) but still counts for tempo:
    // a Doppler speed from a 80 m fix is usually fine, and treating fog as
    // stillness would make Vega say the walker stopped while they walk on.
    if (this.accuracy !== null && this.accuracy > 150) return this.value();
    if (this.last && haversine(this.last, coord) > 60) {
      // A single jump this size at walking pace is jitter, not movement.
      this.last = coord;
      return this.value();
    }
    this.last = coord;
    this.fixes.push({ t, coord, speed: coord.speed });
    // Four seconds: long enough to smooth one bad fix, short enough that a
    // stop shows within a few seconds instead of ten.
    while (this.fixes.length > 1 && this.fixes[0].t < t - 4) this.fixes.shift();
    return this.value();
  }

  value() {
    if (this.fixes.length === 0) return 0;
    const withSpeed = this.fixes.filter(f => typeof f.speed === 'number' && f.speed >= 0);
    if (withSpeed.length >= 2) {
      return withSpeed.reduce((s, f) => s + f.speed, 0) / withSpeed.length;
    }
    if (this.fixes.length < 2) return 0;
    const a = this.fixes[0], b = this.fixes[this.fixes.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return 0;
    let dist = 0;
    for (let i = 1; i < this.fixes.length; i++) dist += haversine(this.fixes[i - 1].coord, this.fixes[i].coord);
    return dist / dt;
  }
}

// Everything the chapter script can look at on a tick.
export class Walk {
  constructor(opts = {}) {
    this.tempo = new Tempo();
    this.contact = new Contact(opts.initialContact ?? 0.35);
    this.homing = new Homing();
    this.gps = new GpsSpeed();
    this.t = 0;
    this.lastTick = 0;
    this.speed = 0;
    this.gpsSeen = false;
  }

  // Called for every GPS fix (or simulated one).
  fix(t, coord) {
    this.gpsSeen = true;
    this.speed = this.gps.push(t, coord);
    this.homing.push(t, coord);
  }

  // Called on a steady clock, e.g. every 250 ms.
  tick(t) {
    const dt = Math.max(0, t - this.lastTick);
    this.lastTick = t;
    this.t = t;
    this.tempo.push(t, this.speed);
    this.contact.step(dt, { moving: this.tempo.moving, accuracy: this.gps.accuracy });
    return this.state();
  }

  state() {
    const t = this.t;
    return {
      t,
      speed: this.speed,
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
      gpsSeen: this.gpsSeen,
    };
  }
}

// Lets the chapter script be written as straight-line async code:
//   await ctx.until(s => s.contact > 0.8, { timeout: 90 })
// Predicates are checked on each tick; the promise resolves true when the
// predicate holds and false when the timeout (seconds) runs out first.
export class Waiter {
  constructor() { this.pending = []; }

  until(pred, { timeout = Infinity } = {}) {
    return new Promise(resolve => {
      this.pending.push({ pred, resolve, deadline: null, timeout });
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
}
