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

export function cleanAndSort(bars: Kline[]): Kline[] {
  const map = new Map<number, Kline>();
  for (const bar of bars) {
    if (isKline(bar)) {
      map.set(bar.time, bar);
    }
  }
  return [...map.values()].sort((a, z) => a.time - z.time);
}

function makeBucketKey(interval: string, symbol = "BTCUSDT"): string {
  return `${symbol.toUpperCase()}:${interval}`;
}

function bucket(interval: string, symbol = "BTCUSDT"): Bucket {
  const key = makeBucketKey(interval, symbol);
  let b = buckets.get(key);
  if (!b) {
    b = {
      bars: [],
      listeners: new Set(),
      loading: false,
      exhausted: false,
      hydrated: false,
    };
    buckets.set(key, b);
  }
  if (!b.hydrated && typeof window !== "undefined") {
    b.hydrated = true;
    try {
      const saved = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.every(isKline)) {
          b.bars = cleanAndSort(parsed);
        } else {
          console.warn(`[history] ignoring invalid saved ${key} candles`);
        }
      }
    } catch (err) {
      console.warn(`[history] could not restore saved ${key} candles:`, err);
    }
  }
  return b;
}

function persist(interval: string, bars: Kline[], symbol = "BTCUSDT") {
  if (typeof window === "undefined") return;
  const key = makeBucketKey(interval, symbol);
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${key}`,
      JSON.stringify(bars.slice(-PERSISTED_BAR_LIMIT)),
    );
  } catch (err) {
    console.warn(`[history] could not save ${key} candles:`, err);
  }
}

function notify(interval: string, ev: HistoryEvent, symbol = "BTCUSDT") {
  for (const fn of bucket(interval, symbol).listeners) fn(ev);
}

export function subscribeHistory(interval: string, fn: Listener, symbol = "BTCUSDT"): () => void {
  const b = bucket(interval, symbol);
  b.listeners.add(fn);
  return () => { b.listeners.delete(fn); };
}

export function getHistory(interval: string, symbol = "BTCUSDT"): Kline[] {
  return bucket(interval, symbol).bars;
}

export function seedHistory(interval: string, bars: Kline[], symbol = "BTCUSDT") {
  const b = bucket(interval, symbol);
  const map = new Map<number, Kline>();
  for (const bar of b.bars) map.set(bar.time, bar);
  for (const bar of bars) map.set(bar.time, bar);
  b.bars = cleanAndSort([...map.values()]);
  b.exhausted = false;
  persist(interval, b.bars, symbol);
}

export function reconcileHistory(interval: string, authoritative: Kline[], symbol = "BTCUSDT"): Kline[] {
  const b = bucket(interval, symbol);
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
  persist(interval, b.bars, symbol);
  return b.bars;
}

const inFlightPulls = new Map<string, Promise<Kline[]>>();

const FAPI_BASE = "https://fapi.binance.com";

function parseBinanceKline(raw: (string | number)[]): Kline {
  const closeTimeMs = Number(raw[6]);
  return {
    time: Math.floor(Number(raw[0]) / 1000),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    takerBuyVolume: Number(raw[9]),
    closed: closeTimeMs < Date.now(),
  };
}

/** Fetch klines directly from Binance USDT-M Futures public REST API (CORS-enabled).
 *  Used as a seamless zero-config fallback when deployed statically on GitHub Pages. */
export async function fetchFromBinanceDirect(
  interval: string,
  limit = 500,
  endTimeMs?: number,
  symbol = "BTCUSDT",
): Promise<Kline[]> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (endTimeMs != null && Number.isFinite(endTimeMs)) {
    params.set("endTime", String(Math.floor(endTimeMs)));
  }
  const res = await fetch(`${FAPI_BASE}/fapi/v1/klines?${params.toString()}`);
  if (!res.ok) throw new Error(`Binance direct fetch failed: ${res.status}`);
  const raw = (await res.json()) as (string | number)[][];
  return raw.map(parseBinanceKline);
}

/** Fetch latest klines from the server REST endpoint, deduplicating concurrent in-flight requests. */
export async function fetchLatestKlines(interval: string, limit = 20, symbol = "BTCUSDT"): Promise<Kline[]> {
  const key = `${symbol.toUpperCase()}:${interval}:${limit}`;
  const existing = inFlightPulls.get(key);
  if (existing) return existing;

  const pullPromise = (async () => {
    try {
      try {
        const res = await fetch(`/api/klines/${encodeURIComponent(interval)}?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
        if (res.ok) {
          const raw = (await res.json()) as Kline[];
          return raw.map((k) => ({
            ...k,
            time: k.time > 1e10 ? Math.floor(k.time / 1000) : k.time,
          }));
        }
      } catch {
        // Fallback to Binance public REST endpoint (e.g. on GitHub Pages)
      }
      return await fetchFromBinanceDirect(interval, limit, undefined, symbol);
    } finally {
      inFlightPulls.delete(key);
    }
  })();

  inFlightPulls.set(key, pullPromise);
  return pullPromise;
}

export async function fetchOlderKlines(interval: string, endTimeMs: number, limit = 1000, symbol = "BTCUSDT"): Promise<Kline[]> {
  try {
    const res = await fetch(
      `/api/klines/${encodeURIComponent(interval)}?symbol=${encodeURIComponent(symbol)}&endTime=${endTimeMs}&limit=${limit}`,
    );
    if (res.ok) {
      const older = (await res.json()) as Kline[];
      return older.map((k) => ({
        ...k,
        time: k.time > 1e10 ? Math.floor(k.time / 1000) : k.time,
      }));
    }
  } catch {
    // Fallback
  }
  return fetchFromBinanceDirect(interval, limit, endTimeMs, symbol);
}

/** Pull official klines from the server REST endpoint to perfectly align closed candles.
 *  Multiple charts (e.g. 1m raw + 1m HA) share the single concurrent HTTP request. */
export async function pullAuthoritativeKlines(interval: string, limit = 200, symbol = "BTCUSDT"): Promise<Kline[]> {
  const existing = inFlightPulls.get(`${symbol.toUpperCase()}:${interval}`);
  if (existing) return existing;

  const pullPromise = (async () => {
    try {
      let authoritative: Kline[] = [];
      try {
        const res = await fetch(`/api/klines/${encodeURIComponent(interval)}?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
        if (res.ok) {
          authoritative = (await res.json()) as Kline[];
        }
      } catch {
        // Fallback
      }
      if (!authoritative || authoritative.length === 0) {
        authoritative = await fetchFromBinanceDirect(interval, limit, undefined, symbol);
      }
      if (Array.isArray(authoritative) && authoritative.length > 0) {
        return reconcileHistory(interval, authoritative, symbol);
      }
      return getHistory(interval, symbol);
    } catch (err) {
      console.warn(`[history] failed to pull authoritative klines for ${symbol}:${interval}:`, err);
      return getHistory(interval, symbol);
    } finally {
      inFlightPulls.delete(`${symbol.toUpperCase()}:${interval}`);
    }
  })();

  inFlightPulls.set(`${symbol.toUpperCase()}:${interval}`, pullPromise);
  return pullPromise;
}

export function applyLiveKline(interval: string, k: Kline, symbol = "BTCUSDT") {
  const b = bucket(interval, symbol);
  const last = b.bars[b.bars.length - 1];
  if (last && last.time === k.time) {
    b.bars[b.bars.length - 1] = k;
  } else if (last && k.time < last.time) {
    const historicalIndex = b.bars.findIndex((bar) => bar.time === k.time);
    if (historicalIndex >= 0) b.bars[historicalIndex] = k;
  } else if (!last || k.time > last.time) {
    b.bars.push(k);
  }
  if (k.closed) persist(interval, b.bars, symbol);
}

/** Fetch one older page (max 1000) and prepend. Returns how many bars were added. */
export async function loadOlderHistory(interval: string, symbol = "BTCUSDT"): Promise<number> {
  const b = bucket(interval, symbol);
  if (b.loading || b.exhausted || b.bars.length === 0) return 0;
  b.loading = true;
  try {
    const endTime = b.bars[0]!.time * 1000 - 1;
    let older: Kline[] = [];
    try {
      const res = await fetch(
        `/api/klines/${encodeURIComponent(interval)}?symbol=${encodeURIComponent(symbol)}&endTime=${endTime}&limit=1000`,
      );
      if (res.ok) {
        older = (await res.json()) as Kline[];
      }
    } catch {
      // Fallback
    }
    if (older.length === 0) {
      older = await fetchFromBinanceDirect(interval, 1000, endTime, symbol);
    }
    const first = b.bars[0]!.time;
    const cut = older.filter((bar) => bar.time < first);
    if (cut.length === 0) {
      b.exhausted = true;
      return 0;
    }
    b.bars = [...cut, ...b.bars];
    persist(interval, b.bars, symbol);
    notify(interval, { reason: "prepend", prepended: cut.length }, symbol);
    return cut.length;
  } catch {
    return 0;
  } finally {
    b.loading = false;
  }
}
