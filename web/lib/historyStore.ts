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
}

const buckets = new Map<string, Bucket>();

function bucket(interval: string): Bucket {
  let b = buckets.get(interval);
  if (!b) {
    b = { bars: [], listeners: new Set(), loading: false, exhausted: false };
    buckets.set(interval, b);
  }
  return b;
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
  const lastNew = bars[bars.length - 1]?.time;
  const lastOld = b.bars[b.bars.length - 1]?.time;
  // Reconnect with a shorter snapshot: keep any older bars we already prepended.
  if (b.bars.length > bars.length && lastNew === lastOld) return;
  b.bars = bars.slice();
  b.exhausted = false;
}

export function applyLiveKline(interval: string, k: Kline) {
  const b = bucket(interval);
  const last = b.bars[b.bars.length - 1];
  if (last && last.time === k.time) {
    b.bars[b.bars.length - 1] = k;
  } else if (!last || k.time > last.time) {
    b.bars.push(k);
  }
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
    notify(interval, { reason: "prepend", prepended: cut.length });
    return cut.length;
  } catch {
    return 0;
  } finally {
    b.loading = false;
  }
}
