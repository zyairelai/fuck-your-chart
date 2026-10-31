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

export type HistoryEvent = { reason: "seed" | "prepend" | "reconcile"; prepended: number };

type Listener = (ev: HistoryEvent) => void;

interface Bucket {
  bars: Kline[];
  listeners: Set<Listener>;
  loading: boolean;
  exhausted: boolean;
  hydrated: boolean;
}

const buckets = new Map<string, Bucket>();
const STORAGE_PREFIX = "fuck-your-chart:history:v2:";
const PERSISTED_BAR_LIMIT = 1_000;

function isKline(value: unknown): value is Kline {
  if (!value || typeof value !== "object") return false;
  const bar = value as Record<string, unknown>;
  return typeof bar.time === "number" && Number.isFinite(bar.time) && bar.time > 0
    && typeof bar.open === "number" && Number.isFinite(bar.open)
    && typeof bar.high === "number" && Number.isFinite(bar.high)
    && typeof bar.low === "number" && Number.isFinite(bar.low)
    && typeof bar.close === "number" && Number.isFinite(bar.close)
    && typeof bar.volume === "number" && Number.isFinite(bar.volume)
    && typeof bar.takerBuyVolume === "number" && Number.isFinite(bar.takerBuyVolume)
    && typeof bar.closed === "boolean";
}

function cleanAndSort(bars: Kline[]): Kline[] {
  const map = new Map<number, Kline>();
  for (const bar of bars) {
    if (isKline(bar)) {
      map.set(bar.time, bar);
    }
  }
  return [...map.values()].sort((a, z) => a.time - z.time);
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
          b.bars = cleanAndSort(parsed);
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
  const map = new Map<number, Kline>();
  for (const bar of b.bars) map.set(bar.time, bar);
  for (const bar of bars) map.set(bar.time, bar);
  b.bars = cleanAndSort([...map.values()]);
  b.exhausted = false;
  persist(interval, b.bars);
}

export function reconcileHistory(interval: string, authoritative: Kline[]): Kline[] {
  const b = bucket(interval);
  if (!authoritative || authoritative.length === 0) return b.bars;

  const map = new Map<number, Kline>();
  // Preserve existing older bars not in authoritative
  for (const bar of b.bars) {
    map.set(bar.time, bar);
  }
  // Overwrite with official authoritative bars
  for (const bar of authoritative) {
    map.set(bar.time, bar);
  }

  // Preserve any newer forming candle that might be after authoritative
  const lastAuthTime = authoritative[authoritative.length - 1]?.time ?? 0;
  const currentLast = b.bars[b.bars.length - 1];
  if (currentLast && currentLast.time > lastAuthTime && !currentLast.closed) {
    map.set(currentLast.time, currentLast);
  }

  b.bars = cleanAndSort([...map.values()]);
  persist(interval, b.bars);
  return b.bars;
}

const inFlightPulls = new Map<string, Promise<Kline[]>>();

/** Pull official klines from the server REST endpoint to perfectly align closed candles.
 *  Multiple charts (e.g. 1m raw + 1m HA) share the single concurrent HTTP request. */
export async function pullAuthoritativeKlines(interval: string, limit = 200): Promise<Kline[]> {
  const existing = inFlightPulls.get(interval);
  if (existing) return existing;

  const pullPromise = (async () => {
    try {
      const res = await fetch(`/api/klines/${encodeURIComponent(interval)}?limit=${limit}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const authoritative = (await res.json()) as Kline[];
      if (Array.isArray(authoritative) && authoritative.length > 0) {
        return reconcileHistory(interval, authoritative);
      }
      return getHistory(interval);
    } catch (err) {
      console.warn(`[history] failed to pull authoritative klines for ${interval}:`, err);
      return getHistory(interval);
    } finally {
      inFlightPulls.delete(interval);
    }
  })();

  inFlightPulls.set(interval, pullPromise);
  return pullPromise;
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
