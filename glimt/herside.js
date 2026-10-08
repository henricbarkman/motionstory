// Her side: what the walker hears of Vega's world when the voice goes dull.
//
//   hum    : the loop's own drone, always there, low
//   steps  : her walk on gravel or on soft ground, one recorded step at a time
//   other  : someone else's steps, even and hard, coming closer and passing
//   hand   : her hand against the plastic tree
//   tone   : the soft tone of the lamp, pulsing while she is seen
//   bell   : the bell that closes the loop
//   say    : a voice on her side: the flat one in her ear, the woman beside
//            her, the other voice at the very end
//
// The hum, the tone and the bell are made here with Web Audio. The steps and
// the hand are sound effects cut into single steps (scripts/render_side.py),
// so this file sets the pace and can stop her mid-walk.
//
// Everything but the bell goes through one bus whose level follows
// `presence`: low under her voice while the walker walks, forward when the
// walker stands still and the voice sinks away. The bus goes to the mixer's
// master beside the voice, so contact never muffles it.

const UNDER = 0.3;      // bus level under her voice
const LIFTED = 0.7;     // under, but brought up: the count, someone coming
const FORWARD = 1.0;    // the walker stands still
const STEP_PEAK = 0.3;  // every step is levelled to this before the bus

// Where the other woman is: [level, lowpass Hz, pan].
const OTHER = {
  far: [0.0001, 700, -0.7],
  near: [1.1, 7000, -0.15],
  past: [0.0001, 900, 0.7],
};

// `timers` is for the simulation, which runs this on a fake clock.
export class HerSide {
  constructor(mixer, timers = globalThis) {
    this.ctx = mixer.ctx;
    this.timers = timers;
    const c = this.ctx;

    this.out = c.createGain();
    this.out.gain.value = 0;        // comes up with the first _level()
    this.out.connect(mixer.master);
    this.fixed = c.createGain();          // the bell: not on the presence bus
    this.fixed.gain.value = 1;
    this.fixed.connect(mixer.master);

    this.presence = 0;
    this.lifted = false;
    this.pinned = false;
    this.closed = false;
    this.fading = false;
    this.sounds = {};
    this.sources = new Set();
    this.stops = new Set();
    this.walking = null;                   // { surface, stop }
    this.otherWalk = null;
    this.toneStop = null;

    this._startHum();
    this._otherChain();
    this._level();
  }

  // --- loading -----------------------------------------------------------

  // `slices` is [[start, length], ...] in seconds; without it the whole
  // buffer is one sound (the hand).
  setSound(name, buffer, slices = null) {
    const cuts = (slices && slices.length ? slices : [[0, buffer.duration]]).map(([start, length]) => {
      const data = buffer.getChannelData(0);
      const from = Math.floor(start * buffer.sampleRate);
      const to = Math.min(data.length, Math.floor((start + length) * buffer.sampleRate));
      let peak = 0;
      for (let i = from; i < to; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
      const gain = peak > 0.01 ? Math.min(4, Math.max(0.25, STEP_PEAK / peak)) : 1;
      return { start, length, gain };
    });
    this.sounds[name] = { buffer, cuts, last: -1 };
  }

  // --- the bus -----------------------------------------------------------

  // 0 while the walker walks, 1 when the walker stands still.
  setPresence(p) {
    this.presence = Math.min(1, Math.max(0, p));
    this._level();
  }

  // Holds the side forward whatever the walker does: a line on her side
  // must be heard to its end even if the walker starts walking in it.
  pin(on) { this.pinned = !!on; this._level(); }

  // Brings the side up under the voice, for a stretch where it carries the
  // story and she says little.
  lift(on) { this.lifted = !!on; this._level(); }

  _level() {
    if (this.closed || this.fading) return;
    const base = this.lifted ? LIFTED : UNDER;
    const p = this.pinned ? 1 : this.presence;
    const level = base + (FORWARD - base) * p;
    this.out.gain.setTargetAtTime(level, this.ctx.currentTime, 0.3);
  }

  // --- the hum -------------------------------------------------------------

  _startHum() {
    const c = this.ctx;
    const hum = c.createGain();
    hum.gain.value = 1;
    const low = c.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 340;
    low.Q.value = 0.5;
    low.connect(hum);
    hum.connect(this.out);
    const now = c.currentTime;
    // Two saws a hair apart beat slowly, as a transformer does. The third,
    // an octave up, is what small earbuds can actually reproduce.
    for (const [type, freq, level] of [['sawtooth', 98, 0.1], ['sawtooth', 98.6, 0.1], ['triangle', 196.4, 0.07]]) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(low);
      osc.start(now);
      this.sources.add(osc);
    }
    // Air moving somewhere: a narrow band of noise, barely there.
    const noise = c.createBufferSource();
    noise.buffer = this._noise(2);
    noise.loop = true;
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.8;
    const air = c.createGain();
    air.gain.value = 0.017;
    noise.connect(band);
    band.connect(air);
    air.connect(hum);
    noise.start(now);
    this.sources.add(noise);
  }

  _noise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // --- steps ---------------------------------------------------------------

  // Calls `hit(time)` at `rate` steps a minute, looking a little ahead so
  // the walk does not depend on setInterval's jitter. After a stall (a
  // backgrounded tab) it starts again from now, no burst of missed steps.
  // `hit` returns what it started; stopping the loop takes back what has not
  // sounded yet, so her last step is not heard after she has stopped.
  _loop(rateFn, hit) {
    const ctx = this.ctx;
    let next = ctx.currentTime + 0.1;
    let stopped = false;
    let ahead = [];
    const id = this.timers.setInterval(() => {
      if (stopped) return;
      const rate = rateFn();
      if (!(rate > 0)) { next = ctx.currentTime + 0.1; return; }
      if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
      ahead = ahead.filter(a => a.when > ctx.currentTime);
      while (next < ctx.currentTime + 0.25) {
        ahead.push({ when: next, nodes: hit(next) || [] });
        next += 60 / rate;
      }
    }, 50);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.timers.clearInterval(id);
      this.stops.delete(stop);
      for (const a of ahead) {
        if (a.when <= ctx.currentTime) continue;
        for (const node of a.nodes) {
          try { node.stop(); } catch (_) {}
          this.sources.delete(node);
        }
      }
      ahead = [];
    };
    this.stops.add(stop);
    return stop;
  }

  // One cut of a sound at `when`, never the same cut twice in a row.
  _cut(name, when, dest, level = 1) {
    const sound = this.sounds[name];
    if (!sound || this.closed) return null;
    let i = Math.floor(Math.random() * sound.cuts.length);
    if (sound.cuts.length > 1 && i === sound.last) i = (i + 1) % sound.cuts.length;
    sound.last = i;
    const cut = sound.cuts[i];
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = sound.buffer;
    const g = c.createGain();
    const peak = cut.gain * level;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.008);
    g.gain.setValueAtTime(peak, when + Math.max(0.01, cut.length - 0.05));
    g.gain.linearRampToValueAtTime(0.0001, when + cut.length);
    src.connect(g);
    g.connect(dest);
    src.onended = () => this.sources.delete(src);
    src.start(when, cut.start, cut.length);
    this.sources.add(src);
    return [src];
  }

  // Her own steps. `surface` is 'grus' or 'mjukt'; null stops her. `rate` in
  // steps a minute.
  walk(surface, { rate = 100, level = 1 } = {}) {
    if (this.walking) { this.walking.stop(); this.walking = null; }
    // A sound still loading is not a reason to stand still: the loop runs,
    // and its steps are heard from the moment the clip is there.
    if (this.closed || !surface) return;
    const stop = this._loop(() => rate, when => this._cut(surface, when, this.out, level));
    this.walking = { surface, stop };
  }

  hand() {
    if (this.closed) return;
    this._cut('hand', this.ctx.currentTime + 0.05, this.out, 1.4);
  }

  // The other woman. 'near' and 'past' start her walking (if she is not) and
  // move her there over `seconds`; 'stop' halts her where she is, 'go' sets
  // her off again, null takes her away at once.
  _otherChain() {
    const c = this.ctx;
    this.otherGain = c.createGain();
    this.otherGain.gain.value = OTHER.far[0];
    this.otherTone = c.createBiquadFilter();
    this.otherTone.type = 'lowpass';
    this.otherTone.frequency.value = OTHER.far[1];
    this.otherPan = c.createStereoPanner ? c.createStereoPanner() : null;
    this.otherTone.connect(this.otherGain);
    if (this.otherPan) {
      this.otherPan.pan.value = OTHER.far[2];
      this.otherGain.connect(this.otherPan);
      this.otherPan.connect(this.out);
    } else {
      this.otherGain.connect(this.out);
    }
  }

  other(where, seconds = 4) {
    if (this.closed) return;
    const start = () => {
      if (this.otherWalk) return;
      this.otherWalk = this._loop(() => 112, when => this._cut('harda', when, this.otherTone, 1));
    };
    const halt = () => { if (this.otherWalk) { this.otherWalk(); this.otherWalk = null; } };
    if (where === null || where === 'stop') { halt(); return; }
    if (where === 'go') { start(); return; }
    const to = OTHER[where];
    if (!to) return;
    start();
    const now = this.ctx.currentTime;
    const over = Math.max(0.05, seconds);
    this.otherGain.gain.cancelScheduledValues(now);
    this.otherGain.gain.setValueAtTime(Math.max(0.0001, this.otherGain.gain.value), now);
    this.otherGain.gain.exponentialRampToValueAtTime(to[0], now + over);
    this.otherTone.frequency.cancelScheduledValues(now);
    this.otherTone.frequency.setValueAtTime(this.otherTone.frequency.value, now);
    this.otherTone.frequency.exponentialRampToValueAtTime(to[1], now + over);
    if (this.otherPan) {
      this.otherPan.pan.cancelScheduledValues(now);
      this.otherPan.pan.setValueAtTime(this.otherPan.pan.value, now);
      this.otherPan.pan.linearRampToValueAtTime(to[2], now + over);
    }
  }

  // --- the lamp tone -------------------------------------------------------

  // A soft pulse, a fifth, slow. It is a lamp on a desk somewhere, not an
  // alarm: never sharp, never fast.
  tone(on) {
    if (this.toneStop) { this.toneStop(); this.toneStop = null; }
    if (!on || this.closed) return;
    this.toneStop = this._loop(() => 40, when => {
      const c = this.ctx;
      const started = [];
      for (const [freq, level] of [[587.3, 0.16], [880, 0.04]]) {
        const osc = c.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(level, when + 0.14);
        g.gain.setValueAtTime(level, when + 0.5);
        g.gain.linearRampToValueAtTime(0.0001, when + 1.1);
        osc.connect(g);
        g.connect(this.out);
        osc.onended = () => this.sources.delete(osc);
        osc.start(when);
        osc.stop(when + 1.15);
        this.sources.add(osc);
        started.push(osc);
      }
      return started;
    });
  }

  // --- the bell ------------------------------------------------------------

  // Three dull strikes. Goes beside the bus: it is heard while the walker
  // walks, and it must not hang on how much of her side is up.
  bell({ strikes = 3, gap = 2.6 } = {}) {
    if (this.closed) return 0;
    const c = this.ctx;
    const low = c.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 1500;
    low.connect(this.fixed);
    const f0 = 196;
    const partials = [[1, 0.26, 3.6], [2, 0.16, 2.8], [2.4, 0.12, 2.2], [3, 0.07, 1.6], [4.2, 0.04, 1.0]];
    const first = c.currentTime + 0.05;
    for (let n = 0; n < strikes; n++) {
      const when = first + n * gap;
      for (const [ratio, level, decay] of partials) {
        const osc = c.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f0 * ratio;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(level, when + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
        osc.connect(g);
        g.connect(low);
        osc.onended = () => this.sources.delete(osc);
        osc.start(when);
        osc.stop(when + decay + 0.05);
        this.sources.add(osc);
      }
    }
    return (strikes - 1) * gap + 3.6;
  }

  // --- voices on her side --------------------------------------------------

  // Plays a line on her side and resolves when it ends. `kind`:
  //   'snacka' : the flat voice in her ear, thin and a little hollow
  //   'nara'   : someone standing beside her
  //   'annan'  : the other voice, faint
  // A wall-clock watchdog resolves it if the context is suspended and
  // onended never comes, as Mixer.playVoice does.
  say(buffer, kind = 'nara') {
    if (this.closed || !buffer) return Promise.resolve('closed');
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    let head = src;
    const through = (type, freq, q = 0.7) => {
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      head.connect(f);
      head = f;
    };
    if (kind === 'snacka') {
      through('highpass', 480);
      through('lowpass', 2700);
      g.gain.value = 0.5;
      // A copy a few milliseconds late hollows it out: the sound of a small
      // speaker in an ear, and of a voice nobody is behind.
      if (c.createDelay) {
        const late = c.createDelay(0.05);
        late.delayTime.value = 0.0042;
        const lateGain = c.createGain();
        lateGain.gain.value = 0.7;
        head.connect(late);
        late.connect(lateGain);
        lateGain.connect(g);
      }
    } else if (kind === 'annan') {
      through('lowpass', 2500);
      g.gain.value = 0.45;
    } else {
      through('lowpass', 3800);
      g.gain.value = 0.7;
    }
    head.connect(g);
    g.connect(this.out);
    return new Promise(resolve => {
      let done = false;
      const finish = why => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(watchdog);
        this.sources.delete(src);
        resolve(why);
      };
      const watchdog = this.timers.setTimeout(() => finish('timeout'), (buffer.duration + 10) * 1000);
      src.onended = () => finish('ended');
      src.start(c.currentTime);
      this.sources.add(src);
    });
  }

  // --- the end -------------------------------------------------------------

  fade(seconds = 4) {
    if (this.closed) return;
    this.fading = true;
    const now = this.ctx.currentTime;
    for (const g of [this.out.gain, this.fixed.gain]) {
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + seconds);
      } catch (_) {}
    }
  }

  // The walk is over. Every loop stops and every source with it, and a
  // scene still running on can no longer start a sound.
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of [...this.stops]) { try { stop(); } catch (_) {} }
    this.walking = null;
    this.otherWalk = null;
    this.toneStop = null;
    try {
      const now = this.ctx.currentTime;
      for (const g of [this.out.gain, this.fixed.gain]) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.3);
      }
    } catch (_) {}
    for (const src of [...this.sources]) {
      try { src.stop(this.ctx.currentTime + 0.35); } catch (_) {}
    }
    this.sources.clear();
  }
}

// Her side when Web Audio would not build it: nothing sounds, nothing throws.
// `silent` tells the app to send her side's lines down the voice line instead.
export class SilentSide {
  constructor() { this.silent = true; this.pinned = false; }
  setSound() {}
  setPresence() {}
  pin(on) { this.pinned = !!on; }
  lift() {}
  walk() {}
  hand() {}
  other() {}
  tone() {}
  bell() { return 0; }
  say() { return Promise.resolve('silent'); }
  fade() {}
  close() {}
}
