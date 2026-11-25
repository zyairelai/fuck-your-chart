/**
 * Audio alerts for trading candle closes.
 * - :00, :15, :30, :45 -> Plays /westminster-chime-melody-128.mp3 via AudioContext (decoded buffer).
 * - :05, :10, :20, :25, :35, :40, :50, :55 -> Plays sharp 5m beep.
 */

let sharedAudioContext: AudioContext | null = null;

// Decoded AudioBuffer cache for the Westminster chime MP3
let westminsterBuffer: AudioBuffer | null = null;
let westminsterLoading = false;

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

/** Pre-fetch and decode the Westminster MP3 into the shared AudioContext buffer. */
export function preloadWestminsterChime(): void {
  if (westminsterBuffer || westminsterLoading) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  westminsterLoading = true;
  fetch("/westminster-chime-melody-128.mp3")
    .then((res) => res.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => {
      westminsterBuffer = decoded;
      westminsterLoading = false;
    })
    .catch((err) => {
      console.warn("[audio] failed to preload westminster mp3:", err);
      westminsterLoading = false;
    });
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
 * Plays westminster-chime-melody-128.mp3 through the AudioContext for 15-minute boundaries
 * (:00, :15, :30, :45). Using the same AudioContext as the beep avoids browser autoplay blocks.
 */
export function playWestminsterChime() {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (westminsterBuffer) {
    // Buffer already decoded — play immediately
    const source = ctx.createBufferSource();
    source.buffer = westminsterBuffer;
    source.connect(ctx.destination);
    source.start(0);
  } else {
    // Not loaded yet — fetch, decode, then play
    fetch("/westminster-chime-melody-128.mp3")
      .then((res) => res.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        westminsterBuffer = decoded;
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        source.start(0);
      })
      .catch((err) => {
        console.warn("[audio] failed to load/play westminster mp3:", err);
      });
  }
}

/**
 * Plays the appropriate candle close alert:
 * - :00, :15, :30, :45 -> Westminster chime MP3 directly
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
