// ---------------------------------------------------------------------------
// Alert persistence & TTS speech
// ---------------------------------------------------------------------------

export interface EmaAlert {
  id: string;
  kind: "ema";
  chartId: "main" | "ha-top" | "ha-bottom";
  period: number;
  speechText: string;
}

export interface PriceAlert {
  id: string;
  kind: "price";
  price: number;
  speechText: string;
}

export type ChartAlert = EmaAlert | PriceAlert;

export interface AlertState {
  emas: EmaAlert[];
  prices: PriceAlert[];
}

const STORAGE_KEY = "fuck-your-chart:alerts:v1";

export function emptyAlertState(): AlertState {
  return { emas: [], prices: [] };
}

export function loadAlertState(): AlertState {
  if (typeof window === "undefined") return emptyAlertState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyAlertState();
    const parsed = JSON.parse(raw) as AlertState;
    return {
      emas: Array.isArray(parsed.emas) ? parsed.emas : [],
      prices: Array.isArray(parsed.prices) ? parsed.prices : [],
    };
  } catch {
    return emptyAlertState();
  }
}

export function saveAlertState(state: AlertState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

// ---------------------------------------------------------------------------
// Text-to-speech — tries to pick a natural-sounding female voice
// ---------------------------------------------------------------------------

const PREFERRED_VOICES = [
  "Google UK English Female",
  "Microsoft Zira Desktop",
  "Microsoft Zira",
  "Microsoft Jenny Online (Natural)",
  "Microsoft Jenny",
  "Samantha",
  "Victoria",
  "Karen",
  "Moira",
  "Tessa",
  "Fiona",
];

function pickFemaleVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((v) => v.name === name || v.name.startsWith(name));
    if (v) return v;
  }
  // Any voice with "female" in the name
  const byLabel = voices.find((v) => v.name.toLowerCase().includes("female"));
  if (byLabel) return byLabel;
  // Last resort: first available voice
  return voices[0] ?? null;
}

export function speakAlertText(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

  const doSpeak = () => {
    window.speechSynthesis.cancel(); // stop any ongoing speech
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickFemaleVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 0.95;
    utterance.pitch = 1.05;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  if (window.speechSynthesis.getVoices().length > 0) {
    doSpeak();
  } else {
    // Voices haven't loaded yet — wait for the event
    window.speechSynthesis.addEventListener("voiceschanged", doSpeak, { once: true });
  }
}
