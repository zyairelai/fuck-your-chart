/** Shared per-interval candle cache so 1m raw + 1m HA stay the same length
 *  when either pane prepends older history. */

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
  closed: boolean;
}

export type HistoryEvent = { reason: "seed" | "prepend"; prepended: number };

type Listener = (ev: HistoryEvent) => void;

interface Bucket {
  bars: Kline[];
  listeners: Set<Listener>;
  loading: boolean;
  exhausted: boolean;
  hydrated: boolean;
}

const buckets = new Map<string, Bucket>();
const STORAGE_PREFIX = "fuck-your-chart:history:v1:";
const PERSISTED_BAR_LIMIT = 1_000;

function isKline(value: unknown): value is Kline {
  if (!value || typeof value !== "object") return false;
  const bar = value as Record<string, unknown>;
  return typeof bar.time === "number" && Number.isFinite(bar.time)
    && typeof bar.open === "number" && Number.isFinite(bar.open)
    && typeof bar.high === "number" && Number.isFinite(bar.high)
    && typeof bar.low === "number" && Number.isFinite(bar.low)
    && typeof bar.close === "number" && Number.isFinite(bar.close)
    && typeof bar.volume === "number" && Number.isFinite(bar.volume)
    && typeof bar.takerBuyVolume === "number" && Number.isFinite(bar.takerBuyVolume)
    && typeof bar.closed === "boolean";
}

function bucket(interval: string): Bucket {
  let b = buckets.get(interval);
  if (!b) {
    b = {
      bars: [],
      listeners: new Set(),
      loading: false,
      exhausted: false,
      hydrated: false,
    };
    buckets.set(interval, b);
  }
  if (!b.hydrated && typeof window !== "undefined") {
    b.hydrated = true;
    try {
      const saved = window.localStorage.getItem(`${STORAGE_PREFIX}${interval}`);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.every(isKline)) {
          b.bars = parsed;
        } else {
          console.warn(`[history] ignoring invalid saved ${interval} candles`);
        }
      }
    } catch (err) {
      console.warn(`[history] could not restore saved ${interval} candles:`, err);
    }
  }
  return b;
}

function persist(interval: string, bars: Kline[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${interval}`,
      JSON.stringify(bars.slice(-PERSISTED_BAR_LIMIT)),
    );
  } catch (err) {
    console.warn(`[history] could not save ${interval} candles:`, err);
  }
}

function notify(interval: string, ev: HistoryEvent) {
  for (const fn of bucket(interval).listeners) fn(ev);
}

export function subscribeHistory(interval: string, fn: Listener): () => void {
  const b = bucket(interval);
  b.listeners.add(fn);
  return () => { b.listeners.delete(fn); };
}

export function getHistory(interval: string): Kline[] {
  return bucket(interval).bars;
}

export function seedHistory(interval: string, bars: Kline[]) {
  const b = bucket(interval);
  const merged = new Map<number, Kline>();
  for (const bar of b.bars) merged.set(bar.time, bar);
  for (const bar of bars) merged.set(bar.time, bar);
  b.bars = [...merged.values()].sort((a, z) => a.time - z.time);
  b.exhausted = false;
  persist(interval, b.bars);
}

export function applyLiveKline(interval: string, k: Kline) {
  const b = bucket(interval);
  const last = b.bars[b.bars.length - 1];
  if (last && last.time === k.time) {
    b.bars[b.bars.length - 1] = k;
  } else if (last && k.time < last.time) {
    const historicalIndex = b.bars.findIndex((bar) => bar.time === k.time);
    if (historicalIndex >= 0) b.bars[historicalIndex] = k;
  } else if (!last || k.time > last.time) {
    b.bars.push(k);
  }
  if (k.closed) persist(interval, b.bars);
}

/** Fetch one older page (max 1000) and prepend. Returns how many bars were added. */
export async function loadOlderHistory(interval: string): Promise<number> {
  const b = bucket(interval);
  if (b.loading || b.exhausted || b.bars.length === 0) return 0;
  b.loading = true;
  try {
    const endTime = b.bars[0]!.time * 1000 - 1;
    const res = await fetch(
      `/api/klines/${encodeURIComponent(interval)}?endTime=${endTime}&limit=1000`,
    );
    if (!res.ok) return 0;
    const older = (await res.json()) as Kline[];
    const first = b.bars[0]!.time;
    const cut = older.filter((bar) => bar.time < first);
    if (cut.length === 0) {
      b.exhausted = true;
      return 0;
    }
    b.bars = [...cut, ...b.bars];
    persist(interval, b.bars);
    notify(interval, { reason: "prepend", prepended: cut.length });
    return cut.length;
  } catch {
    return 0;
  } finally {
    b.loading = false;
  }
}
