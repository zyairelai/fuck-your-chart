"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
  type MouseEventParams,
  type IChartApi,
  type ISeriesApi,
  type IPriceScaleApi,
  type ITimeScaleApi,
  type Time,
} from "lightweight-charts";
import { io, Socket } from "socket.io-client";
import {
  seedHistory,
  applyLiveKline,
  getHistory,
  loadOlderHistory,
  subscribeHistory,
} from "../lib/historyStore";

/** Mirror the server's Kline shape. */
interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

/** Heikin Ashi transform — applied client-side from the regular candles. */
function toHeikin(c: Kline[]): Kline[] {
  const out: Kline[] = [];
  let prevHAOpen = 0;
  let prevHAClose = 0;
  for (let i = 0; i < c.length; i++) {
    const cur = c[i]!;
    const haClose = (cur.open + cur.high + cur.low + cur.close) / 4;
    const haOpen = i === 0 ? (cur.open + cur.close) / 2 : (prevHAOpen + prevHAClose) / 2;
    const haHigh = Math.max(cur.high, haOpen, haClose);
    const haLow = Math.min(cur.low, haOpen, haClose);
    out.push({ time: cur.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: cur.volume, closed: cur.closed });
    prevHAOpen = haOpen;
    prevHAClose = haClose;
  }
  return out;
}

/** Compute the Heikin Ashi value of ONE bar given the previous HA bar. Used
 *  per-tick so we don't have to re-derive the entire history on every tick. */
function toHeikinOne(cur: Kline, prevHAOpen: number, prevHAClose: number, isFirst: boolean): Kline {
  // Close = OHLC/4 of this tick's raw kline. Open = previous HA body's mid.
  const haClose = (cur.open + cur.high + cur.low + cur.close) / 4;
  const haOpen = isFirst ? (cur.open + cur.close) / 2 : (prevHAOpen + prevHAClose) / 2;
  const haHigh = Math.max(cur.high, haOpen, haClose);
  const haLow = Math.min(cur.low, haOpen, haClose);
  return { time: cur.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: cur.volume, closed: cur.closed };
}

/** Build HA series and the closed-bar anchor used for the still-open candle.
 *  The live bar's HA open is always the previous body's midpoint — never the
 *  forming bar itself. */
function heikinSeriesAndAnchor(raw: Kline[]): {
  series: Kline[];
  lastClosed: { open: number; close: number } | null;
} {
  const series = toHeikin(raw);
  if (series.length === 0) return { series, lastClosed: null };
  const lastRaw = raw[raw.length - 1]!;
  if (lastRaw.closed) {
    const tail = series[series.length - 1]!;
    return { series, lastClosed: { open: tail.open, close: tail.close } };
  }
  if (series.length >= 2) {
    const prev = series[series.length - 2]!;
    series[series.length - 1] = toHeikinOne(lastRaw, prev.open, prev.close, false);
    return { series, lastClosed: { open: prev.open, close: prev.close } };
  }
  return { series, lastClosed: null };
}

/** Simple EMA helper — same series in, smoothed series out. */
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? prev;
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * EMA colour map — matched to `sample/js/chart.js`:
 *   10  -> orange  (#ff6d00)
 *   21  -> green   (#4caf50)
 *   50  -> orange  (#ff9800)  (lineWidth 2.5)
 *   200 -> pink    (#e91e63)
 */
const EMA_COLOR: Record<number, string> = {
  10: "#ff6d00",
  20: "#4caf50",
  50: "#ff9800",
  200: "#e91e63",
};
const EMA_LINE_WIDTH: Record<number, number> = {
  10: 1.5,
  20: 1.5,
  50: 2.5,
  200: 3.5,
};

/** Default zoom: ~9px per bar so candles stay readable (CoinGlass-like).
 *  Visible bar count then follows pane width instead of stuffing 500 bars in. */
const TARGET_BAR_SPACING = 9;
/** Tiny extra pad after the last *future* whitespace bar. */
const RIGHT_GAP_BARS = 2;

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function intervalSeconds(interval: string): number {
  const m = /^(\d+)([mhd])$/i.exec(interval);
  if (!m) return 60;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return n * 86400;
}

/** Empty future window: 4 hours so 16:00 still covers 19:00–20:00 on every TF. */
function futureBarCount(interval: string): number {
  return Math.max(1, Math.ceil((4 * 3600) / intervalSeconds(interval)));
}

/** Snap level prices to 0.0 / 0.5 / 1.0 (0.45 → 0.5). */
function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function futureWhitespace(lastTime: number, interval: string): { time: Time }[] {
  const step = intervalSeconds(interval);
  const n = futureBarCount(interval);
  const out: { time: Time }[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ time: (lastTime + i * step) as Time });
  }
  return out;
}

/** Default zoom — matched to CoinGlass: fat, readable candles with the
 *  latest bar near the right edge. Reset uses the same numbers. */
const DEFAULT_BAR_SPACING = 9;
const DEFAULT_RIGHT_OFFSET = 6;

/** Darken an `#rrggbb` colour by mixing it with the dark cell background. */
function darken(hex: string, mix = 0.7): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  const dr = Math.round(r * (1 - mix) + 18 * mix);
  const dg = Math.round(g * (1 - mix) + 22 * mix);
  const db = Math.round(b * (1 - mix) + 28 * mix);
  return `rgb(${dr}, ${dg}, ${db})`;
}

/** Display-timezone offset, in hours. 8 = UTC+8. Kept in sync with the
 *  top-bar's TZ_OPTIONS in TopBar.tsx. */
export type TzOffset = 0 | 4 | 8;

/** Format a UTC epoch-seconds value to "HH:mm" in the chosen timezone. */
function fmtTime(t: number, tz: TzOffset): string {
  const d = new Date((t + tz * 3600) * 1000);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Crosshair time label: "Sat 24 Oct 15:50" in the selected TZ — no year.
 *  LWC's default uses UTC and "24 Oct '26", which is why the hover showed 07:50. */
function fmtCrosshairTime(t: Time, tz: TzOffset): string {
  const epoch = t as number;
  const d = new Date((epoch + tz * 3600) * 1000);
  const dow = DAY[d.getUTCDay()] ?? "";
  const day = d.getUTCDate();
  const mon = MONTH[d.getUTCMonth()] ?? "";
  return `${dow} ${day} ${mon} ${fmtTime(epoch, tz)}`;
}

function makeLocalization(tz: TzOffset) {
  return {
    timeFormatter: (t: Time) => fmtCrosshairTime(t, tz),
    priceFormatter: (price: number) => price.toFixed(1),
  };
}

const PRICE_FORMAT = {
  type: "price" as const,
  precision: 1,
  minMove: 0.1,
};

function setTabTitle(price: number) {
  const s = price.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  document.title = `$${s} BTC fuck-your-chart`;
}

/** Format HH:mm for axis tick marks. Each call remembers the previously
 *  formatted tick's day-of-week so we can prefix "Mon ", "Tue ", ... on the
 *  first tick of a new calendar day (in the chosen timezone). This mirrors
 *  the day-label rendering used by TradingView's chart axis. */
function makeTickFormatter(tz: TzOffset): (t: Time) => string {
  let prevDay = -1;
  return (t: Time) => {
    const epoch = t as number;
    const d = new Date((epoch + tz * 3600) * 1000);
    const dow = d.getUTCDay();
    const hhmm = fmtTime(epoch, tz);
    if (dow !== prevDay) {
      prevDay = dow;
      return `${DAY[dow]} ${hhmm}`;
    }
    return hhmm;
  };
}

export interface Zones {
  prevWeek: { high: number; low: number } | null;
  monday: { high: number; low: number } | null;
  prevDay: { high: number; low: number; mid: number; p25: number; p75: number } | null;
  weekend: { high: number; low: number; mid: number } | null;
}

export interface LineToggles {
  weekly: boolean;
  monday: boolean;
  pdhlm: boolean;
  fibb: boolean;
  weekend: boolean;
}

export type CustomLevelColor = "red" | "yellow" | "green";

export interface CustomLevel {
  price: number;
  color: CustomLevelColor;
}

interface Props {
  /** Timeframe string from Binance ("1m", "3m", "5m"). */
  interval: string;
  heikin?: boolean;
  emas?: number[];
  /** EMAs that should start in the OFF state (line hidden, chip darkened). */
  defaultEmaOff?: number[];
  /** Display timezone offset (hours). Shared global state from page. */
  tz?: TzOffset;
  /** Horizontal levels from the calendar date (does not move the chart). */
  zones?: Zones | null;
  lineToggles?: LineToggles;
  customLevels?: CustomLevel[];
  /** Register this chart's time scale so siblings can mirror zoom/pan. */
  registerTimeScale?: (api: ITimeScaleApi<Time> | null) => void;
  siblingScales?: React.MutableRefObject<ITimeScaleApi<Time>[]>;
  /** Register this chart's right price scale so siblings mirror vertical range. */
  registerPriceScale?: (api: IPriceScaleApi | null) => void;
  siblingPriceScales?: React.MutableRefObject<IPriceScaleApi[]>;
  /** Shared boolean lock that prevents echo-loops when sibling price scales
   *  sync each other via the RAF polling mechanism. */
  priceScaleLock?: React.MutableRefObject<boolean>;
}

export default function Chart({
  interval,
  heikin = false,
  emas = [],
  defaultEmaOff = [],
  tz = 0,
  zones = null,
  lineToggles = { weekly: true, monday: false, pdhlm: true, fibb: false, weekend: false },
  customLevels = [],
  registerTimeScale,
  siblingScales,
  registerPriceScale,
  siblingPriceScales,
  priceScaleLock,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** Invisible future timestamps so the axis labels 16:00→20:00 without
   *  sitting on the candle series (LWC update() can only touch the last point). */
  const futureRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  const rightScaleRef = useRef<IPriceScaleApi | null>(null);
  const cacheRef = useRef<Kline[]>([]);
  /** Bars currently drawn on the candle series (raw or Heikin Ashi). EMA
   *  and the OHLC hover legend both read this so they track the chart. */
  const displayCacheRef = useRef<Kline[]>([]);
  /** Zone price-line handles — redrawn when calendar date or toggles change. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zoneLinesRef = useRef<any[]>([]);
  /**
   * Heikin Ashi rolling state — two slots:
   *
   * `lastClosedHaRef` — the HA open/close of the most-recently **closed** bar.
   *   This is the stable anchor used as `prevHAOpen / prevHAClose` when we
   *   compute the live (still-open) bar.  It only advances when `k.closed`.
   *
   * `lastHaRef` — kept for backwards-compat (history seeding); always equals
   *   `lastClosedHaRef` after every closed bar.
   *
   * Why two refs?  Because Binance pushes a tick every ~250 ms for the
   * still-open bar.  If we overwrote `lastHaRef` on every tick, the rolling
   * HA open of the *next* bar (= (prevHAOpen + prevHAClose) / 2) would be
   * derived from an intra-bar mid-state instead of the settled OHLC of the
   * closed bar, causing the HA chain to drift visually.
   */
  const lastHaRef = useRef<{ open: number; close: number } | null>(null);
  const lastClosedHaRef = useRef<{ open: number; close: number } | null>(null);
  /** True while the user's visible range covers the latest bar. When the user
   *  drags left into history we set this to false and stop auto-following. */
  const pinnedToRightRef = useRef(true);
  /** Skip 1m sibling range copies while we are still placing the default view. */
  const suppressTimeSyncRef = useRef(true);
  const [status, setStatus] = useState<"connecting" | "live" | "off">("connecting");
  const [chartReady, setChartReady] = useState(false);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);

  // OHLC hover legend (TradingView style) — shown on every chart.
  const [hover, setHover] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
  } | null>(null);

  /** Right-click context menu state. */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  /** Currently-selected display timezone — comes from the top bar. */

  /** Per-EMA on/off state. Default: all on, except those in `defaultEmaOff`
   *  (e.g. 50/200 on the 1m charts which are noisy by default). */
  const [emaEnabled, setEmaEnabled] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (const p of emas) {
      if (!defaultEmaOff.includes(p)) s.add(p);
    }
    return s;
  });
  const emaEnabledRef = useRef(emaEnabled);
  emaEnabledRef.current = emaEnabled;

  /** Keep `emaEnabled` in sync if `emas` ever changes. */
  useEffect(() => {
    setEmaEnabled(() => {
      const next = new Set<number>();
      for (const p of emas) {
        if (!defaultEmaOff.includes(p)) next.add(p);
      }
      return next;
    });
  }, [emas, defaultEmaOff]);

  /** Candle series the user actually sees — raw OHLC or Heikin Ashi. */
  const displayedBars = (raw: Kline[]): Kline[] => (heikin ? toHeikin(raw) : raw);

  /** Paint every EMA from the displayed series close (raw or HA). */
  const paintEmas = (bars: Kline[]) => {
    const values = bars.map((b) => b.close);
    const enabled = emaEnabledRef.current;
    for (let i = 0; i < emas.length; i++) {
      const period = emas[i]!;
      const line = emaRefs.current[i];
      if (!line) continue;
      if (!enabled.has(period)) {
        line.setData([]);
        continue;
      }
      const smoothed = ema(values, period);
      const data = smoothed.map((v, j) => ({ time: bars[j]!.time as Time, value: v }));
      line.setData(data);
    }
  };

  /** (Re)compute every EMA line series from the current cached RAW bars. */
  const recomputeEmas = (raw: Kline[]) => {
    cacheRef.current = raw.slice();
    const bars = displayedBars(raw);
    displayCacheRef.current = bars;
    paintEmas(bars);
  };

  /** Toggle a single EMA on/off (line series visibility + chip darken). */
  const toggleEma = (period: number) => {
    setEmaEnabled((prev) => {
      const next = new Set(prev);
      let isNowOn: boolean;
      if (next.has(period)) {
        next.delete(period);
        isNowOn = false;
      } else {
        next.add(period);
        isNowOn = true;
      }
      emaEnabledRef.current = next;
      const idx = emas.indexOf(period);
      const line = idx >= 0 ? emaRefs.current[idx] : undefined;
      if (line) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        line.applyOptions({ visible: isNowOn } as any);
        if (!isNowOn) {
          line.setData([]);
        } else {
          const bars = displayCacheRef.current.length > 0
            ? displayCacheRef.current
            : displayedBars(cacheRef.current);
          if (bars.length > 0) {
            const values = bars.map((b) => b.close);
            const smoothed = ema(values, period);
            const data = smoothed.map((v, j) => ({ time: bars[j]!.time as Time, value: v }));
            line.setData(data);
          }
        }
      }
      return next;
    });
  };

  /** CoinGlass-style default: fat enough candles, latest bar on the right.
   *  Used on first history load, first real layout, and right-click reset.
   *  Never fitContent() — that crams all 500 bars into the pane. */
  const applyDefaultView = () => {
    const c = chartRef.current;
    if (!c) return;
    if (cacheRef.current.length === 0) return;
    const el = containerRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    if (w < 40 || h < 40) return;

    suppressTimeSyncRef.current = true;
    pinnedToRightRef.current = true;
    const ts = c.timeScale();
    ts.applyOptions({
      barSpacing: TARGET_BAR_SPACING,
      rightOffset: RIGHT_GAP_BARS,
    });
    // Pin the live candle near the right. Do NOT scrollToRealTime() — that
    // would jump to the dummy future series (~4h of empty).
    const total = cacheRef.current.length;
    const slots = Math.max(40, Math.floor((w - 70) / TARGET_BAR_SPACING));
    const futureSlots = Math.min(
      futureBarCount(interval),
      Math.max(4, Math.floor(slots * 0.2)),
    );
    const range = {
      from: Math.max(0, total - (slots - futureSlots)),
      to: total + futureSlots,
    };
    ts.setVisibleLogicalRange(range);
    for (const sibling of siblingScales?.current ?? []) {
      if (sibling !== ts) sibling.setVisibleLogicalRange(range);
    }
    rightScaleRef.current?.setAutoScale(true);
    for (const sibling of siblingPriceScales?.current ?? []) {
      if (sibling !== rightScaleRef.current) sibling.setAutoScale(true);
    }
    requestAnimationFrame(() => {
      suppressTimeSyncRef.current = false;
    });
  };

  /** Reset BOTH axes — same framing as first load, not fit-to-all-history. */
  const resetView = () => {
    applyDefaultView();
  };

  // --- chart bootstrap (once per mount) ------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#787b87",
        fontSize: 10,
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        // Hide the TradingView attribution watermark.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attributionLogo: false as any,
      },
      // No background grid.
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#787b86", width: 1, style: 1, labelBackgroundColor: "#2a2e39" },
        horzLine: { color: "#787b86", width: 1, style: 1, labelBackgroundColor: "#2a2e39" },
      },
      localization: makeLocalization(tz),
      rightPriceScale: {
        borderColor: "#2a2e39",
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#2a2e39",
        timeVisible: true,
        // secondsVisible defaults to false — keep it off so the axis doesn't
        // re-tick every second on live 1m updates (which was making the labels
        // shift sideways visually). HH:MM resolution is plenty.
        secondsVisible: false,
        rightOffset: RIGHT_GAP_BARS,
        barSpacing: TARGET_BAR_SPACING,
        // Keep the left edge free so a 0-width mount → real size doesn't pin
        // the first bar to the left and leave a huge empty gap on the right.
        fixLeftEdge: false,
        fixRightEdge: false,
        tickMarkFormatter: makeTickFormatter(tz),
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
      },
      autoSize: true,
    });
    chartRef.current = chart;
    setChartReady(true);

    // Default right price scale (used by every series on this chart).
    const right = chart.priceScale("right");
    rightScaleRef.current = right;

    // Single series: candles + EMAs. No volume.
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: PRICE_FORMAT,
    });
    candleRef.current = candle;

    const futureLine = chart.addSeries(LineSeries, {
      color: "rgba(0,0,0,0)",
      lineVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
      priceFormat: PRICE_FORMAT,
    });
    futureRef.current = futureLine;

    // EMA line series — solid, no dots/point markers.
    const refs: ISeriesApi<"Line">[] = emas.map((period) => {
      const color = EMA_COLOR[period] ?? "#ffffff";
      const width = EMA_LINE_WIDTH[period] ?? 2;
      const line = chart.addSeries(LineSeries, {
        color,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineWidth: width as any,
        lineStyle: LineStyle.Solid,
        pointMarkersVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: PRICE_FORMAT,
        crosshairMarkerVisible: false,
      });
      return line;
    });
    emaRefs.current = refs;

    // --- Time-scale sync ----------------------------------------------------
    const ts = chart.timeScale();
    let tOriginating = false;
    const onTimeRange = () => {
      if (tOriginating) return;
      if (suppressTimeSyncRef.current) return;
      if (cacheRef.current.length === 0) return;
      tOriginating = true;
      try {
        const siblings = siblingScales?.current ?? [];
        const siblingPrices = siblingPriceScales?.current ?? [];
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const cached = cacheRef.current;
        const totalBars = cached.length + futureBarCount(interval) + RIGHT_GAP_BARS;
        const distFromRight = totalBars - range.to;
        pinnedToRightRef.current = distFromRight < 3;
        if (range.from < 30) {
          void loadOlderHistory(interval);
        }
        for (const sib of siblings) {
          if (sib && sib !== ts) sib.setVisibleLogicalRange(range);
        }
        for (const sib of siblingPrices) {
          if (sib && sib !== right) sib.setAutoScale(true);
        }
      } finally {
        setTimeout(() => {
          tOriginating = false;
        }, 0);
      }
    };
    ts.subscribeVisibleLogicalRangeChange(onTimeRange);
    registerTimeScale?.(ts);
    registerPriceScale?.(right);

    // ── Price-scale sync via RAF polling ─────────────────────────────────
    // LWC has no event for manual price-scale drags, so we poll every frame.
    // When a change is detected and the shared lock is free, we apply the new
    // range to every sibling and hold the lock for one frame to stop the
    // sibling's own RAF from echoing the value back.
    let rafId = 0;
    if (siblingPriceScales && priceScaleLock) {
      let lastMin = NaN;
      let lastMax = NaN;
      const rafSync = () => {
        if (!priceScaleLock.current) {
          const r = right.getVisibleRange();
          if (r && (r.from !== lastMin || r.to !== lastMax)) {
            lastMin = r.from;
            lastMax = r.to;
            priceScaleLock.current = true;
            for (const sib of siblingPriceScales.current) {
              if (sib && sib !== right) {
                sib.setVisibleRange({ from: r.from, to: r.to });
              }
            }
            requestAnimationFrame(() => { priceScaleLock.current = false; });
          }
        }
        rafId = requestAnimationFrame(rafSync);
      };
      rafId = requestAnimationFrame(rafSync);
    }

    // OHLC hover legend — find the bar closest to the cursor's time.
    const onCrosshair = (p: MouseEventParams) => {
      if (!p.time) {
        setHover(null);
        return;
      }
      const t = p.time as number;
      const cached = displayCacheRef.current;
      const lastReal = cached.length > 0 ? cached[cached.length - 1]!.time : 0;
      if (lastReal > 0 && t > lastReal) {
        setHover(null);
        return;
      }
      let found: Kline | undefined;
      for (let i = cached.length - 1; i >= 0; i--) {
        const b = cached[i]!;
        if (b.time <= t) {
          found = b;
          break;
        }
      }
      if (!found) {
        setHover(null);
        return;
      }
      const idx = cached.indexOf(found);
      const prev = idx > 0 ? cached[idx - 1]! : null;
      const baseline = prev ? prev.close : found.open;
      const delta = ((found.close - baseline) / (baseline || 1)) * 100;
      setHover({
        open: found.open,
        high: found.high,
        low: found.low,
        close: found.close,
        change: delta,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // Right-click anywhere in the chart -> open the custom context menu.
    const el = containerRef.current;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    };
    el?.addEventListener("contextmenu", onContext);

    // Place the default view once the cell has a real size AND history is in.
    // Do not fitContent() on an empty/0-width chart — that is what left the
    // 1m panes stuck on the left with a huge empty gap.
    const ro = new ResizeObserver(() => {
      if (!chartRef.current) return;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      if (w > 40 && h > 40 && cacheRef.current.length > 0) {
        applyDefaultView();
        ro.disconnect();
      }
    });

    if (el) ro.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      el?.removeEventListener("contextmenu", onContext);
      const sibs = siblingScales?.current;
      if (sibs) {
        const i = sibs.indexOf(ts);
        if (i >= 0) sibs.splice(i, 1);
      }
      const prices = siblingPriceScales?.current;
      if (prices) {
        const i = prices.indexOf(right);
        if (i >= 0) prices.splice(i, 1);
      }
      registerTimeScale?.(null);
      registerPriceScale?.(null);
      chart.remove();
      chartRef.current = null;
      setChartReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply tick formatter when the timezone changes.
  // Do NOT call resetTimeScale() here — that would wipe the user's current
  // pan/zoom position every time they switch TZ.
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      timeScale: { tickMarkFormatter: makeTickFormatter(tz) },
      localization: makeLocalization(tz),
    });
  }, [tz]);

  // Horizontal levels from zones.py — calendar date is the reference day only.
  // Purple thick = Prev 1W H/L. Blue thick = this week's Monday H/L.
  // White thick = PDH/PDL. White dash = Prev 1D mid.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of zoneLinesRef.current) {
      try { series.removePriceLine(pl); } catch (_) { /* already removed */ }
    }
    zoneLinesRef.current = [];
    if (!zones) return;

    const add = (
      price: number,
      color: string,
      width: 1 | 2 | 3 | 4,
      style: LineStyle,
      title: string,
    ) => {
      zoneLinesRef.current.push(
        series.createPriceLine({
          price: roundHalf(price),
          color,
          lineWidth: width,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    if (lineToggles.weekly && zones.prevWeek) {
      add(zones.prevWeek.high, "#ce93d8", 2, LineStyle.Solid, "PWH");
      add(zones.prevWeek.low, "#ce93d8", 2, LineStyle.Solid, "PWL");
    }
    if (lineToggles.monday && zones.monday) {
      add(zones.monday.high, "#42a5f5", 2, LineStyle.Solid, "MH");
      add(zones.monday.low, "#42a5f5", 2, LineStyle.Solid, "ML");
    }
    if (lineToggles.pdhlm && zones.prevDay) {
      add(zones.prevDay.high, "#ffffff", 2, LineStyle.Solid, "PDH");
      add(zones.prevDay.mid, "rgba(255,255,255,0.85)", 2, LineStyle.Dashed, "PDM");
      add(zones.prevDay.low, "#ffffff", 2, LineStyle.Solid, "PDL");
    }
    if (lineToggles.fibb && zones.prevDay) {
      add(zones.prevDay.p75, "#ffeb3b", 2, LineStyle.Dotted, "75%");
      add(zones.prevDay.p25, "#ffeb3b", 2, LineStyle.Dotted, "25%");
    }
    if (lineToggles.weekend && zones.weekend) {
      add(zones.weekend.high, "#ffffff", 2, LineStyle.Solid, "WH");
      add(zones.weekend.mid, "rgba(255,255,255,0.85)", 2, LineStyle.Dashed, "WM");
      add(zones.weekend.low, "#ffffff", 2, LineStyle.Solid, "WL");
    }
    for (let i = 0; i < customLevels.length; i++) {
      const level = customLevels[i]!;
      const color = level.color === "red"
        ? "#ef5350"
        : level.color === "green"
          ? "#7cfc00"
          : "#ffeb3b";
      add(level.price, color, 3, LineStyle.Solid, `C${i + 1}`);
    }
  }, [zones, lineToggles, customLevels, chartReady]);

  // --- socket: history + live updates --------------------------------------
  useEffect(() => {
    const sock: Socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });

    sock.on("connect", () => setStatus("live"));
    sock.on("disconnect", () => setStatus("off"));
    sock.on("connect_error", () => setStatus("off"));

    sock.on("price", (p: number) => {
      if (interval === "1m" && !heikin) setTabTitle(p);
    });

    sock.on("history", (payload: Record<string, Kline[]>) => {
      const raw = payload[interval];
      if (!raw || !candleRef.current) return;
      seedHistory(interval, raw);
      let series: Kline[];
      if (heikin) {
        const built = heikinSeriesAndAnchor(raw);
        series = built.series;
        lastClosedHaRef.current = built.lastClosed;
        lastHaRef.current = built.lastClosed;
      } else {
        series = raw;
        lastHaRef.current = null;
        lastClosedHaRef.current = null;
      }

      // Candles only — future times live on `futureRef` so live `update()`
      // can still mutate the last real bar.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      displayCacheRef.current = series;
      if (series.length > 0) {
        const lastBar = series[series.length - 1]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
        setLastPrice(lastBar.close);
        if (interval === "1m" && !heikin) setTabTitle(lastBar.close);
        const first = raw[0]!.open;
        setChange(first === 0 ? 0 : ((lastBar.close - first) / first) * 100);
        recomputeEmas(raw);
      }
      // Frame the latest candles after layout. Two rAFs wait for autoSize to
      // pick up the cell's real width (0-width mount otherwise looks empty).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyDefaultView());
      });
    });

    sock.on("kline", (msg: { interval: string; k: Kline }) => {
      if (msg.interval !== interval) return;
      if (!candleRef.current) return;
      if (cacheRef.current.length === 0) return;
      const k = msg.k;

      // ── Timestamp normalisation ──────────────────────────────────────────
      // Lightweight Charts requires UTC **seconds**.  The server already does
      // Math.floor(t / 1000) in binance.ts, but we guard again here so any
      // future raw-ms value is always normalised before touching the series.
      const timeSec: number =
        k.time > 1e10 ? Math.floor(k.time / 1000) : k.time;
      const bar: Kline = { ...k, time: timeSec };

      // ── Per-interval timestamp cache (prevents cross-timeframe pollution) ─
      // `cacheRef` is scoped to this single Chart instance (one interval),
      // so each chart keeps its own independent lastTime.
      const cached = cacheRef.current;
      const prevTime = cached.length > 0 ? cached[cached.length - 1]!.time : 0;

      // Strict comparison: same time → still-open bar update; greater → new bar.
      const isNewBar = timeSec > prevTime;
      const isSameBar = timeSec === prevTime;
      if (!isNewBar && !isSameBar) return;

      // A stream can deliver the next bar before the prior bar's final update.
      // Settle that prior bar first so the new HA open uses the correct anchor.
      if (heikin && isNewBar && cached.length > 0) {
        const previousRaw = cached[cached.length - 1]!;
        if (!previousRaw.closed) {
          const finalizedRaw = { ...previousRaw, closed: true };
          cached[cached.length - 1] = finalizedRaw;
          applyLiveKline(interval, finalizedRaw);

          const finalizedHa = toHeikin(cached)[cached.length - 1]!;
          lastClosedHaRef.current = { open: finalizedHa.open, close: finalizedHa.close };
          lastHaRef.current = lastClosedHaRef.current;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          candleRef.current.update(finalizedHa as any);
          const displayed = displayCacheRef.current;
          if (displayed.length > 0) displayed[displayed.length - 1] = finalizedHa;
        }
      }

      // ── RAW cache update ──────────────────────────────────────────────────
      // We always keep the RAW bars; HA is derived on-the-fly from these.
      if (isNewBar) {
        // Guard: if the cache was empty (first tick before history arrived)
        // just push; otherwise append normally.
        cached.push(bar);
      } else if (isSameBar && cached.length > 0) {
        // Replace the last (still-open) bar in-place.
        cached[cached.length - 1] = bar;
      }
      applyLiveKline(interval, bar);

      // Recompute from the canonical raw cache so a missed close packet cannot
      // leave the rolling HA anchor one bar behind.
      let candlePayload: Kline = bar;
      if (heikin) {
        const ha = toHeikin(cached)[cached.length - 1]!;
        if (bar.closed) {
          lastClosedHaRef.current = { open: ha.open, close: ha.close };
          lastHaRef.current = { open: ha.open, close: ha.close };
        }
        candlePayload = ha;
      }

      // ── Series update ─────────────────────────────────────────────────────
      // series.update() with the same timestamp overwrites the bar in-place;
      // a greater timestamp appends a new bar to the right.
      // Last point on the candle series is the live bar, so update() applies.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.update(candlePayload as any);
      if (isNewBar && futureRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current.setData(futureWhitespace(timeSec, interval) as any);
      }

      setLastPrice(candlePayload.close);
      if (interval === "1m" && !heikin) setTabTitle(bar.close);

      // ── EMA update (from the displayed close: raw or Heikin Ashi) ────────
      // Incremental: instead of rerunning toHeikin(cached) for every tick
      // (O(n) per tick with 10k+ bars), we update displayCacheRef in-place
      // using the already-computed candlePayload.
      const displayed = displayCacheRef.current;
      if (isNewBar) {
        displayed.push(candlePayload);
      } else if (isSameBar && displayed.length > 0) {
        displayed[displayed.length - 1] = candlePayload;
      }
      if (displayed.length > 0 && emas.length > 0) {
        const values = displayed.map((c) => c.close);
        for (let i = 0; i < emas.length; i++) {
          const period = emas[i]!;
          const line = emaRefs.current[i];
          if (!line) continue;
          if (!emaEnabledRef.current.has(period)) continue;
          const smoothed = ema(values, period);
          const tail = smoothed[smoothed.length - 1];
          if (typeof tail === "number") {
            line.update({ time: timeSec as Time, value: tail });
          }
        }
      }

      // ── Viewport advance ─────────────────────────────────────────────────
      // Shift the logical range by 1 only when a new bar opens — not on every
      // intra-bar tick.  Without this guard the chart jumps every ~250 ms.
      if (chartRef.current && pinnedToRightRef.current && isNewBar) {
        const ts = chartRef.current.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (range) {
          ts.setVisibleLogicalRange({
            from: range.from + 1,
            to: range.to + 1,
          });
        }
      }
    });

    return () => {
      sock.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, heikin]);

  // Older history prepended (this pane or a sibling 1m pane). Rebuild the
  // series and shift the visible range by the new bar count so the view
  // does not jump.
  useEffect(() => {
    return subscribeHistory(interval, (ev) => {
      if (ev.reason !== "prepend" || ev.prepended <= 0) return;
      const raw = getHistory(interval);
      if (!candleRef.current || !chartRef.current || raw.length === 0) return;
      if (cacheRef.current[0]?.time === raw[0]?.time) return;

      suppressTimeSyncRef.current = true;
      const ts = chartRef.current.timeScale();
      const range = ts.getVisibleLogicalRange();
      cacheRef.current = raw.slice();
      let series: Kline[];
      if (heikin) {
        const built = heikinSeriesAndAnchor(raw);
        series = built.series;
        lastClosedHaRef.current = built.lastClosed;
        lastHaRef.current = built.lastClosed;
      } else {
        series = raw;
      }
      displayCacheRef.current = series;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      if (series.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(
          futureWhitespace(series[series.length - 1]!.time, interval) as any,
        );
      }
      paintEmas(series);
      if (range) {
        ts.setVisibleLogicalRange({
          from: range.from + ev.prepended,
          to: range.to + ev.prepended,
        });
      }
      requestAnimationFrame(() => {
        suppressTimeSyncRef.current = false;
      });
    });
  }, [interval, heikin]);

  const fmt = (n: number | null) =>
    n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });


  // EMA legend chips — CLICKABLE to toggle the line on/off. "Off" chips are
  // darkened (mixed with the dark cell background) so the user can see at a
  // glance which EMAs are active.
  const emaLegend = emas.map((p) => {
    const on = emaEnabled.has(p);
    const baseColor = EMA_COLOR[p] ?? "#fff";
    const bg = on ? baseColor : darken(baseColor, 0.7);
    const text = on ? "#0b0e13" : "#787b87";
    return (
      <button
        key={p}
        type="button"
        className={`ema-chip${on ? "" : " off"}`}
        style={{ background: bg, color: text }}
        title={`EMA ${p} — click to ${on ? "hide" : "show"}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleEma(p);
        }}
      >
        <span className="chip-num">{p}</span>
      </button>
    );
  });

  return (
    <>
      {/* Header — symbol + venue + tf + clickable EMA chips. Shown on every
          cell (3m and both 1m charts). */}
      <div className="cell-header">
        <span className="symbol">BTCUSDT</span>
        <span className="venue">Binance Futures</span>
        <span className="tf">
          {interval}
          {heikin ? " · Heikin Ashi" : ""}
        </span>
        <div className="ema-group">{emaLegend}</div>
        {hover && (
          <div className="ohlc-bar">
            <span><b>O</b> {fmt(hover.open)}</span>
            <span><b>H</b> {fmt(hover.high)}</span>
            <span><b>L</b> {fmt(hover.low)}</span>
            <span><b>C</b> {fmt(hover.close)}</span>
            <span className={hover.change >= 0 ? "up" : "down"}>
              {hover.change >= 0 ? "+" : ""}
              {hover.change.toFixed(2)}%
            </span>
          </div>
        )}
      </div>

      {/* Footer removed: no live label, no TZ dropdown per chart.
          TZ is controlled by the single global dropdown (bottom-right of screen). */}

      <div
        ref={containerRef}
        className="chart-canvas"
        style={{ width: "100%", height: "100%", cursor: "crosshair" }}
      />

      {/* Right-click context menu — "Reset price scale". */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
          }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              resetView();
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <polyline points="3 4 3 9 8 9" />
            </svg>
            Reset
          </button>
        </div>
      )}

      {/* Dismiss the context menu on any global click. */}
      <ContextMenuDismiss onAnyClick={() => setContextMenu(null)} />
    </>
  );
}

/** Tiny no-op component that listens for global clicks to close the context
 *  menu. Mounted as a side-effect-only child so the listener is cleaned up
 *  automatically when this chart unmounts. */
function ContextMenuDismiss({ onAnyClick }: { onAnyClick: () => void }) {
  useEffect(() => {
    const dismiss = () => onAnyClick();
    document.addEventListener("click", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [onAnyClick]);
  return null;
}