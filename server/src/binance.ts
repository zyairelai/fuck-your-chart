/**
 * Binance public market data client.
 *
 * History and live ticks BOTH come from the SPOT endpoint. They have to be
 * the same source: REST /fapi/v1/klines returns PERP OHLC, but the only
 * working kline WS in this environment is the spot one. Mixing the two
 * produces a "cut off candle" on startup — the REST bar paints with one
 * OHLC, the WS immediately overwrites it with a different OHLC (spot vs
 * perp basis), and the candle ends up with a body and wick that don't
 * align. Spot and perp BTC trade at visually identical prices (basis is
 * sub-bp), so the chart looks the same as coinglass/Binance perp UI.
 */

import WebSocket from "ws";

export const SPOT_REST = "https://api.binance.com";
export const FAPI_REST = "https://fapi.binance.com";
export const SPOT_WS = "wss://stream.binance.com:9443";

/** A candle in lightweight-charts-friendly shape (UTC seconds). */
export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

// Binance kline tuple layout (see /api/v1/klines response):
//   [0] open time(ms), [1] open, [2] high, [3] low, [4] close,
//   [5] volume, [6] close time(ms), [7] quote asset volume, [8] trades...
const KLINE_CLOSED_INDEX = 6 as const;
const KLINE_OPEN_TIME = 0 as const;
const KLINE_OPEN_FIELD = 1 as const;
const KLINE_HIGH_FIELD = 2 as const;
const KLINE_LOW_FIELD = 3 as const;
const KLINE_CLOSE_FIELD = 4 as const;
const KLINE_VOLUME_FIELD = 5 as const;

function parseKline(raw: (string | number)[]): Kline {
  return {
    time: Math.floor(Number(raw[KLINE_OPEN_TIME]) / 1000),
    open: Number(raw[KLINE_OPEN_FIELD]),
    high: Number(raw[KLINE_HIGH_FIELD]),
    low: Number(raw[KLINE_LOW_FIELD]),
    close: Number(raw[KLINE_CLOSE_FIELD]),
    volume: Number(raw[KLINE_VOLUME_FIELD]),
    closed: Boolean(Number(raw[KLINE_CLOSED_INDEX])),
  };
}

/**
 * Fetch the most recent N spot candles for `symbol` at `interval`. We use the
 * SPOT REST endpoint (api.binance.com) on purpose so that the history and the
 * live WS ticks (which only deliver on the spot stream in this environment)
 * describe the same market. The spot–perp basis for BTC is < 1 bp at any
 * given moment, so the chart is visually indistinguishable from a perp view.
 */
async function fetchKlines(
  urlBase: string,
  symbol: string,
  interval: string,
  limit = 500,
  endTimeMs?: number,
): Promise<Kline[]> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (endTimeMs != null && Number.isFinite(endTimeMs)) {
    params.set("endTime", String(Math.floor(endTimeMs)));
  }
  const url = `${urlBase}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`binance klines ${symbol} ${interval} failed: ${res.status}`);
  }
  const raw = (await res.json()) as (string | number)[][];
  return raw.map((row) => parseKline(row));
}

export async function klines(
  symbol: string,
  interval: string,
  limit = 500,
  endTimeMs?: number,
): Promise<Kline[]> {
  return fetchKlines(`${SPOT_REST}/api/v3/klines`, symbol, interval, limit, endTimeMs);
}

/** Futures perp OHLC — same source as zones.py (fapi.binance.com). */
export async function klinesFutures(
  symbol: string,
  interval: string,
  limit = 500,
  endTimeMs?: number,
): Promise<Kline[]> {
  return fetchKlines(`${FAPI_REST}/fapi/v1/klines`, symbol, interval, limit, endTimeMs);
}

/** Walk backwards `pages` times (Binance max 1000/page) so boot has a deep buffer. */
export async function klinesPages(
  symbol: string,
  interval: string,
  pages = 10,
  pageSize = 1000,
): Promise<Kline[]> {
  let bars: Kline[] = [];
  let endTime: number | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await klines(symbol, interval, pageSize, endTime);
    if (page.length === 0) break;
    if (bars.length === 0) {
      bars = page;
    } else {
      const first = bars[0]!.time;
      const older = page.filter((b) => b.time < first);
      if (older.length === 0) break;
      bars = [...older, ...bars];
    }
    endTime = bars[0]!.time * 1000 - 1;
    if (page.length < pageSize) break;
  }
  return bars;
}

/**
 * Open a single combined SPOT WebSocket for all `intervals` of `symbol`. The
 * spot WS pushes kline ticks reliably (the futures WS does not in this
 * environment). Spot BTCUSDT and BTCUSDT futures perp trade at the same price
 * to the eye; the chart behaves identically.
 *
 * Returns a `streamKlines` controller. Call `.add(interval)` at runtime to
 * subscribe another interval on the existing WS (the combined stream URL is
 * rebuilt and the socket reconnects with the new streams).
 */
export function streamKlines(
  symbol: string,
  intervals: string[],
  onEvent: (interval: string, k: Kline) => void,
): {
  close: () => void;
  add: (interval: string) => void;
} {
  const activeIntervals = new Set<string>(intervals);
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const buildUrl = () => {
    const streams = [...activeIntervals]
      .map((i) => `${symbol.toLowerCase()}@kline_${i}`)
      .join("/");
    return `${SPOT_WS}/stream?streams=${streams}`;
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  const connect = () => {
    if (stopped) return;
    const url = buildUrl();
    ws = new WebSocket(url);

    ws.on("open", () => {
      backoff = 1000;
      console.log(`[binance] spot ws open: ${[...activeIntervals].join(",")}`);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          stream?: string;
          data?: { e?: string; k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
        };
        const stream = msg.stream ?? "";
        const k = msg.data?.k;
        if (!k) return;
        const interval = stream.split("@kline_")[1] ?? "";
        if (!activeIntervals.has(interval)) return;
        onEvent(interval, {
          time: Math.floor(k.t / 1000),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          closed: k.x,
        });
      } catch (err) {
        console.error("[binance] parse error:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[binance] ws error:", err.message);
    });

    ws.on("close", () => {
      console.log(`[binance] ws closed, reconnect in ${backoff}ms`);
      scheduleReconnect();
    });
  };

  connect();

  return {
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
    add(interval: string) {
      if (activeIntervals.has(interval)) return;
      activeIntervals.add(interval);
      console.log(`[binance] adding ${interval}, reconnecting`);
      // Rebuild URL and reconnect — Binance's combined stream is set at
      // connect time, so any new subscription needs a fresh handshake.
      ws?.close();
      backoff = 1000;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 50);
    },
  };
}
