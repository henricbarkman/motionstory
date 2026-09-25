// Placeholder sounds for the lab, made in the phone with Web Audio. Every one
// of them is meant to be replaced by Henric's own once a mechanic has earned
// its place; until then they only need to say what they are.
//
//   footsteps : someone walking, closer or further (Flykten, Spöket)
//   beat      : a soft kick on the beat (Takten)
//   staticNoise : radio hiss over the line (Stämma linjen, Gå normalt)
//   pad       : a D minor chord that fades in when something is right (Takten)
//   passing   : something large going by, left to right (Frys)
//   chime     : a short tone placed left or right (Ljudkompassen)
//
// Each returns a handle with set(...) and stop(). All of them go to the
// mixer's master, beside the voice, so contact never muffles them: they are
// in the walker's world, not on the line.

// `timers` is for the simulation, which runs the real Synth on a fake clock.
export class Synth {
  constructor(mixer, timers = globalThis) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.timers = timers;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(mixer.master);
    this.noise = this._noiseBuffer(2);
    this.live = new Set();
    this.closed = false;
  }

  // The walk is over. Everything stops, and a station still running on (the
  // stop button lets its waits end) can no longer start a sound: a review
  // found a chime created after the stop that pinged until the tab closed.
  close() {
    this.closed = true;
    this.stopAll();
  }

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _track(handle) {
    this.live.add(handle);
    const stop = handle.stop;
    let stopped = false;
    handle.stop = (...a) => {
      if (stopped) return;
      stopped = true;
      this.live.delete(handle);
      stop(...a);
    };
    return handle;
  }

  stopAll() { for (const h of [...this.live]) h.stop(); }

  _later(fn, ms) { this.timers.setTimeout(fn, ms); }

  // A scheduler that calls `hit(time)` at a steady rate, looking a little
  // ahead so the timing does not depend on setInterval's jitter. After a
  // gap (a backgrounded tab throttles intervals to once a second or less)
  // it starts again from now instead of catching up a burst of beats.
  _loop(rateFn, hit) {
    const ctx = this.ctx;
    let next = ctx.currentTime + 0.1;
    let stopped = false;
    const id = this.timers.setInterval(() => {
      if (stopped) return;
      const rate = rateFn();
      if (!(rate > 0)) { next = ctx.currentTime + 0.1; return; }
      if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
      while (next < ctx.currentTime + 0.25) {
        hit(next);
        next += 60 / rate;
      }
    }, 50);
    return () => { stopped = true; this.timers.clearInterval(id); };
  }

  // Footsteps: a short thud of filtered noise per step. `distance` in metres
  // sets loudness and dullness; `rate` is steps a minute.
  footsteps({ rate = 110, distance = 30, pan = 0 } = {}) {
    if (this.closed) return SILENT;
    const ctx = this.ctx;
    const later = (fn, ms) => this._later(fn, ms);
    const state = { rate, distance, pan };
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const gain = ctx.createGain();
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.out);
    let odd = false;
    const apply = () => {
      const d = Math.max(1, state.distance);
      const now = ctx.currentTime;
      gain.gain.setTargetAtTime(Math.min(0.9, 6 / d), now, 0.3);
      filter.frequency.setTargetAtTime(Math.max(250, 2400 - d * 25), now, 0.3);
      panner.pan.setTargetAtTime(state.pan, now, 0.3);
    };
    apply();
    const stopLoop = this._loop(() => state.rate, time => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const env = ctx.createGain();
      src.connect(env);
      env.connect(filter);
      odd = !odd;
      const peak = odd ? 1 : 0.8;
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(peak, time + 0.006);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
      src.start(time, Math.random() * 1.5, 0.15);
    });
    return this._track({
      set(o) { Object.assign(state, o); apply(); },
      stop() { stopLoop(); gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2); later(() => panner.disconnect(), 800); },
    });
  }

  // A soft kick on each beat.
  beat({ bpm = 110, gain = 0.5 } = {}) {
    if (this.closed) return SILENT;
    const ctx = this.ctx;
    const later = (fn, ms) => this._later(fn, ms);
    const state = { bpm };
    const g = ctx.createGain();
    g.gain.value = gain;
    g.connect(this.out);
    const beats = [];
    const stopLoop = this._loop(() => state.bpm, time => {
      beats.push(time);
      if (beats.length > 64) beats.shift();
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.frequency.setValueAtTime(130, time);
      osc.frequency.exponentialRampToValueAtTime(48, time + 0.12);
      env.gain.setValueAtTime(0.0001, time);
      env.gain.exponentialRampToValueAtTime(1, time + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
      osc.connect(env);
      env.connect(g);
      osc.start(time);
      osc.stop(time + 0.25);
    });
    return this._track({
      beats,
      set(o) { Object.assign(state, o); },
      stop() { stopLoop(); g.gain.setTargetAtTime(0, ctx.currentTime, 0.1); later(() => g.disconnect(), 600); },
    });
  }

  // Hiss over the line. level 0..1.
  staticNoise({ level = 0 } = {}) {
    if (this.closed) return SILENT;
    const ctx = this.ctx;
    const later = (fn, ms) => this._later(fn, ms);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2200;
    band.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(band);
    band.connect(g);
    g.connect(this.out);
    src.start();
    const apply = level => g.gain.setTargetAtTime(0.22 * Math.min(1, Math.max(0, level)), ctx.currentTime, 0.25);
    apply(level);
    return this._track({
      set({ level }) { apply(level); },
      stop() { g.gain.setTargetAtTime(0, ctx.currentTime, 0.2); later(() => { try { src.stop(); } catch (_) {} }, 800); },
    });
  }

  // D minor, the key of the bed loop. level 0..1.
  pad({ level = 0 } = {}) {
    if (this.closed) return SILENT;
    const ctx = this.ctx;
    const later = (fn, ms) => this._later(fn, ms);
    const g = ctx.createGain();
    g.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(g);
    g.connect(this.out);
    const oscs = [146.83, 174.61, 220.0, 293.66].flatMap(f => [-4, 4].map(cents => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = cents;
      o.connect(lp);
      o.start();
      return o;
    }));
    const apply = level => g.gain.setTargetAtTime(0.05 * Math.min(1, Math.max(0, level)), ctx.currentTime, 0.8);
    apply(level);
    return this._track({
      set({ level }) { apply(level); },
      stop() { g.gain.setTargetAtTime(0, ctx.currentTime, 0.5); later(() => oscs.forEach(o => { try { o.stop(); } catch (_) {} }), 2500); },
    });
  }

  // Something large going by: a swell of low noise moving from left to right
  // over `seconds`. Resolves when it has passed.
  passing({ seconds = 14 } = {}) {
    if (this.closed) return Promise.resolve();
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const g = ctx.createGain();
    const panner = ctx.createStereoPanner();
    src.connect(lp);
    lp.connect(g);
    g.connect(panner);
    panner.connect(this.out);
    const now = ctx.currentTime;
    const mid = now + seconds / 2;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, mid);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    lp.frequency.setValueAtTime(200, now);
    lp.frequency.linearRampToValueAtTime(700, mid);
    lp.frequency.linearRampToValueAtTime(200, now + seconds);
    panner.pan.setValueAtTime(-0.9, now);
    panner.pan.linearRampToValueAtTime(0.9, now + seconds);
    src.start(now);
    src.stop(now + seconds + 0.1);
    // Stopped early (the station ended mid-swell): fade, do not click.
    const handle = this._track({
      set() {},
      stop() {
        const t = ctx.currentTime;
        // Hold the swell where it is; a plain cancel drops it to the last
        // set value and clicks.
        if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t);
        else { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); }
        g.gain.setTargetAtTime(0, t, 0.15);
        try { src.stop(t + 0.8); } catch (_) {}
      },
    });
    return new Promise(resolve => { src.onended = () => { this.live.delete(handle); resolve(); }; });
  }

  // A repeating short tone, placed by `pan` (-1 left .. 1 right). `behind`
  // dulls it, `distance` in metres slows the repeats as it gets further.
  chime({ pan = 0, behind = false, distance = 100 } = {}) {
    if (this.closed) return SILENT;
    const ctx = this.ctx;
    const later = (fn, ms) => this._later(fn, ms);
    const state = { pan, behind, distance };
    const panner = ctx.createStereoPanner();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const g = ctx.createGain();
    g.gain.value = 0.35;
    lp.connect(g);
    g.connect(panner);
    panner.connect(this.out);
    const apply = () => {
      const now = ctx.currentTime;
      panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, state.pan)), now, 0.15);
      lp.frequency.setTargetAtTime(state.behind ? 900 : 6000, now, 0.3);
    };
    apply();
    // One ping a second close by, one every three seconds far away.
    const rate = () => 60 / Math.min(3, Math.max(0.8, state.distance / 60));
    const stopLoop = this._loop(rate, time => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      env.gain.setValueAtTime(0.0001, time);
      env.gain.exponentialRampToValueAtTime(1, time + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, time + 0.6);
      osc.connect(env);
      env.connect(lp);
      osc.start(time);
      osc.stop(time + 0.65);
    });
    return this._track({
      set(o) { Object.assign(state, o); apply(); },
      stop() { stopLoop(); g.gain.setTargetAtTime(0, ctx.currentTime, 0.2); later(() => panner.disconnect(), 800); },
    });
  }
}

const SILENT = { beats: [], set() {}, stop() {} };

// Stand-in for a browser without Web Audio: same shape, silent.
export class SilentSynth {
  footsteps() { return { set() {}, stop() {} }; }
  beat() { return { beats: [], set() {}, stop() {} }; }
  staticNoise() { return { set() {}, stop() {} }; }
  pad() { return { set() {}, stop() {} }; }
  passing() { return Promise.resolve(); }
  chime() { return { set() {}, stop() {} }; }
  stopAll() {}
  close() {}
}
