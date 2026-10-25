/**
 * Binance USDT-M futures (perp) market data.
 *
 * History, live klines, and the last-price ticker all come from fapi / fstream
 * so the tab title and candles match CoinGlass BTCUSDT perpetual.
 */

import WebSocket from "ws";

export const SPOT_REST = "https://api.binance.com";
export const FAPI_REST = "https://fapi.binance.com";
export const FAPI_WS = "wss://fstream.binance.com";
export const SPOT_WS = "wss://stream.binance.com:9443";
const WS_IDLE_TIMEOUT_MS = 60_000;
const WS_WATCHDOG_INTERVAL_MS = 15_000;
const WS_FALLBACK_IDLE_MS = 1_000;
const REST_FALLBACK_POLL_MS = 500;

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
// NOTE: element [6] is the bar's CLOSE TIME in ms — NOT a boolean.  A bar is
// considered closed only when its close-time is strictly in the past.  Using
// Boolean(Number(closeTimeMs)) would always be true (any non-zero number →
// true), which made the still-open current bar look closed on startup.
const KLINE_OPEN_TIME = 0 as const;
const KLINE_OPEN_FIELD = 1 as const;
const KLINE_HIGH_FIELD = 2 as const;
const KLINE_LOW_FIELD = 3 as const;
const KLINE_CLOSE_FIELD = 4 as const;
const KLINE_VOLUME_FIELD = 5 as const;
const KLINE_CLOSE_TIME = 6 as const;

function parseKline(raw: (string | number)[]): Kline {
  // A bar is closed when its close-time is in the past.
  const closeTimeMs = Number(raw[KLINE_CLOSE_TIME]);
  return {
    time: Math.floor(Number(raw[KLINE_OPEN_TIME]) / 1000),
    open: Number(raw[KLINE_OPEN_FIELD]),
    high: Number(raw[KLINE_HIGH_FIELD]),
    low: Number(raw[KLINE_LOW_FIELD]),
    close: Number(raw[KLINE_CLOSE_FIELD]),
    volume: Number(raw[KLINE_VOLUME_FIELD]),
    closed: closeTimeMs < Date.now(),
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
    const page = await klinesFutures(symbol, interval, pageSize, endTime);
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
 * Combined USDT-M futures kline WebSocket (fstream.binance.com).
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
  let watchdog: NodeJS.Timeout | null = null;
  let lastMessageAt = 0;
  let fallbackInFlight = false;
  let fallbackActive = false;
  let lastFallbackErrorAt = 0;
  const lastFallbackTime = new Map<string, number>();
  const lastFallbackKline = new Map<string, Kline>();

  const buildUrl = () => {
    const streams = [...activeIntervals]
      .map((i) => `${symbol.toLowerCase()}@kline_${i}`)
      .join("/");
    return `${FAPI_WS}/stream?streams=${streams}`;
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  const connect = () => {
    if (stopped) return;
    const connection = new WebSocket(buildUrl());
    ws = connection;
    let loggedFirstMessage = false;

    connection.on("open", () => {
      backoff = 1000;
      lastMessageAt = Date.now();
      console.log(`[binance] futures ws open: ${[...activeIntervals].join(",")}`);
      watchdog = setInterval(() => {
        if (Date.now() - lastMessageAt <= WS_IDLE_TIMEOUT_MS) return;
        console.warn("[binance] futures ws idle, reconnecting");
        connection.terminate();
      }, WS_WATCHDOG_INTERVAL_MS);
    });

    connection.on("message", (data) => {
      lastMessageAt = Date.now();
      if (fallbackActive) {
        fallbackActive = false;
        console.log("[binance] futures ws recovered; REST fallback paused");
      }
      if (!loggedFirstMessage) {
        loggedFirstMessage = true;
        console.log("[binance] futures ws receiving messages");
      }
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

    connection.on("error", (err) => {
      console.error("[binance] ws error:", err.message);
      connection.terminate();
    });

    connection.on("close", () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      if (ws === connection) ws = null;
      console.log(`[binance] ws closed, reconnect in ${backoff}ms`);
      scheduleReconnect();
    });
  };

  connect();
  const fallbackTimer = setInterval(() => {
    if (stopped || (lastMessageAt > 0 && Date.now() - lastMessageAt < WS_FALLBACK_IDLE_MS)) return;
    if (fallbackInFlight) return;
    fallbackInFlight = true;
    if (!fallbackActive) {
      fallbackActive = true;
      console.warn("[binance] futures ws idle; polling latest candles via REST");
    }
    void Promise.all([...activeIntervals].map(async (interval) => {
      try {
        const bars = await klinesFutures(symbol, interval, 10);
        const latest = bars[bars.length - 1];
        if (!latest || Date.now() - lastMessageAt < WS_FALLBACK_IDLE_MS) return;
        const previousTime = lastFallbackTime.get(interval);
        if (previousTime != null && latest.time > previousTime) {
          for (const bar of bars) {
            if (bar.closed && bar.time >= previousTime && bar.time < latest.time) {
              onEvent(interval, bar);
            }
          }
        }
        const previous = lastFallbackKline.get(interval);
        const changed = !previous
          || previous.time !== latest.time
          || previous.open !== latest.open
          || previous.high !== latest.high
          || previous.low !== latest.low
          || previous.close !== latest.close
          || previous.volume !== latest.volume
          || previous.closed !== latest.closed;
        if (changed) onEvent(interval, latest);
        lastFallbackTime.set(interval, latest.time);
        lastFallbackKline.set(interval, latest);
      } catch (err) {
        if (Date.now() - lastFallbackErrorAt >= 60_000) {
          lastFallbackErrorAt = Date.now();
          console.error("[binance] REST kline fallback failed:", err);
        }
      }
    })).finally(() => { fallbackInFlight = false; });
  }, REST_FALLBACK_POLL_MS);

  return {
    close() {
      stopped = true;
      clearInterval(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
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

/**
 * USDT-M last trade price (aggTrade) — same "last" CoinGlass shows on BTCUSDT perp.
 */
export function streamLastPrice(
  symbol: string,
  onPrice: (price: number) => void,
): { close: () => void } {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let lastMessageAt = 0;
  let fallbackInFlight = false;
  let fallbackActive = false;
  let lastFallbackErrorAt = 0;
  let lastFallbackPrice: number | null = null;

  const url = `${FAPI_WS}/ws/${symbol.toLowerCase()}@aggTrade`;

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  const connect = () => {
    if (stopped) return;
    const connection = new WebSocket(url);
    ws = connection;
    let loggedFirstMessage = false;

    connection.on("open", () => {
      backoff = 1000;
      lastMessageAt = Date.now();
      console.log(`[binance] futures aggTrade ws open: ${symbol}`);
      watchdog = setInterval(() => {
        if (Date.now() - lastMessageAt <= WS_IDLE_TIMEOUT_MS) return;
        console.warn("[binance] aggTrade ws idle, reconnecting");
        connection.terminate();
      }, WS_WATCHDOG_INTERVAL_MS);
    });

    connection.on("message", (data) => {
      lastMessageAt = Date.now();
      if (fallbackActive) {
        fallbackActive = false;
        console.log("[binance] aggTrade ws recovered; REST fallback paused");
      }
      if (!loggedFirstMessage) {
        loggedFirstMessage = true;
        console.log("[binance] aggTrade ws receiving messages");
      }
      try {
        const msg = JSON.parse(data.toString()) as { p?: string };
        const price = Number(msg.p);
        if (Number.isFinite(price) && price > 0) onPrice(price);
      } catch (err) {
        console.error("[binance] aggTrade parse error:", err);
      }
    });

    connection.on("error", (err) => {
      console.error("[binance] aggTrade ws error:", err.message);
      connection.terminate();
    });

    connection.on("close", () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      if (ws === connection) ws = null;
      console.log(`[binance] aggTrade ws closed, reconnect in ${backoff}ms`);
      scheduleReconnect();
    });
  };

  connect();
  const fallbackTimer = setInterval(() => {
    if (stopped || (lastMessageAt > 0 && Date.now() - lastMessageAt < WS_FALLBACK_IDLE_MS)) return;
    if (fallbackInFlight) return;
    fallbackInFlight = true;
    if (!fallbackActive) {
      fallbackActive = true;
      console.warn("[binance] aggTrade ws idle; polling latest price via REST");
    }
    void fetch(`${FAPI_REST}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol.toUpperCase())}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`ticker request failed: ${response.status}`);
        const result = await response.json() as { price?: string };
        const price = Number(result.price);
        if (
          price > 0
          && price !== lastFallbackPrice
          && Date.now() - lastMessageAt >= WS_FALLBACK_IDLE_MS
        ) {
          lastFallbackPrice = price;
          onPrice(price);
        }
      })
      .catch((err) => {
        if (Date.now() - lastFallbackErrorAt >= 60_000) {
          lastFallbackErrorAt = Date.now();
          console.error("[binance] REST ticker fallback failed:", err);
        }
      })
      .finally(() => { fallbackInFlight = false; });
  }, REST_FALLBACK_POLL_MS);

  return {
    close() {
      stopped = true;
      clearInterval(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
      ws?.close();
    },
  };
}
