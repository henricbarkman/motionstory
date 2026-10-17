// Web Audio layer. Three paths into one master:
//   bed   : the atmosphere loop, always under, seamless via AudioBufferSource loop
//   fx    : the riser before the first line
//   voice : Vega, through the line (the radio stage, below) and then a
//           lowpass filter and a gain that follow contact. Episode 1's opening
//           credits come down the contact path but not the radio: the song is
//           heard through the line and goes dull with her voice, and still
//           sounds like the song.
//
// The radio stage is the line itself (Henric 2026-10-17: a light radio on her
// voice all the time, clearer further on in the story). One knob, klarhet,
// 0 = the whole radio, 1 = her voice clean: a band (highpass + lowpass), a
// light saturation and a faint hiss that lies only under her lines, never in
// the silence. The contact filter sits after it, so a stop dulls her exactly
// as before, on top of the radio.
//
// Contact 1 is her voice clean and close. Contact 0 is a far, dull murmur:
// the same recording heard through a wall.

const VOICE_FLOOR_HZ = 300;
const VOICE_CEIL_HZ = 18000;
// A line she says to herself (Henric 2026-10-16: lower, turned away from the
// line): never clearer than this contact, and at this share of the level.
const ASIDE_CONTACT = 0.7;
const ASIDE_GAIN = 0.7;
// The radio at klarhet 0. Each part eases to nothing on the way to 1:
// the band's edges on a log scale, the drive and the hiss in proportion.
const RADIO_LOW_HZ = 700;      // highpass at full radio (20 Hz when clean)
const RADIO_HIGH_HZ = 2800;    // lowpass at full radio (20 kHz when clean)
const RADIO_DRIVE = 3;         // waveshaper tanh(kx), k = 1 + RADIO_DRIVE at full radio
const RADIO_HISS = 0.03;       // hiss level at full radio, under her lines only
const RADIO_HISS_HZ = 3000;    // the hiss's band

export class Mixer {
  // `ctx` for an offline render of the same chain (scripts' listening tests).
  constructor(ctx = null) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = ctx || new Ctx();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.connect(c.destination);

    this.bedGain = c.createGain();
    this.bedGain.gain.value = 0;
    this.bedGain.connect(this.master);

    this.fxGain = c.createGain();
    this.fxGain.gain.value = 0.7;   // -3 dB
    this.fxGain.connect(this.master);

    this.voiceFilter = c.createBiquadFilter();
    this.voiceFilter.type = 'lowpass';
    this.voiceFilter.Q.value = 0.7;
    this.voiceGain = c.createGain();
    this.voiceFilter.connect(this.voiceGain);
    this.voiceGain.connect(this.master);

    // The radio stage, in front of the contact filter.
    this.radioIn = c.createGain();
    this.radioHp = c.createBiquadFilter();
    this.radioHp.type = 'highpass';
    this.radioHp.Q.value = 0.7;
    this.radioLp = c.createBiquadFilter();
    this.radioLp.type = 'lowpass';
    this.radioLp.Q.value = 0.7;
    this.radioShape = c.createWaveShaper();
    this.radioShape.oversample = '2x';
    this.radioMakeup = c.createGain();
    this.radioIn.connect(this.radioHp);
    this.radioHp.connect(this.radioLp);
    this.radioLp.connect(this.radioShape);
    this.radioShape.connect(this.radioMakeup);
    this.radioMakeup.connect(this.voiceFilter);
    // The hiss: a noise loop through a band, silent until a line plays.
    const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.hissSource = c.createBufferSource();
    this.hissSource.buffer = noise;
    this.hissSource.loop = true;
    const hissBand = c.createBiquadFilter();
    hissBand.type = 'bandpass';
    hissBand.frequency.value = RADIO_HISS_HZ;
    hissBand.Q.value = 0.6;
    this.hissGain = c.createGain();
    this.hissGain.gain.value = 0;
    this.hissSource.connect(hissBand);
    hissBand.connect(this.hissGain);
    this.hissGain.connect(this.voiceFilter);
    this.hissSource.start();
    this.voicesOn = 0;
    this.klarhet = null;
    this.setKlarhet(1);

    this.contact = 1;
    this.clear = false;
    this.aside = false;
    this.applyContact();
    this.bedSource = null;
    this.bedShare = 1;
    this.bedMuted = false;
  }

  resume() { return this.ctx.resume(); }

  // How clear the line is: 0 the whole radio, 1 her voice clean.
  setKlarhet(value) {
    const k = Math.min(1, Math.max(0, Number(value)));
    if (!Number.isFinite(k) || k === this.klarhet) return;
    this.klarhet = k;
    const r = 1 - k;
    const now = this.ctx.currentTime;
    this.radioHp.frequency.setTargetAtTime(20 * Math.pow(RADIO_LOW_HZ / 20, r), now, 0.05);
    this.radioLp.frequency.setTargetAtTime(20000 * Math.pow(RADIO_HIGH_HZ / 20000, r), now, 0.05);
    // tanh(kx)/tanh(k) rounds the peaks and lifts quiet speech (its slope
    // at 0 is k/tanh(k), taken back by tanh(k)/k). The band takes away most
    // of her voice's energy as it narrows; the second term gives it back, a
    // fit to loudness measured offline on her lines (2026-10-17), so she is
    // about as loud on the line as off it at every klarhet.
    const drive = 1 + RADIO_DRIVE * r;
    if (r < 0.01) {
      this.radioShape.curve = null;
      this.radioMakeup.gain.value = 1;
    } else {
      const n = 2048, curve = new Float32Array(n), t = Math.tanh(drive);
      for (let i = 0; i < n; i++) curve[i] = Math.tanh(drive * (i / (n - 1) * 2 - 1)) / t;
      this.radioShape.curve = curve;
      // Never past full scale: the curve peaks at 1 (only near klarhet 0 would it).
      this.radioMakeup.gain.value = Math.min(1, (t / drive) * Math.pow(10, (16 * r ** 4 + 1.5 * r * (1 - r)) / 20));
    }
    this.hissLevel = RADIO_HISS * r;
    if (this.voicesOn > 0) this.hissGain.gain.setTargetAtTime(this.hissLevel, now, 0.05);
  }

  // The hiss comes in with a line on the radio and goes when the last ends.
  hiss(on, at = null) {
    this.voicesOn = Math.max(0, this.voicesOn + (on ? 1 : -1));
    const now = this.ctx.currentTime;
    const when = Math.max(now, at === null ? 0 : at);
    // A line cut before its scheduled start must not leave its "on" pending.
    const g = this.hissGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(this.voicesOn > 0 ? this.hissLevel : 0, when, on ? 0.08 : 0.15);
  }

  async fetchBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.arrayBuffer();
  }

  // decodeAudioData detaches its input, so callers keep the ArrayBuffer and
  // hand over a copy when a line is about to play.
  decode(arrayBuffer) {
    return this.ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  startBed(buffer, { gain = 0.32, fadeIn = 2 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.bedGain);
    const now = this.ctx.currentTime;
    this.bedGain.gain.setValueAtTime(0, now);
    this.bedGain.gain.linearRampToValueAtTime(gain, now + fadeIn);
    src.start(now);
    this.bedSource = src;
    this.bedLevel = gain;
  }

  // Steps the bed back under another layer (episode 1: her side) and brings
  // it up again. `share` is of the level the bed started at.
  setBed(share, seconds = 0.5) {
    this.bedShare = share;
    this.applyBed(seconds);
  }

  // Takes the bed away while a song plays over the line (episode 1's
  // credits), whatever share her side has asked for, and brings it back.
  muteBed(on, seconds = 1) {
    this.bedMuted = !!on;
    this.applyBed(seconds);
  }

  applyBed(seconds) {
    if (this.bedLevel === undefined || this.fading) return;
    const now = this.ctx.currentTime;
    this.bedGain.gain.cancelScheduledValues(now);
    this.bedGain.gain.setTargetAtTime(this.bedMuted ? 0 : this.bedLevel * this.bedShare, now, seconds);
  }

  // Plays a one-shot through the fx path. Returns the AudioContext time it
  // started so the caller can line the voice up against it.
  playFx(buffer, { at = 0 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.fxGain);
    const start = this.ctx.currentTime + at;
    src.start(start);
    return start;
  }

  // Plays a voice line. Resolves when it ends. `clear` overrides contact for
  // the duration; `aside` holds it lower and duller, a line she says to
  // herself; `at` schedules the start (AudioContext time); `radio` false
  // keeps it off the line (the credits' song).
  //
  // A wall-clock watchdog resolves the promise even if the AudioContext is
  // suspended (screen off without a wake lock) and onended never fires, so
  // the chapter cannot stall on one line. It resolves 'timeout' in that case
  // so the log shows what happened.
  playVoice(buffer, { clear = false, aside = false, at = null, radio = true } = {}) {
    return new Promise(resolve => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(radio ? this.radioIn : this.voiceFilter);
      if (clear) { this.clear = true; this.applyContact(); }
      if (aside) { this.aside = true; this.applyContact(); }
      const startAt = at === null ? this.ctx.currentTime : at;
      if (radio) this.hiss(true, startAt);
      const lead = Math.max(0, startAt - this.ctx.currentTime);
      let done = false;
      const finish = why => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        if (clear) { this.clear = false; this.applyContact(); }
        if (aside) { this.aside = false; this.applyContact(); }
        if (radio) this.hiss(false);
        if (this.currentVoice === src) this.currentVoice = null;
        resolve(why);
      };
      const watchdog = setTimeout(() => finish('timeout'), (lead + buffer.duration + 10) * 1000);
      src.onended = () => finish('ended');
      src.start(startAt);
      this.currentVoice = src;
    });
  }

  // Cuts whatever line is playing. onended fires, so the pending play resolves.
  stopVoice() {
    if (this.currentVoice) {
      try { this.currentVoice.stop(); } catch (_) {}
      this.currentVoice = null;
    }
  }

  setContact(value) {
    this.contact = Math.min(1, Math.max(0, value));
    this.applyContact();
  }

  applyContact() {
    let c = this.clear ? 1 : this.contact;
    if (this.aside) c = Math.min(c, ASIDE_CONTACT);
    const freq = VOICE_FLOOR_HZ * Math.pow(VOICE_CEIL_HZ / VOICE_FLOOR_HZ, c);
    const gain = (0.25 + 0.75 * Math.pow(c, 0.7)) * (this.aside ? ASIDE_GAIN : 1);
    const now = this.ctx.currentTime;
    this.voiceFilter.frequency.setTargetAtTime(freq, now, 0.4);
    this.voiceGain.gain.setTargetAtTime(gain, now, 0.4);
  }

  fadeOut(seconds = 4) {
    this.fading = true;
    const now = this.ctx.currentTime;
    for (const g of [this.bedGain.gain, this.voiceGain.gain, this.hissGain.gain]) {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + seconds);
    }
    return new Promise(r => setTimeout(r, seconds * 1000));
  }

  // The other voice at the very end: faint, far, after everything has faded.
  playQuiet(buffer) {
    const now = this.ctx.currentTime;
    this.voiceFilter.frequency.cancelScheduledValues(now);
    this.voiceFilter.frequency.setValueAtTime(2500, now);
    this.voiceGain.gain.cancelScheduledValues(now);
    this.voiceGain.gain.setValueAtTime(0.3, now);
    return new Promise(resolve => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.voiceFilter);
      src.onended = resolve;
      src.start(now);
    });
  }
}

// Fetches every line of a chapter up front (cheap: compressed bytes) and
// decodes on demand.
export class Library {
  constructor(mixer, baseUrl) {
    this.mixer = mixer;
    this.baseUrl = baseUrl;
    this.raw = new Map();
    this.loading = new Map();
    this.missing = new Set();
  }

  load(id) {
    if (this.raw.has(id)) return Promise.resolve(this.raw.get(id));
    if (!this.loading.has(id)) {
      const p = this.mixer.fetchBuffer(`${this.baseUrl}/${id}.mp3`).then(buf => {
        if (buf) this.raw.set(id, buf); else this.missing.add(id);
        return buf;
      }).catch(() => { this.missing.add(id); return null; });
      this.loading.set(id, p);
    }
    return this.loading.get(id);
  }

  loadAll(ids) {
    return Promise.all(ids.map(id => this.load(id)));
  }

  async buffer(id) {
    const raw = await this.load(id);
    if (!raw) return null;
    return this.mixer.decode(raw);
  }
}
