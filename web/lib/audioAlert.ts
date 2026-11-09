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

/** Crisp, sharp alert when candle closes — 400ms sharp square wave at 1000 Hz. */
export function play5mCloseAlert() {
  playSharpBeep(0.40);
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

