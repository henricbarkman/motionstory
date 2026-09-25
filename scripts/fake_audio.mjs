// A Web Audio stand-in for node, strict where the browser is strict, so the
// simulation can run glimt/synth.js for real: a NaN into a gain throws here
// as it does in Chrome, a source started twice throws, and every source knows
// when it stops sounding. Plus a fake clock whose timers the Synth runs on.
//
// Only what synth.js uses is here. It makes no sound and mixes nothing; the
// questions it answers are "what is still playing", "did anything start that
// should not have", and, once `watching` is set, "did any gain go up after
// that" (`raised`). `broken` makes every AudioParam call throw, as an
// interrupted context can.

export function makeClock() {
  const clock = { time: 0, seq: 0, queue: [] };
  const add = (fn, ms, every) => {
    const id = ++clock.seq;
    clock.queue.push({ id, at: clock.time + Math.max(0, ms) / 1000, fn, every });
    return id;
  };
  clock.setTimeout = (fn, ms = 0) => add(fn, ms, 0);
  clock.setInterval = (fn, ms = 0) => add(fn, ms, Math.max(0.001, ms / 1000));
  clock.clearTimeout = clock.clearInterval = id => { clock.queue = clock.queue.filter(e => e.id !== id); };
  // Runs every timer due by `to`, in order, with the clock at each one's time.
  clock.advance = (to, onEach = () => {}) => {
    for (;;) {
      let next = null;
      for (const e of clock.queue) if (e.at <= to + 1e-9 && (!next || e.at < next.at)) next = e;
      if (!next) break;
      clock.time = Math.max(clock.time, next.at);
      if (next.every) next.at += next.every;
      else clock.queue = clock.queue.filter(e => e !== next);
      next.fn();
      onEach();
    }
    clock.time = Math.max(clock.time, to);
    onEach();
  };
  clock.intervals = () => clock.queue.filter(e => e.every).length;
  return clock;
}

const finite = (x, what) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${what}: non-finite ${x}`);
};

class Param {
  constructor(v, audio = null, gain = false) { this._v = v; this.events = 0; this.audio = audio; this.gain = gain; }
  get value() { return this._v; }
  set value(x) { this._check(); finite(x, 'AudioParam.value'); this._write(x); }
  _check() { if (this.audio && this.audio.broken) throw new Error('InvalidStateError: context interrupted'); }
  _write(v) {
    this._v = v; this.events++;
    if (this.gain && this.audio.watching && v > 1e-3) this.audio.raised++;
  }
  setValueAtTime(v, t) { this._check(); finite(v, 'setValueAtTime value'); finite(t, 'setValueAtTime time'); if (t < 0) throw new RangeError('negative time'); this._write(v); return this; }
  linearRampToValueAtTime(v, t) { this._check(); finite(v, 'linearRamp value'); finite(t, 'linearRamp time'); if (t < 0) throw new RangeError('negative time'); this._write(v); return this; }
  exponentialRampToValueAtTime(v, t) {
    this._check();
    finite(v, 'exponentialRamp value'); finite(t, 'exponentialRamp time');
    if (v === 0) throw new RangeError('exponentialRamp to 0');
    if (t < 0) throw new RangeError('negative time');
    this._write(v); return this;
  }
  setTargetAtTime(v, t, c) {
    this._check();
    finite(v, 'setTarget value'); finite(t, 'setTarget time'); finite(c, 'setTarget constant');
    if (t < 0 || c < 0) throw new RangeError('negative time or constant');
    this._write(v); return this;
  }
  cancelScheduledValues(t) { this._check(); finite(t, 'cancel time'); return this; }
  cancelAndHoldAtTime(t) { this._check(); finite(t, 'cancelAndHold time'); return this; }
}

class Node {
  constructor(audio) { this.audio = audio; this.outs = new Set(); }
  connect(n) { if (!n || !(n instanceof Node)) throw new TypeError('connect to a non-node'); this.outs.add(n); return n; }
  disconnect() { this.outs.clear(); }
}

class Source extends Node {
  constructor(audio) { super(audio); this.startedAt = null; this.endAt = Infinity; this.ended = false; this.onended = null; }
  start(when = 0, offset = 0, duration) {
    finite(when, 'start time');
    if (when < 0) throw new RangeError('negative start');
    if (this.startedAt !== null) throw new Error('InvalidStateError: start called twice');
    const at = Math.max(when, this.audio.currentTime);
    this.startedAt = at;
    this.endAt = this._naturalEnd(at, offset, duration);
    this.audio.started.push({ node: this, calledAt: this.audio.currentTime });
    this.audio.playing.add(this);
  }
  stop(when = 0) {
    finite(when, 'stop time');
    if (when < 0) throw new RangeError('negative stop');
    if (this.startedAt === null) throw new Error('InvalidStateError: stop before start');
    if (this.ended) return;
    this.endAt = Math.max(this.startedAt, when, this.audio.currentTime);
  }
  _naturalEnd() { return Infinity; }
}

class BufferSource extends Source {
  constructor(audio) { super(audio); this.buffer = null; this.loop = false; }
  _naturalEnd(at, offset = 0, duration) {
    if (duration !== undefined) { finite(duration, 'duration'); return at + duration; }
    if (this.loop || !this.buffer) return Infinity;
    return at + Math.max(0, this.buffer.duration - offset);
  }
}

class Oscillator extends Source {
  constructor(audio) { super(audio); this.type = 'sine'; this.frequency = new Param(440); this.detune = new Param(0); }
}

export class FakeAudioContext {
  constructor(clock) {
    this.clock = clock;
    this.sampleRate = 8000;           // small buffers; nothing is rendered
    this.playing = new Set();
    this.started = [];
    this.destination = new Node(this);
    this.watching = false;
    this.raised = 0;
    this.broken = false;
  }
  get currentTime() { return this.clock.time; }
  createGain() { const n = new Node(this); n.gain = new Param(1, this, true); return n; }
  createStereoPanner() { const n = new Node(this); n.pan = new Param(0, this); return n; }
  createBiquadFilter() { const n = new Node(this); n.type = 'lowpass'; n.frequency = new Param(350, this); n.Q = new Param(1, this); return n; }
  createBufferSource() { return new BufferSource(this); }
  createOscillator() { return new Oscillator(this); }
  createBuffer(channels, length, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate: rate, duration: length / rate, numberOfChannels: channels, getChannelData: i => data[i] };
  }
  // Ends every source whose time has come and fires its onended.
  update() {
    for (const s of [...this.playing]) {
      if (s.endAt <= this.currentTime + 1e-9) {
        this.playing.delete(s);
        s.ended = true;
        if (s.onended) s.onended();
      }
    }
  }
}
