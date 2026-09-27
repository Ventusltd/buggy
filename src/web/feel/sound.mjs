// sound.mjs: an engine note, off by default. Nothing audio is created until the viewer turns sound on (N), which is
// also the user gesture browsers require. The note is a pure function of the drive state; update() changes the audio
// only when the note moves by more than a small step, and a parked buggy produces no updates at all.

export const NOTE = Object.freeze({ idleHz: 55, perMs: 9, loadHz: 25, maxHz: 320, idleGain: 0.03, loadGain: 0.07, stepHz: 1 });

export function engineNote({ speed = 0, drive = 0 } = {}) {
  const hz = Math.min(NOTE.maxHz, NOTE.idleHz + NOTE.perMs * Math.abs(speed) + NOTE.loadHz * Math.abs(drive));
  return { hz: Math.round(hz * 10) / 10, gain: Math.round((NOTE.idleGain + NOTE.loadGain * Math.abs(drive)) * 1000) / 1000 };
}

// audio: a factory returning an AudioContext-like object; injected for tests.
export function createSound({ audio = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() } = {}) {
  let on = false, ctx = null, osc = null, amp = null, lastHz = -1;
  const self = {
    get on() { return on; },
    get created() { return !!ctx; },
    toggle() { return self.set(!on); },
    set(v) {
      on = !!v;
      if (on && !ctx) {
        ctx = audio();
        osc = ctx.createOscillator(); amp = ctx.createGain();
        osc.type = 'sawtooth'; amp.gain.value = 0;
        osc.connect(amp); amp.connect(ctx.destination); osc.start();
      }
      if (ctx) { if (on) ctx.resume?.(); else { amp.gain.value = 0; ctx.suspend?.(); } }
      lastHz = -1;
      return on;
    },
    // Returns true when the audio graph was touched.
    update(state) {
      if (!on || !ctx) return false;
      const n = engineNote(state);
      if (Math.abs(n.hz - lastHz) < NOTE.stepHz) return false;
      lastHz = n.hz; osc.frequency.value = n.hz; amp.gain.value = n.gain;
      return true;
    },
    close() { if (ctx) { ctx.close?.(); ctx = osc = amp = null; } on = false; }
  };
  return self;
}
