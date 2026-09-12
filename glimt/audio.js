// Web Audio layer. Three paths into one master:
//   bed   : the atmosphere loop, always under, seamless via AudioBufferSource loop
//   fx    : the riser before the first line
//   voice : Vega, through a lowpass filter and a gain that follow contact
//
// Contact 1 is her voice clean and close. Contact 0 is a far, dull murmur:
// the same recording heard through a wall.

const VOICE_FLOOR_HZ = 300;
const VOICE_CEIL_HZ = 18000;

export class Mixer {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
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

    this.contact = 1;
    this.clear = false;
    this.applyContact();
    this.bedSource = null;
  }

  resume() { return this.ctx.resume(); }

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
  // the duration; `at` schedules the start (AudioContext time).
  playVoice(buffer, { clear = false, at = null } = {}) {
    return new Promise(resolve => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.voiceFilter);
      if (clear) { this.clear = true; this.applyContact(); }
      src.onended = () => {
        if (clear) { this.clear = false; this.applyContact(); }
        resolve();
      };
      src.start(at === null ? this.ctx.currentTime : at);
      this.currentVoice = src;
    });
  }

  setContact(value) {
    this.contact = Math.min(1, Math.max(0, value));
    this.applyContact();
  }

  applyContact() {
    const c = this.clear ? 1 : this.contact;
    const freq = VOICE_FLOOR_HZ * Math.pow(VOICE_CEIL_HZ / VOICE_FLOOR_HZ, c);
    const gain = 0.25 + 0.75 * Math.pow(c, 0.7);
    const now = this.ctx.currentTime;
    this.voiceFilter.frequency.setTargetAtTime(freq, now, 0.4);
    this.voiceGain.gain.setTargetAtTime(gain, now, 0.4);
  }

  fadeOut(seconds = 4) {
    const now = this.ctx.currentTime;
    for (const g of [this.bedGain.gain, this.voiceGain.gain]) {
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
