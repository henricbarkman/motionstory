// Web Audio layer. Three paths into one master:
//   bed   : the atmosphere loop, always under, seamless via AudioBufferSource loop
//   fx    : the riser before the first line
//   voice : Vega, through the line (the radio stage, below) and then a
//           lowpass filter and a gain that follow contact.
//   song  : episode 1's opening credits. Straight to the master at full
//           level, past the line and the contact: the song is the song, not
//           music under a scene (Henric 21/10). In English it starts faint
//           under her last line and grows once she has finished (playSong).
//
// The radio stage is the line itself (Henric 2026-10-17: a light radio on her
// voice all the time, clearer further on in the story). One knob, klarhet,
// 0 = the whole radio, 1 = her voice clean: a band (highpass + lowpass) and a
// light saturation. Beside it a faint hiss that lies only under her lines,
// never in the silence, with a knob of its own, brus (setBrus): until v47 it
// followed klarhet, so the English episode hissed under every line, and least
// at the start, where the contact's lowpass took most of it (Henric 29/10:
// "för mycket brus ... muffled alldeles i början och med brus, men sen bara
// med en radioeffekt på"). The contact filter sits after both, so a stop
// dulls her exactly as before, on top of the radio.
//
// Contact 1 is her voice clean and close. Contact 0 is a far, dull murmur:
// the same recording heard through a wall.

const VOICE_FLOOR_HZ = 300;
// The credits' song. The Code's credits cut measures -16.9 LUFS with its true
// peak at -3.5 dBFS, her lines -15 to -16: +2.5 dB puts the song at a
// released track's level and keeps its peak a dB under full scale.
const SONG_GAIN = 1.33;
// The English episode starts the song under her last line (Henric 23/10:
// faint under it, full once she has finished). Its share of SONG_GAIN while
// she speaks, and the seconds it takes to grow to full after.
export const SONG_UNDER = 0.2;
export const SONG_RISE = 3;
const VOICE_CEIL_HZ = 18000;
// A line she says to herself (Henric 2026-10-16: lower, turned away from the
// line): never clearer than this contact, and at this share of the level.
const ASIDE_CONTACT = 0.7;
const ASIDE_GAIN = 0.7;
// The radio at klarhet 0. Each part eases to nothing on the way to 1:
// the band's edges on a log scale, the drive in proportion.
const RADIO_LOW_HZ = 700;      // highpass at full radio (20 Hz when clean)
const RADIO_HIGH_HZ = 2800;    // lowpass at full radio (20 kHz when clean)
const RADIO_DRIVE = 3;         // waveshaper tanh(kx), k = 1 + RADIO_DRIVE at full radio
export const RADIO_HISS = 0.03; // hiss level at brus 1 (the whole radio's), under her lines only
const RADIO_HISS_HZ = 3000;    // the hiss's band
// A line ended early, at a pause between two of her sentences (episode 1: a
// walker who goes while she asks them to). The fade is short and lies wholly
// in the silence, which check_glimt_audio.py measured with a margin either
// side; LEAD is what the audio thread is given to act on it in time.
export const BREAK_FADE = 0.03;   // s
export const BREAK_LEAD = 0.05;   // s

// Where a line `into` seconds in ends early: the first of `breaks` ([{from,
// to}], seconds into the line where it is silent) it can still reach with
// the fade inside it, at its start or at once if the line is in it already.
// Null when none is left ahead. The tests' episode uses it too.
export function breakAt(breaks, into) {
  const b = (breaks || []).find(x => x.to - BREAK_FADE >= Math.max(x.from, into));
  return b ? { ...b, at: Math.max(b.from, into) } : null;
}

// How clear the line is, as a link writes it: a number from 0 (the whole
// radio) to 1 (clean), clamped. A decimal comma (?klarhet=0,5, as a Swede
// types it) reads as a point; parseFloat alone read it as 0. Null when there
// is nothing to read.
export function readKlarhet(raw) {
  const t = raw == null ? '' : String(raw).trim().replace(',', '.');
  if (!t) return null;
  const k = Number(t);   // the whole value or nothing: '1,2,3' is no level
  return Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : null;
}

// The hiss under line `id`, as [at its start, at `until` seconds in or at
// its end (null)], in units of the whole radio's hiss. A chapter with "brus"
// names the lines that have it, each a level or [from, to] or [from, to,
// seconds], and every other line has none (the English episode 1, v48: only
// her first two lines, while the contact is found). A chapter without it
// hisses as much as its radio, 1 - klarhet, under every line, as before v48.
export function brusOf(brus, id, klarhet) {
  if (!brus) { const b = 1 - Math.min(1, Math.max(0, Number(klarhet))); return [b, b, null]; }
  const b = brus[id];
  if (b === undefined) return [0, 0, null];
  if (!Array.isArray(b)) return [b, b, null];
  return [b[0], b[1] ?? b[0], b[2] ?? null];
}

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

    this.songGain = c.createGain();
    this.songGain.gain.value = SONG_GAIN;
    this.songGain.connect(this.master);

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
    // The hiss: a noise loop through a band, at the line's level (hissLevel,
    // setBrus), and open only while a line plays (hissGain, hiss()).
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
    this.hissLevel = c.createGain();
    this.hissLevel.gain.value = 0;
    this.hissGain = c.createGain();
    this.hissGain.gain.value = 0;
    this.hissSource.connect(hissBand);
    hissBand.connect(this.hissLevel);
    this.hissLevel.connect(this.hissGain);
    this.hissGain.connect(this.voiceFilter);
    this.hissSource.start();
    this.voicesOn = 0;
    this.klarhet = null;
    this.brus = 0;
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
  }

  // How much hiss lies under the next line, in units of the whole radio's:
  // `from` as it starts (`at`, AudioContext time, else now), easing in a
  // straight line to `to` over `seconds` (none: it stays at `from`). Set
  // before playVoice; the next line's call replaces what is left of it.
  setBrus(from, to = from, { at = null, seconds = 0 } = {}) {
    // A level that is no number is no hiss, never a thrown line (review of v48).
    const level = x => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
    from = level(from);
    to = level(to);
    const g = this.hissLevel.gain;
    const now = this.ctx.currentTime;
    const when = Math.max(now, at === null ? now : at);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setValueAtTime(RADIO_HISS * from, when);
    if (seconds > 0 && to !== from) g.linearRampToValueAtTime(RADIO_HISS * to, when + seconds);
    this.brus = from;
  }

  // The hiss as heard now: its level, open or closed (tests and the console).
  hissNow() { return this.hissLevel.gain.value * this.hissGain.gain.value; }

  // The hiss comes in with a line on the radio and goes when the last ends.
  hiss(on, at = null) {
    this.voicesOn = Math.max(0, this.voicesOn + (on ? 1 : -1));
    const now = this.ctx.currentTime;
    const when = Math.max(now, at === null ? 0 : at);
    // A line cut before its scheduled start must not leave its "on" pending.
    const g = this.hissGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(this.voicesOn > 0 ? 1 : 0, when, on ? 0.08 : 0.15);
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
  // herself; `at` schedules the start (AudioContext time); `song` plays it
  // as the credits' song, off the line and the contact.
  //
  // A wall-clock watchdog resolves the promise even if the AudioContext is
  // suspended (screen off without a wake lock) and onended never fires, so
  // the chapter cannot stall on one line. It resolves 'timeout' in that case
  // so the log shows what happened.
  playVoice(buffer, { clear = false, aside = false, at = null, song = false } = {}) {
    const radio = !song;
    return new Promise(resolve => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      // Its own gain, so a line ended at a pause fades without touching the next.
      const level = this.ctx.createGain();
      src.connect(level);
      level.connect(song ? this.songGain : this.radioIn);
      this.route = song ? 'song' : 'radio';   // what the last sound was sent through, for the tests
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
      src.onended = () => finish(src.endsAtBreak ? 'break' : 'ended');
      src.start(startAt);
      src.level = level;
      src.startedAt = startAt;
      this.currentVoice = src;
    });
  }

  // The credits' song under a line (the English episode 1): its own source,
  // so the line playing is still the current voice and nothing cuts the song
  // but the end of the walk. Starts at `at` (AudioContext time) at `share` of
  // the song's level. Returns `done`, a promise of how it ended as playVoice's
  // does, and `rise(seconds)`, which brings it to full.
  playSong(buffer, { at = null, share = SONG_UNDER } = {}) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const level = c.createGain();
    const startAt = Math.max(c.currentTime, at === null ? 0 : at);
    level.gain.setValueAtTime(share, startAt);
    src.connect(level);
    level.connect(this.songGain);
    const done = new Promise(resolve => {
      let over = false;
      const finish = why => {
        if (over) return;
        over = true;
        clearTimeout(watchdog);
        resolve(why);
      };
      const lead = Math.max(0, startAt - c.currentTime);
      const watchdog = setTimeout(() => finish('timeout'), (lead + buffer.duration + 10) * 1000);
      src.onended = () => finish('ended');
    });
    src.start(startAt);
    this.song = src;
    return {
      done,
      startedAt: startAt,
      rise(seconds = SONG_RISE) {
        const now = Math.max(c.currentTime, startAt);
        level.gain.cancelScheduledValues(now);
        level.gain.setValueAtTime(share, now);
        level.gain.linearRampToValueAtTime(1, now + seconds);
      },
    };
  }

  // Stops the song playSong started, if it still plays (the walk's end).
  stopSong() {
    if (this.song) {
      try { this.song.stop(); } catch (_) {}
      this.song = null;
    }
  }

  // Cuts whatever line is playing. onended fires, so the pending play resolves.
  stopVoice() {
    if (this.currentVoice) {
      try { this.currentVoice.stop(); } catch (_) {}
      this.currentVoice = null;
    }
  }

  // Ends the line playing at a pause between two of her sentences (breakAt),
  // fading inside it, so the word before is whole and nothing clicks.
  // Returns the break, or null when none is left ahead and the line plays to
  // its end. playVoice then resolves 'break'.
  endVoiceAtBreak(breaks) {
    const src = this.currentVoice;
    if (!src) return null;
    if (src.endsAtBreak) return src.endsAtBreak;
    const b = breakAt(breaks, this.ctx.currentTime + BREAK_LEAD - src.startedAt);
    if (!b) return null;
    const endAt = src.startedAt + b.at;
    const g = src.level.gain;
    g.setValueAtTime(1, endAt);
    g.linearRampToValueAtTime(0, endAt + BREAK_FADE);
    try { src.stop(endAt + BREAK_FADE); } catch (_) { return null; }
    src.endsAtBreak = b;
    return b;
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
    for (const g of [this.bedGain.gain, this.voiceGain.gain, this.hissGain.gain, this.songGain.gain]) {
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
