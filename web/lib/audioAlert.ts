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

/** Quick test beep when user toggles the alert ON — 400ms sharp sine at 1000 Hz. */
export function playTestChirp() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(1000, now);

  // Hard attack, full sustain, short tail
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.005); // snap to full volume in 5ms
  gain.gain.setValueAtTime(0.12, now + 0.35);
  gain.gain.linearRampToValueAtTime(0, now + 0.40);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.41);
}

/**
 * 1.5-second sharp alert when candle closes — exactly the same square-wave tone as toggle-on.
 */
export function play5mCloseAlert() {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(1000, now);

  // Hard attack (5ms), full flat sustain, smooth release at 1.50s
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.005);
  gain.gain.setValueAtTime(0.14, now + 1.48);
  gain.gain.linearRampToValueAtTime(0, now + 1.50);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 1.51);
}

