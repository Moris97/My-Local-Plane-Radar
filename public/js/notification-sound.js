// Hand-written WebAudio tones for the on-map notification alert sound
// (TODO.md's "Audio alert tone for on-map notifications") -- no audio file,
// no dependency, same "a few dozen lines" bias as the rest of this app's
// hand-rolled bits (chart.js's SVG renderers, mqtt-client.js). Picked from
// Settings -> Notifications (settings-state.js's notificationSound,
// SOUND_OPTIONS in settings.js) and played from
// notifications-ui.js's handleNotificationEvent, gated there on the tab
// actually being visible and the setting not being 'none' (the default).

// Lazy singleton: browsers refuse to produce sound from an AudioContext
// that wasn't created/resumed inside a user-gesture handler, so this is
// only ever constructed the first time a play*() call actually runs (a
// button click), never at module load.
let ctx = null;
function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// One oscillator + a linear-attack/exponential-decay gain envelope, the
// building block every preset below is made of. exponentialRampToValueAtTime
// can't target exactly 0 (it's a divide-by-zero in the ramp math), hence
// 0.0001 -- inaudible, and avoids the audible "click" a hard stop at a
// non-zero gain would otherwise produce.
function tone(audioCtx, { frequency, startTime, duration, type = 'sine', peakGain = 0.25, attack = 0.01 }) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// A short upward frequency sweep instead of a fixed pitch -- its own helper
// since tone() above assumes one constant frequency.
function sweep(audioCtx, { from, to, startTime, duration, type = 'sine', peakGain = 0.25, attack = 0.01 }) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, startTime);
  osc.frequency.exponentialRampToValueAtTime(to, startTime + duration);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// Five candidates, deliberately different in character -- pick one, the
// rest can be deleted once a choice is made. Each is self-contained (one
// audioCtx.currentTime-based schedule), so playing one while another is
// still ringing never conflicts, they just layer.
export const SOUND_PRESETS = {
  // A soft two-note ascending chime (C6 -> E6) -- gentle, doorbell-like.
  chime(audioCtx) {
    const t0 = audioCtx.currentTime;
    tone(audioCtx, { frequency: 1046.5, startTime: t0, duration: 0.16, peakGain: 0.22 });
    tone(audioCtx, { frequency: 1318.5, startTime: t0 + 0.13, duration: 0.24, peakGain: 0.22 });
  },

  // A single short, bright ping -- the least intrusive option, closest to a
  // generic "notification" sound.
  ping(audioCtx) {
    const t0 = audioCtx.currentTime;
    tone(audioCtx, { frequency: 1568, startTime: t0, duration: 0.2, peakGain: 0.2, attack: 0.005 });
  },

  // Two quick square-wave beeps -- the most classic "alert" sound of the
  // five, closest to a traditional pager/alarm beep.
  beepBeep(audioCtx) {
    const t0 = audioCtx.currentTime;
    tone(audioCtx, { frequency: 880, startTime: t0, duration: 0.09, type: 'square', peakGain: 0.14 });
    tone(audioCtx, { frequency: 880, startTime: t0 + 0.14, duration: 0.09, type: 'square', peakGain: 0.14 });
  },

  // A short rising sweep -- reads as more urgent than the others, closer to
  // "pay attention now" than a passive chime.
  sweepUp(audioCtx) {
    const t0 = audioCtx.currentTime;
    sweep(audioCtx, { from: 420, to: 980, startTime: t0, duration: 0.22, peakGain: 0.22 });
  },

  // A radar-themed sonar-style pulse: one bright ping followed by a
  // quieter, lower-pitched echo -- the one candidate that leans into this
  // app's own "radar" framing rather than being a generic notification tone.
  radarPulse(audioCtx) {
    const t0 = audioCtx.currentTime;
    tone(audioCtx, { frequency: 1200, startTime: t0, duration: 0.14, peakGain: 0.24, attack: 0.004 });
    tone(audioCtx, { frequency: 850, startTime: t0 + 0.16, duration: 0.18, peakGain: 0.1, attack: 0.004 });
  },
};

export function playNotificationSound(presetId) {
  const preset = SOUND_PRESETS[presetId];
  if (!preset) return;
  preset(getContext());
}
