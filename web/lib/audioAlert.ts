/**
 * Web Audio API synthesizer for trading alerts.
 * Generates alert tones using browser native oscillators — no external MP3/WAV files required.
 */

let sharedAudioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudioContext) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      sharedAudioContext = new AudioCtx();
    }
  }
  if (sharedAudioContext && sharedAudioContext.state === "suspended") {
    void sharedAudioContext.resume();
  }
  return sharedAudioContext;
}

/** Quick test beep when user toggles the alert ON — 350ms sharp square wave at 1000 Hz. */
export function playTestChirp() {
  playSharpBeep(0.35);
}

/** Crisp, sharp alert for regular 5m candle close (:05, :10, :20, :25, :35, :40, :50, :55). */
export function play5mCloseAlert() {
  playSharpBeep(0.40);
}

/**
 * Westminster Quarters chime for 15-minute boundaries (:00, :15, :30, :45).
 * Synthesizes 4-note bell chime in Key of E (G#4 -> F#4 -> E4 -> B3) with resonant bell harmonics.
 */
export function playWestminsterChime() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = ctx.currentTime;

  // Classic Westminster Quarters 1st phrase in Key of E
  const notes = [415.3, 369.99, 329.63, 246.94];
  const step = 0.52; // note spacing

  notes.forEach((freq, idx) => {
    const noteTime = start + idx * step;
    playBellTone(ctx, freq, noteTime, 1.25);
  });
}

/**
 * Plays the appropriate candle close alert:
 * - :00, :15, :30, :45 -> Westminster chime
 * - :05, :10, :20, :25, :35, :40, :50, :55 -> Standard sharp 5m beep
 */
export function playCandleCloseAlert(timestamp = Date.now()) {
  const min = new Date(timestamp).getMinutes();
  if (min % 15 === 0) {
    playWestminsterChime();
  } else {
    play5mCloseAlert();
  }
}

function playSharpBeep(durationSeconds = 0.40) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(1000, now);

  // Hard attack (5ms), full flat sustain, crisp release (10ms)
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.005);
  gain.gain.setValueAtTime(0.14, now + Math.max(0.01, durationSeconds - 0.01));
  gain.gain.linearRampToValueAtTime(0, now + durationSeconds);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + durationSeconds + 0.01);
}

function playBellTone(ctx: AudioContext, freq: number, startTime: number, decayDuration = 1.25) {
  // Fundamental tone (warm bell body)
  createHarmonic(ctx, freq, startTime, 0.18, decayDuration);
  // 2nd harmonic / octave (bright brass ring)
  createHarmonic(ctx, freq * 2, startTime, 0.07, decayDuration * 0.7);
  // 3rd harmonic (bell strike chime tap)
  createHarmonic(ctx, freq * 3, startTime, 0.025, decayDuration * 0.35);
}

function createHarmonic(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  peakGain: number,
  decayDuration: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startTime);

  // Fast strike attack, then natural exponential decay
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decayDuration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + decayDuration + 0.05);
}
