"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
  type MouseEventParams,
  type IChartApi,
  type ISeriesApi,
  type IPriceScaleApi,
  type ITimeScaleApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type Time,
} from "lightweight-charts";
import {
  cleanAndSort,
  fetchLatestKlines,
  fetchOlderKlines,
  getHistory,
  seedHistory,
  type Kline,
} from "../lib/historyStore";
import type { EmaAlert, PriceAlert } from "../lib/alertStore";

// ---------------------------------------------------------------------------
// DailyOpenPrimitive — draws a vertical dotted line at every UTC 00:00 boundary
// visible on the chart (= 08:00 UTC+8 = new daily candle open).
// Attached to the candlestick series via series.attachPrimitive().
// ---------------------------------------------------------------------------
import type { CanvasRenderingTarget2D } from "fancy-canvas";

class DailyOpenPrimitive implements ISeriesPrimitive<Time> {
  private _params: SeriesAttachedParameter<Time> | null = null;

  attached(params: SeriesAttachedParameter<Time>) {
    this._params = params;
  }
  detached() {
    this._params = null;
  }

  paneViews() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        renderer() {
          return {
            draw(target: CanvasRenderingTarget2D) {
              if (!self._params) return;
              const chart = self._params.chart as IChartApi;
              const ts = chart.timeScale();

              target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
                const { width, height } = mediaSize;

                const timeFrom = ts.coordinateToTime(0);
                const timeTo = ts.coordinateToTime(width);
                if (timeFrom == null || timeTo == null) return;

                const fromEpoch = timeFrom as number;
                const toEpoch = timeTo as number;

                // Walk UTC midnight timestamps visible in this range
                const DAY_SEC = 86400;
                let t = Math.floor(fromEpoch / DAY_SEC) * DAY_SEC;
                if (t < fromEpoch) t += DAY_SEC;

                ctx.save();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);

                while (t <= toEpoch + DAY_SEC) {
                  const x = ts.timeToCoordinate(t as Time);
                  if (x !== null) {
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, height);
                    ctx.stroke();
                  }
                  t += DAY_SEC;
                }

                ctx.restore();
              });
            },
          };
        },
      },
    ];
  }
}

// Timeframes where we show the daily-open vertical dotted line.
// Excluded: 4h and above (the axis tick already makes it obvious).
const SHOW_DAILY_LINE_TF = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h"]);

interface HoverData {
  open: string;
  high: string;
  low: string;
  close: string;
  delta: string;
  deltaColor: string;
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
    out.push({ time: cur.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: cur.volume, takerBuyVolume: cur.takerBuyVolume, closed: cur.closed });
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
  return { time: cur.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: cur.volume, takerBuyVolume: cur.takerBuyVolume, closed: cur.closed };
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
  10: "#ee6702", // orange
  20: "#3f9744", // green
  50: "#ee8f02", // yellow-orange
  200: "#da1e5e", // pinkish red
};
const EMA_LINE_WIDTH: Record<number, number> = {
  10: 1.5,
  20: 1.5,
  50: 2.5,
  200: 2.5,
};

/** Default zoom: ~6px per bar so candles stay readable with a wider view.
 *  Visible bar count then follows pane width instead of stuffing 500 bars in. */
const TARGET_BAR_SPACING = 6;
/** Tiny extra pad after the last *future* whitespace bar. */
const RIGHT_GAP_BARS = 2;

function getTargetBarSpacing(_interval?: string): number {
  return TARGET_BAR_SPACING;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTfLabel(interval: string): string {
  const m = /^(\d+)m$/i.exec(interval);
  if (m) return m[1]!;
  if (interval.toLowerCase() === "1d") return "1D";
  return interval.toUpperCase();
}

function intervalSeconds(interval: string): number {
  const m = /^(\d+)([mhd])$/i.exec(interval);
  if (!m) return 60;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return n * 86400;
}

/** Extended future window for unprinted candles so timestamps extend all the way across. */
function futureBarCount(interval: string): number {
  const sec = intervalSeconds(interval);
  if (sec >= 86400) return 365; // 1 year for 1d
  if (sec >= 14400) return 500; // ~83 days for 4h
  if (sec >= 3600) return 1000; // ~41 days for 1h
  if (sec >= 1800) return 1200; // 25 days for 30m
  return 1500;                  // 1500 bars for 1m, 3m, 5m, 15m
}

/** Snap level prices to 0.0 / 0.5 / 1.0 (0.45 → 0.5) for BTCUSDT. */
function roundPrice(n: number): number {
  return Math.round(n * 2) / 2;
}

function formatCountdown(interval: string, barTime: number): string {
  const step = intervalSeconds(interval);
  const closeTime = barTime + step;
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, closeTime - now);
  if (remaining >= 3600) {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
const DEFAULT_BAR_SPACING = 6;
const DEFAULT_RIGHT_OFFSET = 6;

/** Darken an `#rrggbb` colour by mixing it with the dark cell background. */
function darken(hex: string, mix = 0.7): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  const dr = Math.round(r * (1 - mix) + 20 * mix);
  const dg = Math.round(g * (1 - mix) + 24 * mix);
  const db = Math.round(b * (1 - mix) + 35 * mix);
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
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTH[d.getUTCMonth()] ?? "";
  const yr = String(d.getUTCFullYear()).slice(-2);
  return `${dow} ${day} ${mon} '${yr} ${fmtTime(epoch, tz)}`;
}

function makeLocalization(tz: TzOffset) {
  let lastEpoch: number | null = null;
  let lastFormattedTime = "";
  return {
    timeFormatter: (t: Time) => {
      const epoch = t as number;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        lastFormattedTime = fmtCrosshairTime(t, tz);
      }
      return lastFormattedTime;
    },
    priceFormatter: (p: number) => formatPrice(p),
  };
}

function getMinMove(): number {
  return 1;
}

function formatPrice(price: number): string {
  return String(Math.round(price));
}

function setTabTitle(price: number) {
  const s = price.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  document.title = `$${s} BTC fuck-your-chart`;
}

function copyToLegacyClipboard(text: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-999999px";
  document.body.appendChild(textArea);
  try {
    textArea.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

function findBarIndex(bars: Kline[], time: number, exact = false): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (bars[mid]!.time < time) low = mid + 1;
    else high = mid;
  }
  if (exact) return bars[low]?.time === time ? low : -1;
  return low < bars.length && bars[low]!.time === time ? low : low - 1;
}

/** Format HH:mm for axis tick marks. Each call remembers the previously
 * formatted tick's day-of-week so we can prefix "Mon ", "Tue ", ... on the
 * first tick of a new calendar day (in the chosen timezone). This mirrors
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

export const CUSTOM_LEVEL_COLORS: Record<CustomLevelColor, string> = {
  red: "#ef3b43",
  yellow: "#f8ea3b",
  green: "#52b758",
};

export interface CustomLevel {
  price: number;
  color: CustomLevelColor;
}

export type LinkedCrosshairId = "raw" | "heikin" | "heikin-bottom";
export type LinkedCrosshairSync = (time: number | null) => void;

// ---- HTF (Higher-Timeframe) EMA types & config ----
// 3 individual toggles: 15m200, 1h200, 4h200.
export type HtfEmaKey = "15m200" | "1h200" | "4h200";
export type HtfInterval = "5m" | "15m" | "1h" | "4h";
export interface HtfEmaConfig {
  key: HtfEmaKey;
  interval: HtfInterval;
  period: 50 | 150 | 200;
  color: string;
  label: string;
}
export const HTF_EMA_CONFIGS: HtfEmaConfig[] = [
  { key: "15m200", interval: "15m", period: 200, color: "#42a5f5", label: "15m" },
  { key: "1h200", interval: "1h", period: 200, color: "#ab47bc", label: "1h" },
  { key: "4h200", interval: "4h", period: 200, color: "#ef5350", label: "4h" },
];
export const HTF_INTERVAL_STEP: Record<HtfInterval, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 };

export const makeHtfEnabledDefault = (): Record<HtfEmaKey, boolean> => ({
  "15m200": false,
  "1h200": false,
  "4h200": false,
});

const DEFAULT_EMAS: number[] = [10, 20, 50, 200];
const DEFAULT_EMA_OFF: number[] = [];

interface Props {
  symbol?: string;
  /** Timeframe string from Binance ("1m", "3m", "5m"). */
  interval: string;
  heikin?: boolean;
  emas?: number[];
  /** EMAs that should start in the OFF state (line hidden, chip darkened). */
  defaultEmaOff?: number[];
  /** Whether footprint is supported on this chart. */
  allowFootprint?: boolean;
  /** Whether the footprint pane is visible on first mount. */
  defaultFootprintEnabled?: boolean;
  /** Whether the price levels (zones and custom) are visible on first mount. */
  defaultLevelsEnabled?: boolean;
  /** Controlled state for whether price levels are enabled. */
  levelsEnabled?: boolean;
  /** Callback fired when user toggles the Level chip. */
  onLevelsEnabledChange?: (enabled: boolean) => void;
  /** Display timezone offset (hours). Shared global state from page. */
  tz?: TzOffset;
  /** Horizontal levels from the calendar date (does not move the chart). */
  zones?: Zones | null;
  lineToggles?: LineToggles;
  customLevels?: CustomLevel[];
  onDeleteCustomLevel?: (price: number) => void;
  onEditCustomLevel?: (oldPrice: number, newPrice: number) => void;
  onChartDoubleClick?: () => void;
  registerTimeScale?: (api: ITimeScaleApi<Time> | null) => void;
  siblingScales?: React.MutableRefObject<ITimeScaleApi<Time>[]>;
  linkedCrosshairId?: LinkedCrosshairId;
  registerLinkedCrosshair?: (
    id: LinkedCrosshairId,
    sync: LinkedCrosshairSync | null,
  ) => void;
  onLinkedCrosshair?: (id: LinkedCrosshairId, time: number | null) => void;
  /** Enable 1h / 4h higher-timeframe EMA toggles (50 & 200 EMA from those TFs). */
  allowHtfEma?: boolean;
  htfEnabled?: Record<HtfEmaKey, boolean>;
  onHtfEnabledChange?: (state: Record<HtfEmaKey, boolean>) => void;
  onRegisterScreenshot?: (getScreenshot: (() => HTMLCanvasElement | null) | null) => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  /** Called after "Reset Price Scale" so the caller can reset sibling charts too. */
  onResetView?: () => void;
  /** Called on mount/unmount so the parent can invoke resetView() imperatively on a sibling. */
  registerResetView?: (fn: (() => void) | null) => void;

  // ---- Alert props (only wired in default layout mode) ----
  /** EMA alerts active on this chart instance. */
  emaAlerts?: EmaAlert[];
  /** Price-level alerts (raw chart only). */
  priceAlerts?: PriceAlert[];
  /** True when this chart should show price-level alert options in the context menu. */
  allowPriceAlerts?: boolean;
  onSetEmaAlert?: (period: number) => void;
  onCancelEmaAlert?: (period: number) => void;
  onSetPriceAlert?: (price: number, label: string) => void;
  onCancelPriceAlert?: (price: number) => void;
  /** Fired when an alert level is touched; parent plays TTS and removes the alert. */
  onAlertTriggered?: (id: string, speechText: string) => void;
}

export default function Chart({
  symbol = "BTCUSDT",
  interval,
  heikin = false,
  emas = DEFAULT_EMAS,
  defaultEmaOff = DEFAULT_EMA_OFF,
  allowFootprint = true,
  defaultFootprintEnabled = false,
  defaultLevelsEnabled = true,
  levelsEnabled: levelsEnabledProp,
  onLevelsEnabledChange,
  tz = 0,
  zones = null,
  lineToggles = { weekly: true, monday: false, pdhlm: true, fibb: false, weekend: false },
  customLevels = [],
  onDeleteCustomLevel,
  onEditCustomLevel,
  onChartDoubleClick,
  registerTimeScale,
  siblingScales,
  linkedCrosshairId,
  registerLinkedCrosshair,
  onLinkedCrosshair,
  allowHtfEma = false,
  htfEnabled: htfEnabledProp,
  onHtfEnabledChange,
  onRegisterScreenshot,
  isMaximized = false,
  onToggleMaximize,
  onResetView,
  registerResetView,
  emaAlerts,
  priceAlerts,
  allowPriceAlerts = false,
  onSetEmaAlert,
  onCancelEmaAlert,
  onSetPriceAlert,
  onCancelPriceAlert,
  onAlertTriggered,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const onRegisterScreenshotRef = useRef(onRegisterScreenshot);
  onRegisterScreenshotRef.current = onRegisterScreenshot;
  const onChartDoubleClickRef = useRef(onChartDoubleClick);
  onChartDoubleClickRef.current = onChartDoubleClick;
  const isMaximizedRef = useRef(isMaximized);
  isMaximizedRef.current = isMaximized;
  const siblingScalesRef = useRef(siblingScales);
  siblingScalesRef.current = siblingScales;
  const registerTimeScaleRef = useRef(registerTimeScale);
  registerTimeScaleRef.current = registerTimeScale;
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const deltaRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** Invisible future timestamps so the axis labels 16:00→20:00 without
   *  sitting on the candle series (LWC update() can only touch the last point). */
  const futureRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  /** Close price line with countdown timer title ("04:59"), following actual raw price on all charts. */
  const closeLineRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);
  const lastClosedEmaRef = useRef<Map<number, number>>(new Map());
  const rightScaleRef = useRef<IPriceScaleApi | null>(null);
  const cacheRef = useRef<Kline[]>([]);
  /** Bars currently drawn on the candle series (raw or Heikin Ashi). EMA
   *  and the OHLC hover legend both read this so they track the chart. */
  const displayCacheRef = useRef<Kline[]>([]);
  /** Zone price-line handles — redrawn when calendar date or toggles change. */
  const zoneLinesRef = useRef<{
    line: ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>;
    price: number;
    labelVisible: boolean;
  }[]>([]);
  const copyableZonePricesRef = useRef<{ price: number; label: string; isCustom: boolean }[]>([]);
  const zoneLabelFrameRef = useRef<number | null>(null);

  const lastHaRef = useRef<{ open: number; close: number } | null>(null);
  const lastClosedHaRef = useRef<{ open: number; close: number } | null>(null);
  /** True while the user's visible range covers the latest bar. When the user
   *  drags left into history we set this to false and stop auto-following. */
  const pinnedToRightRef = useRef(true);
  /** True after the user manually drags the price-scale axis. Cleared only
   *  when applyDefaultView() runs (explicit reset). While set we skip the
   *  autoScale re-assertion so the user's custom zoom is preserved. */
  const priceScaleUserAdjustedRef = useRef(false);

  // ---- Alert refs ----
  /** Live EMA value for each period (last bar, including live candle). Updated in paintEmas. */
  const currentEmaValuesRef = useRef<Map<number, number>>(new Map());
  /** Active EMA alerts for this chart (kept in sync with the emaAlerts prop). */
  const emaAlertsRef = useRef<EmaAlert[]>(emaAlerts ?? []);
  emaAlertsRef.current = emaAlerts ?? [];
  /** Active price-level alerts (kept in sync with the priceAlerts prop). */
  const priceAlertsRef = useRef<PriceAlert[]>(priceAlerts ?? []);
  priceAlertsRef.current = priceAlerts ?? [];
  /** IDs of alerts already fired this session — prevents double-fire within the 2-s poll window. */
  const firedAlertIdsRef = useRef<Set<string>>(new Set());
  /** Becomes true ~3 s after mount so we don't false-trigger on initial load. */
  const alertReadyRef = useRef(false);
  const allowPriceAlertsRef = useRef(allowPriceAlerts);
  allowPriceAlertsRef.current = allowPriceAlerts;
  const onSetEmaAlertRef = useRef(onSetEmaAlert);
  onSetEmaAlertRef.current = onSetEmaAlert;
  const onCancelEmaAlertRef = useRef(onCancelEmaAlert);
  onCancelEmaAlertRef.current = onCancelEmaAlert;
  const onSetPriceAlertRef = useRef(onSetPriceAlert);
  onSetPriceAlertRef.current = onSetPriceAlert;
  const onCancelPriceAlertRef = useRef(onCancelPriceAlert);
  onCancelPriceAlertRef.current = onCancelPriceAlert;
  const onAlertTriggeredRef = useRef(onAlertTriggered);
  onAlertTriggeredRef.current = onAlertTriggered;
  const pointerInsideChartRef = useRef(false);
  const suppressTimeSyncRef = useRef(false);
  const suppressLinkedCrosshairRef = useRef(false);
  const lastLinkedCrosshairTimeRef = useRef<number | null>(null);
  const pendingLinkedCrosshairRef = useRef<{ time: number | null } | null>(null);
  const linkedCrosshairFrameRef = useRef<number | null>(null);
  const linkedCrosshairGenerationRef = useRef(0);
  const linkedCrosshairActiveRef = useRef(false);
  const deltaHoverPositionFrameRef = useRef<number | null>(null);
  /** Cached pane1 offsetTop — refreshed on resize, used to avoid layout reflow on every crosshair move. */
  const pane1OffsetTopRef = useRef<number>(0);
  const tabHiddenRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const exhaustedOlderRef = useRef(false);
  const [status, setStatus] = useState<"connecting" | "live" | "off">("connecting");
  const [chartReady, setChartReady] = useState(false);
  const ohlcOpenRef = useRef<HTMLSpanElement | null>(null);
  const ohlcHighRef = useRef<HTMLSpanElement | null>(null);
  const ohlcLowRef = useRef<HTMLSpanElement | null>(null);
  const ohlcCloseRef = useRef<HTMLSpanElement | null>(null);

  const deltaHoverRef = useRef<HTMLDivElement | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const deltaHoverKeyRef = useRef<string | null>(null);
  const hoverDataRef = useRef(new Map<number, HoverData>());

  // ---- HTF (Higher-Timeframe) EMA state ----
  const [internalHtfEnabled, setInternalHtfEnabled] = useState<Record<HtfEmaKey, boolean>>(makeHtfEnabledDefault);
  const htfEnabled = htfEnabledProp !== undefined ? htfEnabledProp : internalHtfEnabled;
  const htfEnabledRef = useRef(htfEnabled);
  htfEnabledRef.current = htfEnabled;
  /** One line series per HTF EMA key. */
  const htfLineRefs = useRef<Partial<Record<HtfEmaKey, ISeriesApi<"Line">>>>({});
  /** Raw kline cache per HTF interval (shared between keys of same TF). */
  const htfCacheRef = useRef<Record<HtfInterval, Kline[]>>({ "5m": [], "15m": [], "1h": [], "4h": [] });
  /** Whether the initial HTF data fetch is in-flight. */
  const htfLoadingRef = useRef<Record<HtfInterval, boolean>>({ "5m": false, "15m": false, "1h": false, "4h": false });
  /** Poll timer IDs per HTF interval. */
  const htfPollTimerRef = useRef<Record<HtfInterval, ReturnType<typeof setTimeout> | null>>({ "5m": null, "15m": null, "1h": null, "4h": null });
  /** How many individual keys are currently enabled per interval (to know when to stop polling). */
  const htfIntervalRefCountRef = useRef<Record<HtfInterval, number>>({ "5m": 0, "15m": 0, "1h": 0, "4h": 0 });

  const updateZoneLabelVisibility = () => {
    const pane = chartRef.current?.panes()[0]?.getHTMLElement();
    const series = candleRef.current;
    if (!pane || !series) return;
    for (const zoneLine of zoneLinesRef.current) {
      const y = series.priceToCoordinate(zoneLine.price);
      const visible = y !== null && y >= 0 && y <= pane.clientHeight;
      if (visible === zoneLine.labelVisible) continue;
      zoneLine.labelVisible = visible;
      zoneLine.line.applyOptions({ axisLabelVisible: visible });
    }
  };

  const scheduleZoneLabelVisibilityUpdate = () => {
    if (zoneLabelFrameRef.current !== null) return;
    zoneLabelFrameRef.current = requestAnimationFrame(() => {
      zoneLabelFrameRef.current = null;
      updateZoneLabelVisibility();
    });
  };
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [footprintEnabled, setFootprintEnabled] = useState(allowFootprint && defaultFootprintEnabled);
  const footprintEnabledRef = useRef(allowFootprint && defaultFootprintEnabled);
  const [internalLevelsEnabled, setInternalLevelsEnabled] = useState(defaultLevelsEnabled);
  const levelsEnabled = levelsEnabledProp !== undefined ? levelsEnabledProp : internalLevelsEnabled;
  const levelsEnabledRef = useRef(levelsEnabled);
  levelsEnabledRef.current = levelsEnabled;

  const toggleLevels = () => {
    const next = !levelsEnabled;
    if (onLevelsEnabledChange) {
      onLevelsEnabledChange(next);
    } else {
      setInternalLevelsEnabled(next);
    }
  };
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Right-click context menu state. */
  const customLevelsRef = useRef(customLevels);
  customLevelsRef.current = customLevels;
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    customLevel?: CustomLevel | null;
    emaContext?: { period: number; hasAlert: boolean; interval: string } | null;
    priceContext?: { price: number; hasAlert: boolean; label: string } | null;
  } | null>(null);
  const [editingLevel, setEditingLevel] = useState(false);
  const [editPriceInput, setEditPriceInput] = useState("");

  /** Currently-selected display timezone — comes from the top bar. */

  /** Per-EMA on/off state. Default: all on, except those in `defaultEmaOff`. */
  const [emaEnabled, setEmaEnabled] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (const p of emas) {
      if (!defaultEmaOff.includes(p)) s.add(p);
    }
    return s;
  });
  const emaEnabledRef = useRef(emaEnabled);
  emaEnabledRef.current = emaEnabled;

  const emasKey = emas.join(",");
  /** Keep `emaEnabled` in sync if `emas` ever changes, preserving user toggles. */
  useEffect(() => {
    setEmaEnabled((prev) => {
      const next = new Set<number>();
      for (const p of emas) {
        if (prev.has(p)) {
          next.add(p);
        }
      }
      emaEnabledRef.current = next;
      return next;
    });
  }, [emasKey]);

  /** Candle series the user actually sees — raw OHLC or Heikin Ashi. */
  const displayedBars = (raw: Kline[]): Kline[] => (heikin ? toHeikin(raw) : raw);

  /** Binance taker-buy base volume minus the remaining (taker-sell) volume. */
  const candleDelta = (bar: Kline) => 2 * bar.takerBuyVolume - bar.volume;

  const paintHoverData = (data: HoverData) => {
    if (ohlcOpenRef.current) ohlcOpenRef.current.textContent = data.open;
    if (ohlcHighRef.current) ohlcHighRef.current.textContent = data.high;
    if (ohlcLowRef.current) ohlcLowRef.current.textContent = data.low;
    if (ohlcCloseRef.current) ohlcCloseRef.current.textContent = data.close;
  };

  const paintLatestOhlc = () => {
    if (hoverKeyRef.current !== null) return;
    const displayed = displayCacheRef.current;
    if (displayed.length === 0) return;
    const lastBar = displayed[displayed.length - 1]!;
    const data = hoverDataRef.current.get(lastBar.time);
    if (data) {
      paintHoverData(data);
    }
  };

  const updateClosePriceLine = () => {
    if (tabHiddenRef.current) return;
    const series = candleRef.current;
    if (!series) return;
    const raw = cacheRef.current;
    if (raw.length === 0) return;
    const lastBar = raw[raw.length - 1]!;
    const actualPrice = lastBar.close;
    const isUp = actualPrice >= lastBar.open;
    const color = isUp ? "#08907a" : "#e23442";
    const title = formatCountdown(interval, lastBar.time);

    if (!closeLineRef.current) {
      closeLineRef.current = series.createPriceLine({
        price: actualPrice,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title,
        axisLabelColor: color,
        axisLabelTextColor: "#ffffff",
      });
    } else {
      closeLineRef.current.applyOptions({
        price: actualPrice,
        color,
        axisLabelColor: color,
        title,
      });
    }
  };

  const updateHoverData = (raw: Kline[], displayed: Kline[], index: number) => {
    const bar = displayed[index];
    const rawBar = raw[index];
    if (!bar || !rawBar) return;
    const delta = candleDelta(rawBar);
    const data: HoverData = {
      open: fmt(bar.open),
      high: fmt(bar.high),
      low: fmt(bar.low),
      close: fmt(bar.close),
      delta: String(Math.trunc(delta)),
      deltaColor: delta >= 0 ? "#08907a" : "#e23442",
    };
    hoverDataRef.current.set(bar.time, data);
    if (hoverKeyRef.current === String(bar.time)) {
      paintHoverData(data);
    } else if (hoverKeyRef.current === null && index === displayed.length - 1) {
      paintHoverData(data);
    }
    if (
      deltaHoverKeyRef.current === String(bar.time)
      && deltaHoverRef.current
      && deltaHoverRef.current.style.display !== "none"
    ) {
      deltaHoverRef.current.textContent = data.delta;
      deltaHoverRef.current.style.color = data.deltaColor;
    }
  };

  const rebuildHoverData = (raw: Kline[], displayed: Kline[]) => {
    const next = new Map<number, HoverData>();
    hoverDataRef.current = next;
    for (let i = 0; i < displayed.length; i++) updateHoverData(raw, displayed, i);
  };

  const updateHoverAtTime = (time: number | null) => {
    if (time == null) {
      hoverKeyRef.current = null;
      deltaHoverKeyRef.current = null;
      if (deltaHoverRef.current) deltaHoverRef.current.style.display = "none";
      paintLatestOhlc();
      return;
    }

    const hoverData = hoverDataRef.current.get(time);
    if (hoverData) {
      if (hoverKeyRef.current !== String(time)) {
        hoverKeyRef.current = String(time);
        paintHoverData(hoverData);
      }
    } else {
      hoverKeyRef.current = null;
      paintLatestOhlc();
    }

    const chart = chartRef.current;
    const deltaElement = deltaHoverRef.current;
    if (!footprintEnabledRef.current || !hoverData || !chart || !deltaElement) {
      deltaHoverKeyRef.current = null;
      if (deltaElement && deltaElement.style.display !== "none") {
        deltaElement.style.display = "none";
      }
      return;
    }

    const key = String(time);
    // Only update text content when the bar changes; position update is
    // batched in a rAF to avoid layout-thrashing on every pixel of mouse move.
    const barChanged = key !== deltaHoverKeyRef.current;
    if (barChanged) {
      deltaHoverKeyRef.current = key;
      deltaElement.textContent = hoverData.delta;
      deltaElement.style.color = hoverData.deltaColor;
    }
    // Schedule a position update — reads offsetTop which forces a layout
    // reflow, so we defer it to avoid blocking the crosshair event loop.
    if (deltaHoverPositionFrameRef.current === null) {
      deltaHoverPositionFrameRef.current = requestAnimationFrame(() => {
        deltaHoverPositionFrameRef.current = null;
        const currentKey = deltaHoverKeyRef.current;
        if (!currentKey) { return; }
        const x = chart.timeScale().timeToCoordinate(Number(currentKey) as Time);
        const paneElement = chart.panes()[1]?.getHTMLElement();
        if (x == null || !paneElement) {
          if (deltaElement.style.display !== "none") deltaElement.style.display = "none";
          return;
        }
        deltaElement.style.left = `${x}px`;
        deltaElement.style.top = `${paneElement.offsetTop - 1}px`;
        if (deltaElement.style.display === "none") deltaElement.style.display = "block";
      });
    } else if (barChanged) {
      // Show immediately (already scheduled a position rAF)
      if (deltaElement.style.display === "none") deltaElement.style.display = "block";
    }
  };

  const createDeltaSeries = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const pane = chart.panes()[1] ?? chart.addPane();
    pane.setHeight(64);
    const delta = pane.addSeries(HistogramSeries, {
      base: 0,
      priceScaleId: "delta",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    deltaRef.current = delta;
    pane.priceScale("delta").applyOptions({
      visible: false,
      autoScale: true,
      scaleMargins: { top: 0.16, bottom: 0.12 },
    });
    delta.setData(cacheRef.current.map((bar) => {
      const value = candleDelta(bar);
      return {
        time: bar.time as Time,
        value,
        color: value >= 0 ? "#08907a" : "#e23442",
      };
    }));
  };

  /** Paint every EMA from the displayed series close (raw or HA). */
  const paintEmas = (bars: Kline[]) => {
    const values = bars.map((b) => b.close);
    const enabled = emaEnabledRef.current;
    const isLastClosed = bars.length > 0 && bars[bars.length - 1]!.closed;
    const closedIdx = isLastClosed ? bars.length - 1 : Math.max(0, bars.length - 2);

    for (let i = 0; i < emas.length; i++) {
      const period = emas[i]!;
      const line = emaRefs.current[i];
      if (bars.length === 0) {
        lastClosedEmaRef.current.delete(period);
        line?.setData([]);
        continue;
      }
      const smoothed = ema(values, period);
      const closedEma = smoothed[closedIdx] ?? smoothed[smoothed.length - 1]!;
      lastClosedEmaRef.current.set(period, closedEma);
      // Track the live (last-bar) EMA value for alert proximity checks.
      const liveEma = smoothed[smoothed.length - 1];
      if (liveEma != null) currentEmaValuesRef.current.set(period, liveEma);

      if (!line) continue;
      if (!enabled.has(period)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        line.applyOptions({ visible: false } as any);
        line.setData([]);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      line.applyOptions({ visible: true } as any);
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

  // ---- HTF EMA helpers ----

  /** Map higher-timeframe EMA values onto the current chart's time axis via step-hold. */
  const mapHtfEmaToChartTime = (
    htfBars: Kline[],
    period: number,
    chartBars: Kline[],
    htfStepSec: number,
  ): { time: Time; value: number }[] => {
    if (htfBars.length === 0 || chartBars.length === 0) return [];
    const closes = htfBars.map((b) => b.close);
    const smoothed = ema(closes, period);

    const htfEmaMap = new Map<number, number>();
    for (let i = 0; i < htfBars.length; i++) {
      htfEmaMap.set(htfBars[i]!.time, smoothed[i]!);
    }

    const result: { time: Time; value: number }[] = [];
    const earliestEma = smoothed.length > 0 ? smoothed[0]! : null;
    let currentHtfEma: number | null = earliestEma;
    for (const bar of chartBars) {
      const htfStart = Math.floor(bar.time / htfStepSec) * htfStepSec;
      const emaVal = htfEmaMap.get(htfStart);
      if (emaVal !== undefined) currentHtfEma = emaVal;
      if (currentHtfEma !== null) result.push({ time: bar.time as Time, value: currentHtfEma });
    }
    return result;
  };

  /** Paint (or clear) a single HTF EMA line. */
  const paintOneHtfEma = (cfg: HtfEmaConfig) => {
    const line = htfLineRefs.current[cfg.key];
    if (!line) return;
    const htfBars = htfCacheRef.current[cfg.interval];
    const chartBars = displayCacheRef.current;
    if (!htfEnabledRef.current[cfg.key] || htfBars.length === 0 || chartBars.length === 0) {
      line.setData([]);
      return;
    }
    const data = mapHtfEmaToChartTime(htfBars, cfg.period, chartBars, HTF_INTERVAL_STEP[cfg.interval]);
    line.setData(data);
  };

  /** Repaint all currently-enabled HTF EMA lines (called when chart data changes). */
  const repaintAllHtfEmas = () => {
    if (!allowHtfEma) return;
    for (const cfg of HTF_EMA_CONFIGS) {
      if (htfEnabledRef.current[cfg.key]) paintOneHtfEma(cfg);
    }
  };

  /** Repaint all enabled lines for a given interval (called after HTF data arrives). */
  const repaintHtfInterval = (interval: HtfInterval) => {
    for (const cfg of HTF_EMA_CONFIGS) {
      if (cfg.interval === interval && htfEnabledRef.current[cfg.key]) paintOneHtfEma(cfg);
    }
  };

  /** Stop polling for a HTF interval. */
  const stopHtfDataFeed = (htfInterval: HtfInterval) => {
    if (htfPollTimerRef.current[htfInterval] !== null) {
      clearTimeout(htfPollTimerRef.current[htfInterval]!);
      htfPollTimerRef.current[htfInterval] = null;
    }
  };

  /** Fetch HTF kline data and start a background poll (shared per interval). */
  const startHtfDataFeed = async (htfInterval: HtfInterval) => {
    if (htfLoadingRef.current[htfInterval]) return; // already loading; paint will happen when done
    htfLoadingRef.current[htfInterval] = true;
    try {
      const klines = await fetchLatestKlines(htfInterval, 1000, symbol);
      if (klines.length > 0) {
        let allHtf = cleanAndSort(klines);
        const oldestChartTime = cacheRef.current.length > 0 ? cacheRef.current[0]!.time : 0;
        if (oldestChartTime > 0 && allHtf.length > 0 && allHtf[0]!.time > oldestChartTime) {
          try {
            const endTimeMs = allHtf[0]!.time * 1000 - 1;
            const olderHtf = await fetchOlderKlines(htfInterval, endTimeMs, 1000, symbol);
            if (olderHtf.length > 0) {
              allHtf = cleanAndSort([...olderHtf, ...allHtf]);
            }
          } catch { }
        }
        htfCacheRef.current[htfInterval] = allHtf;
        repaintHtfInterval(htfInterval);
      }
    } catch (err) {
      console.warn(`[chart] HTF ${htfInterval} initial fetch failed:`, err);
    } finally {
      htfLoadingRef.current[htfInterval] = false;
    }

    const poll = async () => {
      if (htfIntervalRefCountRef.current[htfInterval] === 0) return; // all keys off
      try {
        const latest = await fetchLatestKlines(htfInterval, 10, symbol);
        if (latest.length > 0) {
          const existing = htfCacheRef.current[htfInterval];
          const map = new Map<number, Kline>();
          for (const b of existing) map.set(b.time, b);
          for (const b of latest) map.set(b.time, b);
          htfCacheRef.current[htfInterval] = cleanAndSort([...map.values()]);
          repaintHtfInterval(htfInterval);
        }
      } catch { }
      if (htfIntervalRefCountRef.current[htfInterval] > 0) {
        htfPollTimerRef.current[htfInterval] = setTimeout(poll, 5000);
      }
    };
    htfPollTimerRef.current[htfInterval] = setTimeout(poll, 5000);
  };

  /** Toggle a single HTF EMA key on/off. */
  const toggleHtfEma = (key: HtfEmaKey) => {
    const isNowOn = !htfEnabledRef.current[key];
    const next = { ...htfEnabledRef.current, [key]: isNowOn };
    htfEnabledRef.current = next;
    if (onHtfEnabledChange) {
      onHtfEnabledChange(next);
    } else {
      setInternalHtfEnabled(next);
    }

    const cfg = HTF_EMA_CONFIGS.find((c) => c.key === key)!;
    const line = htfLineRefs.current[key];
    if (line) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      line.applyOptions({ visible: isNowOn } as any);
      if (!isNowOn) line.setData([]);
    }

    // Update ref-count for this interval
    const delta = isNowOn ? 1 : -1;
    htfIntervalRefCountRef.current[cfg.interval] = Math.max(0,
      htfIntervalRefCountRef.current[cfg.interval] + delta,
    );

    if (isNowOn) {
      // If we already have cached data paint immediately, then start/keep the feed
      if (htfCacheRef.current[cfg.interval].length > 0) paintOneHtfEma(cfg);
      void startHtfDataFeed(cfg.interval);
    } else {
      // Stop polling only if no other keys on this interval are still enabled
      if (htfIntervalRefCountRef.current[cfg.interval] === 0) stopHtfDataFeed(cfg.interval);
    }
  };

  /** Full state flush when waking from background tab sleep. */
  const flushFullState = () => {
    const series = displayCacheRef.current;
    const raw = cacheRef.current;
    if (!candleRef.current || series.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candleRef.current.setData(series as any);
    // Re-assert autoScale after setData() to prevent LWC from locking the
    // price axis at a stale range (same fix as in updateWithLatestBars).
    if (!priceScaleUserAdjustedRef.current) {
      rightScaleRef.current?.applyOptions({ autoScale: true });
    }
    if (footprintEnabledRef.current && deltaRef.current) {
      deltaRef.current.setData(raw.map((bar) => {
        const value = candleDelta(bar);
        return {
          time: bar.time as Time,
          value,
          color: value >= 0 ? "#08907a" : "#e23442",
        };
      }));
    }
    const lastBar = series[series.length - 1]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
    if (!heikin) setTabTitle(lastBar.close);
    paintEmas(series);
    repaintAllHtfEmas();
    paintLatestOhlc();
    updateClosePriceLine();
    if (pinnedToRightRef.current) {
      applyDefaultView();
    }
  };

  const loadOlderHistoryForChart = async () => {
    if (loadingOlderRef.current || exhaustedOlderRef.current || cacheRef.current.length === 0) return;
    loadingOlderRef.current = true;
    try {
      const firstTime = cacheRef.current[0]!.time;
      const endTime = firstTime * 1000 - 1;
      const older = await fetchOlderKlines(interval, endTime, 1000, symbol);
      const cut = older.filter((bar) => bar.time < firstTime);
      if (cut.length === 0) {
        exhaustedOlderRef.current = true;
        return;
      }
      const raw = cleanAndSort([...cut, ...cacheRef.current]);
      cacheRef.current = raw;
      seedHistory(interval, raw, symbol);

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
      rebuildHoverData(raw, series);

      if (candleRef.current && chartRef.current) {
        const ts = chartRef.current.timeScale();
        const range = ts.getVisibleLogicalRange();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candleRef.current.setData(series as any);
        if (footprintEnabledRef.current && deltaRef.current) {
          deltaRef.current.setData(raw.map((b) => {
            const dv = candleDelta(b);
            return {
              time: b.time as Time,
              value: dv,
              color: dv >= 0 ? "#08907a" : "#e23442",
            };
          }));
        }
        paintEmas(series);
        repaintAllHtfEmas();
        if (allowHtfEma) {
          for (const htfInterval of ["5m", "15m", "1h", "4h"] as HtfInterval[]) {
            if (htfIntervalRefCountRef.current[htfInterval] > 0) {
              const existingHtf = htfCacheRef.current[htfInterval];
              if (existingHtf.length > 0 && existingHtf[0]!.time > firstTime) {
                const endTimeMs = existingHtf[0]!.time * 1000 - 1;
                void fetchOlderKlines(htfInterval, endTimeMs, 1000, symbol).then((older) => {
                  if (older.length > 0) {
                    htfCacheRef.current[htfInterval] = cleanAndSort([...older, ...htfCacheRef.current[htfInterval]]);
                    repaintHtfInterval(htfInterval);
                  }
                }).catch(() => { });
              }
            }
          }
        }
        if (range) {
          ts.setVisibleLogicalRange({
            from: range.from + cut.length,
            to: range.to + cut.length,
          });
        }
      }
    } catch (err) {
      console.warn(`[chart] load older history failed for ${interval}:`, err);
    } finally {
      loadingOlderRef.current = false;
    }
  };

  const updateWithLatestBars = (latestBars: Kline[]) => {
    if (!candleRef.current || latestBars.length === 0) return;

    const raw = cacheRef.current;
    if (raw.length === 0) {
      const clean = cleanAndSort(latestBars);
      cacheRef.current = clean;
      seedHistory(interval, clean, symbol);
      return;
    }

    const prevLastTime = raw[raw.length - 1]!.time;
    const barMap = new Map<number, Kline>();
    for (const b of raw) barMap.set(b.time, b);
    for (const b of latestBars) barMap.set(b.time, b);
    const merged = cleanAndSort([...barMap.values()]);
    cacheRef.current = merged;
    seedHistory(interval, merged, symbol);

    const newLastTime = merged[merged.length - 1]!.time;
    const isNewBar = newLastTime > prevLastTime;
    const newBarCount = isNewBar
      ? merged.filter((b) => b.time > prevLastTime).length
      : 0;

    let series: Kline[];
    if (heikin) {
      const built = heikinSeriesAndAnchor(merged);
      series = built.series;
      lastClosedHaRef.current = built.lastClosed;
      lastHaRef.current = built.lastClosed;
    } else {
      series = merged;
      lastClosedHaRef.current = null;
      lastHaRef.current = null;
    }

    displayCacheRef.current = series;
    rebuildHoverData(merged, series);

    // Always update tab title even when tab is hidden — document.title works in background tabs
    if (!heikin && series.length > 0) {
      const lastBar = series[series.length - 1]!;
      setTabTitle(lastBar.close);
    }

    if (!tabHiddenRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      // LWC's setData() can silently disable autoScale on the price axis.
      // Re-assert it every tick so the visible-range scale keeps following
      // new candles even after the user hits "Reset Price Scale".
      // Skip if the user has manually adjusted the price scale — their custom
      // zoom should be preserved until they explicitly reset.
      if (!priceScaleUserAdjustedRef.current) {
        rightScaleRef.current?.applyOptions({ autoScale: true });
      }
      if (footprintEnabledRef.current && deltaRef.current) {
        deltaRef.current.setData(merged.map((b) => {
          const dv = candleDelta(b);
          return {
            time: b.time as Time,
            value: dv,
            color: dv >= 0 ? "#08907a" : "#e23442",
          };
        }));
      }
      paintEmas(series);
      repaintAllHtfEmas();
      if (series.length > 0) {
        const lastBar = series[series.length - 1]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
      }
      paintLatestOhlc();
      updateClosePriceLine();
      scheduleZoneLabelVisibilityUpdate();

      if (chartRef.current && pinnedToRightRef.current && isNewBar && prevLastTime > 0) {
        const ts = chartRef.current.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (range) {
          ts.setVisibleLogicalRange({
            from: range.from + newBarCount,
            to: range.to + newBarCount,
          });
        }
      }
    }

    // --- Alert checking (runs regardless of tab visibility) ---
    if (alertReadyRef.current && series.length > 0) {
      const liveRaw = merged[merged.length - 1]!;
      const liveDisplay = series[series.length - 1]!;

      // Drop fired IDs for alerts that have already been removed from state
      const activeIds = new Set([
        ...emaAlertsRef.current.map((a) => a.id),
        ...priceAlertsRef.current.map((a) => a.id),
      ]);
      for (const id of firedAlertIdsRef.current) {
        if (!activeIds.has(id)) firedAlertIdsRef.current.delete(id);
      }

      // EMA alerts — check if the live candle's range covers the EMA level
      for (const alert of emaAlertsRef.current) {
        if (firedAlertIdsRef.current.has(alert.id)) continue;
        const emaVal = currentEmaValuesRef.current.get(alert.period);
        if (emaVal == null) continue;
        if (liveDisplay.low <= emaVal && emaVal <= liveDisplay.high) {
          firedAlertIdsRef.current.add(alert.id);
          onAlertTriggeredRef.current?.(alert.id, alert.speechText);
        }
      }

      // Price alerts — check raw bar's range (actual market price)
      for (const alert of priceAlertsRef.current) {
        if (firedAlertIdsRef.current.has(alert.id)) continue;
        if (liveRaw.low <= alert.price && alert.price <= liveRaw.high) {
          firedAlertIdsRef.current.add(alert.id);
          onAlertTriggeredRef.current?.(alert.id, alert.speechText);
        }
      }
    }
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
    // User explicitly reset — clear the manual-adjustment flag so autoScale
    // re-assertions resume on the next data tick.
    priceScaleUserAdjustedRef.current = false;
    rightScaleRef.current?.setAutoScale(true);
    rightScaleRef.current?.applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    });
    const ts = c.timeScale();
    const spacing = getTargetBarSpacing(interval);
    ts.applyOptions({
      barSpacing: spacing,
      rightOffset: RIGHT_GAP_BARS,
    });
    // Pin the live candle near the right. Do NOT scrollToRealTime() — that
    // would jump to the dummy future series (~4h of empty).
    const total = cacheRef.current.length;
    const slots = Math.max(40, Math.floor((w - 70) / spacing));
    const futureSlots = Math.min(
      futureBarCount(interval),
      Math.max(4, Math.floor(slots * 0.12)),
    );
    const range = {
      from: Math.max(0, total - (slots - futureSlots)),
      to: total + futureSlots,
    };
    ts.setVisibleLogicalRange(range);
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
        background: { color: "#141823" },
        textColor: "#848e9c",
        fontSize: 11,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
        panes: {
          enableResize: false,
          separatorColor: "rgba(120, 123, 134, 0.24)",
          separatorHoverColor: "rgba(120, 123, 134, 0.24)",
        },
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
        vertLine: { color: "#8b8f98", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#333842" },
        horzLine: { color: "#8b8f98", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#333842" },
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
        barSpacing: getTargetBarSpacing(interval),
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

    if (onRegisterScreenshotRef.current) {
      onRegisterScreenshotRef.current(() => {
        if (!chartRef.current) return null;
        try {
          return chartRef.current.takeScreenshot(true, false);
        } catch {
          return null;
        }
      });
    }

    const symbolPriceFormat = {
      type: "custom" as const,
      minMove: getMinMove(),
      formatter: (p: number) => formatPrice(p),
    };

    // Default right price scale (used by every series on this chart).
    const right = chart.priceScale("right");
    rightScaleRef.current = right;

    const refs: ISeriesApi<"Line">[] = new Array(emas.length);
    const addEma = (period: number) => {
      const color = EMA_COLOR[period] ?? "#ffffff";
      const width = EMA_LINE_WIDTH[period] ?? 2;
      refs[emas.indexOf(period)] = chart.addSeries(LineSeries, {
        color,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineWidth: width as any,
        lineStyle: LineStyle.Solid,
        pointMarkersVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: symbolPriceFormat,
        crosshairMarkerVisible: false,
      });
    };
    for (const period of emas) {
      if (period >= 50) addEma(period);
    }

    // HTF EMA line series — one per key, added behind candles.
    if (allowHtfEma) {
      for (const cfg of HTF_EMA_CONFIGS) {
        const isEnabled = Boolean(htfEnabledRef.current[cfg.key]);
        const line = chart.addSeries(LineSeries, {
          color: cfg.color,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lineWidth: (cfg.period === 200 ? 2 : 1.5) as any,
          lineStyle: LineStyle.Solid,
          pointMarkersVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: symbolPriceFormat,
          crosshairMarkerVisible: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          visible: isEnabled as any,
        });
        htfLineRefs.current[cfg.key] = line;
        if (isEnabled) {
          htfIntervalRefCountRef.current[cfg.interval] =
            (htfIntervalRefCountRef.current[cfg.interval] || 0) + 1;
        }
      }
      for (const htfInterval of ["5m", "15m", "1h", "4h"] as HtfInterval[]) {
        if (htfIntervalRefCountRef.current[htfInterval] > 0) {
          void startHtfDataFeed(htfInterval);
        }
      }
    }

    // Candles render above the slow EMAs; fast EMAs are added after candles.
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#08907a",
      downColor: "#e23442",
      wickUpColor: "#08907a",
      wickDownColor: "#e23442",
      borderVisible: true,
      borderUpColor: "#08907a",
      borderDownColor: "#e23442",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: symbolPriceFormat,
    });
    candleRef.current = candle;

    // Attach the daily-open vertical dotted line primitive on eligible timeframes
    if (SHOW_DAILY_LINE_TF.has(interval)) {
      candle.attachPrimitive(new DailyOpenPrimitive());
    }

    if (footprintEnabledRef.current) createDeltaSeries();

    const futureLine = chart.addSeries(LineSeries, {
      color: "rgba(0,0,0,0)",
      lineVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
      priceFormat: symbolPriceFormat,
    });
    futureRef.current = futureLine;

    for (const period of emas) {
      if (period < 50) addEma(period);
    }
    emaRefs.current = refs;

    const savedBars = getHistory(interval);
    if (savedBars.length > 0) {
      const built = heikin ? heikinSeriesAndAnchor(savedBars) : null;
      const series = built?.series ?? savedBars;
      const lastClosed = built?.lastClosed ?? null;
      lastClosedHaRef.current = lastClosed;
      lastHaRef.current = lastClosed;
      cacheRef.current = savedBars.slice();
      displayCacheRef.current = series;
      rebuildHoverData(savedBars, series);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candle.setData(series as any);
      deltaRef.current?.setData(savedBars.map((bar) => {
        const value = candleDelta(bar);
        return {
          time: bar.time as Time,
          value,
          color: value >= 0 ? "#08907a" : "#e23442",
        };
      }));
      const lastBar = series[series.length - 1]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
      if (!heikin) setTabTitle(lastBar.close);
      recomputeEmas(savedBars);
      paintLatestOhlc();
      updateClosePriceLine();
      requestAnimationFrame(() => applyDefaultView());
    }

    const ts = chart.timeScale();
    let tOriginating = false;
    const onTimeRange = () => {
      scheduleZoneLabelVisibilityUpdate();
      if (tOriginating) return;
      if (suppressTimeSyncRef.current) return;
      if (cacheRef.current.length === 0) return;

      const cached = cacheRef.current;
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      pinnedToRightRef.current = range.to >= cached.length - 2;
      if (range.from < 30) {
        void loadOlderHistoryForChart();
      }

      // Only sync to sibling time scales when user is actively interacting with THIS chart
      const siblings = siblingScalesRef.current?.current ?? [];
      if (!pointerInsideChartRef.current || siblings.length === 0) return;

      tOriginating = true;
      try {
        for (const sib of siblings) {
          if (sib && sib !== ts) {
            sib.setVisibleLogicalRange(range);
          }
        }
      } finally {
        tOriginating = false;
      }
    };
    ts.subscribeVisibleLogicalRangeChange(onTimeRange);
    registerTimeScaleRef.current?.(ts);
    registerResetView?.(applyDefaultView);

    // OHLC hover legend — find the bar closest to the cursor's time.
    const onCrosshair = (p: MouseEventParams) => {
      const time = p.time == null ? null : (p.time as number);
      updateHoverAtTime(time);
      // Restore this chart's own crosshair only when the user genuinely moves
      // their OWN mouse — not when setCrosshairPosition (from a sibling sync)
      // triggers this handler (suppressLinkedCrosshairRef is true in that case).
      if (p.point != null && linkedCrosshairActiveRef.current && !suppressLinkedCrosshairRef.current) {
        linkedCrosshairActiveRef.current = false;
        chart.applyOptions({
          crosshair: {
            horzLine: { visible: true, labelVisible: true },
          },
        });
      }
      if (
        linkedCrosshairId
        && onLinkedCrosshair
        && !suppressLinkedCrosshairRef.current
        && lastLinkedCrosshairTimeRef.current !== time
      ) {
        lastLinkedCrosshairTimeRef.current = time;
        pendingLinkedCrosshairRef.current = { time };
        if (linkedCrosshairFrameRef.current === null) {
          linkedCrosshairFrameRef.current = requestAnimationFrame(() => {
            linkedCrosshairFrameRef.current = null;
            const pending = pendingLinkedCrosshairRef.current;
            pendingLinkedCrosshairRef.current = null;
            if (pending) onLinkedCrosshair(linkedCrosshairId, pending.time);
          });
        }
      }
    };
    chart.subscribeCrosshairMove(onCrosshair);
    const onPointerEnter = () => {
      pointerInsideChartRef.current = true;
    };
    const onPointerDown = () => {
      pointerInsideChartRef.current = true;
    };
    // Detect when the user clicks/drags the price-scale axis (right ~65 px).
    // We flag priceScaleUserAdjustedRef so the autoScale re-assertion is
    // suppressed and the user's custom zoom survives the next data poll.
    const onPriceScalePointerDown = (e: PointerEvent) => {
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const xFromRight = rect.right - e.clientX;
      if (xFromRight >= 0 && xFromRight <= 70) {
        priceScaleUserAdjustedRef.current = true;
      }
    };
    const onPointerLeave = () => {
      pointerInsideChartRef.current = false;
      if (deltaHoverRef.current) deltaHoverRef.current.style.display = "none";
      if (linkedCrosshairActiveRef.current) {
        linkedCrosshairActiveRef.current = false;
        chart.applyOptions({
          crosshair: {
            horzLine: { visible: true, labelVisible: true },
          },
        });
      }
      updateHoverAtTime(null);
      if (linkedCrosshairId && onLinkedCrosshair) {
        lastLinkedCrosshairTimeRef.current = null;
        onLinkedCrosshair(linkedCrosshairId, null);
      }
    };
    containerRef.current?.addEventListener("pointerenter", onPointerEnter);
    containerRef.current?.addEventListener("pointerdown", onPointerDown);
    containerRef.current?.addEventListener("pointerleave", onPointerLeave);
    containerRef.current?.addEventListener("pointerdown", onPriceScalePointerDown);

    const syncLinkedCrosshair: LinkedCrosshairSync = (time) => {
      const generation = ++linkedCrosshairGenerationRef.current;
      suppressLinkedCrosshairRef.current = true;
      if (time == null) {
        chart.clearCrosshairPosition();
        updateHoverAtTime(null);
      } else {
        const barIndex = findBarIndex(displayCacheRef.current, time, true);
        const bar = barIndex >= 0 ? displayCacheRef.current[barIndex] : undefined;
        const targetSeries = (bar && candleRef.current)
          ? candleRef.current
          : (futureRef.current ?? candleRef.current);
        if (targetSeries) {
          if (!linkedCrosshairActiveRef.current) {
            linkedCrosshairActiveRef.current = true;
            chart.applyOptions({
              crosshair: {
                horzLine: { visible: false, labelVisible: false },
              },
            });
          }
          chart.setCrosshairPosition(NaN, time as Time, targetSeries);
          updateHoverAtTime(time);
        } else {
          chart.clearCrosshairPosition();
          updateHoverAtTime(null);
        }
      }
      requestAnimationFrame(() => {
        if (linkedCrosshairGenerationRef.current === generation) {
          suppressLinkedCrosshairRef.current = false;
        }
      });
    };
    if (linkedCrosshairId) {
      registerLinkedCrosshair?.(linkedCrosshairId, syncLinkedCrosshair);
    }

    // Right-click anywhere in the chart -> open the custom context menu.
    const el = containerRef.current;
    const onDoubleClick = async (e: MouseEvent) => {
      const series = candleRef.current;
      let closestPrice: number | null = null;
      let minPixelDiff = Infinity;
      if (series && copyableZonePricesRef.current.length > 0 && el) {
        const rect = el.getBoundingClientRect();
        const y = e.clientY - rect.top;
        for (const { price } of copyableZonePricesRef.current) {
          const lineY = series.priceToCoordinate(price);
          if (lineY == null) continue;
          const diff = Math.abs(lineY - y);
          if (diff < minPixelDiff) {
            minPixelDiff = diff;
            closestPrice = price;
          }
        }
      }

      // If double-clicked on or near a horizontal line, copy the line price (do NOT toggle/exit)
      if (closestPrice != null && minPixelDiff <= 12) {
        e.preventDefault();
        e.stopPropagation();
        const formatted = String(Math.round(closestPrice));
        try {
          if (navigator.clipboard && window.isSecureContext) {
            try {
              await navigator.clipboard.writeText(formatted);
            } catch {
              if (!copyToLegacyClipboard(formatted)) {
                throw new Error("Clipboard write was rejected");
              }
            }
          } else if (!copyToLegacyClipboard(formatted)) {
            throw new Error("Clipboard copy command was rejected");
          }
          setCopyToast(formatted);
          if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
          copyToastTimerRef.current = setTimeout(() => setCopyToast(null), 3_000);
        } catch (err) {
          console.error("[clipboard] could not copy chart level:", err);
        }
        return;
      }

      // Double-clicked on black / empty space:
      // If 1-layout mode is active, exit back to 3-layout mode.
      // Otherwise in 3-layout mode, toggle layout.
      if (onChartDoubleClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onChartDoubleClickRef.current();
      }
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const series = candleRef.current;
      let matchedCustomLevel: CustomLevel | null = null;
      const levels = customLevelsRef.current;

      if (series && levels.length > 0 && el && levelsEnabledRef.current) {
        const rect = el.getBoundingClientRect();
        const y = e.clientY - rect.top;

        let closestCustomLevel: CustomLevel | null = null;
        let minCustomDiff = Infinity;
        for (const level of levels) {
          const lineY = series.priceToCoordinate(roundPrice(level.price));
          if (lineY == null) continue;
          const diff = Math.abs(lineY - y);
          if (diff < minCustomDiff) {
            minCustomDiff = diff;
            closestCustomLevel = level;
          }
        }

        if (closestCustomLevel && minCustomDiff <= 45) {
          matchedCustomLevel = closestCustomLevel;
        } else {
          // Fallback: check coordinateToPrice
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const clickPrice = series.coordinateToPrice(y as any);
          if (clickPrice != null) {
            let closestPriceDiff = Infinity;
            let closestByPrice: CustomLevel | null = null;
            for (const level of levels) {
              const diff = Math.abs(clickPrice - level.price);
              if (diff < closestPriceDiff) {
                closestPriceDiff = diff;
                closestByPrice = level;
              }
            }
            if (closestByPrice && closestPriceDiff <= 100) {
              matchedCustomLevel = closestByPrice;
            }
          }
        }
      }

      setEditingLevel(false);

      // --- EMA proximity detection (50 & 200 EMA only, within 40 px) ---
      let emaContext: { period: number; hasAlert: boolean; interval: string } | null = null;
      if (series && el) {
        const rect = el.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        let minEmaDiff = Infinity;
        for (const period of [50, 200]) {
          if (!emaEnabledRef.current.has(period)) continue; // skip hidden EMAs
          const emaVal = currentEmaValuesRef.current.get(period);
          if (emaVal == null) continue;
          const emaY = series.priceToCoordinate(emaVal);
          if (emaY == null) continue;
          const diff = Math.abs(emaY - clickY);
          if (diff < minEmaDiff && diff <= 25) {
            minEmaDiff = diff;
            const hasAlert = emaAlertsRef.current.some((a) => a.period === period);
            emaContext = { period, hasAlert, interval };
          }
        }
      }

      // --- Price-level proximity detection (all zone + custom lines, 15 px) ---
      let priceContext: { price: number; hasAlert: boolean; label: string } | null = null;
      if (allowPriceAlertsRef.current && series && el) {
        const rect = el.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        let minPriceDiff = Infinity;
        for (const { price, label } of copyableZonePricesRef.current) {
          const lineY = series.priceToCoordinate(price);
          if (lineY == null) continue;
          const diff = Math.abs(lineY - clickY);
          if (diff < minPriceDiff && diff <= 15) {
            minPriceDiff = diff;
            const hasAlert = priceAlertsRef.current.some(
              (a) => Math.round(a.price) === Math.round(price),
            );
            priceContext = { price, hasAlert, label };
          }
        }
      }

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        customLevel: matchedCustomLevel,
        emaContext,
        priceContext,
      });
    };

    el?.addEventListener("dblclick", onDoubleClick, true);
    el?.addEventListener("contextmenu", onContext);

    // --- Countdown timer (every second) ------------------------------------
    const countdownTimer = setInterval(() => {
      updateClosePriceLine();
    }, 1000);

    // --- Alert grace-period: suppress firing for the first 3 s after mount ---
    const alertGraceTimer = setTimeout(() => { alertReadyRef.current = true; }, 3000);

    // Place the default view once the cell has a real size AND history is in.
    let initialViewApplied = false;
    const ro = new ResizeObserver(() => {
      scheduleZoneLabelVisibilityUpdate();
      if (!chartRef.current) return;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      if (!initialViewApplied && w > 40 && h > 40 && cacheRef.current.length > 0) {
        applyDefaultView();
        initialViewApplied = true;
      }
    });

    if (el) ro.observe(el);

    return () => {
      ro.disconnect();
      if (zoneLabelFrameRef.current !== null) {
        cancelAnimationFrame(zoneLabelFrameRef.current);
        zoneLabelFrameRef.current = null;
      }
      if (deltaHoverPositionFrameRef.current !== null) {
        cancelAnimationFrame(deltaHoverPositionFrameRef.current);
        deltaHoverPositionFrameRef.current = null;
      }
      clearInterval(countdownTimer);
      clearTimeout(alertGraceTimer);
      alertReadyRef.current = false;
      if (closeLineRef.current && candleRef.current) {
        try {
          candleRef.current.removePriceLine(closeLineRef.current);
        } catch (_) { /* ignore */ }
      }
      closeLineRef.current = null;
      el?.removeEventListener("dblclick", onDoubleClick, true);
      el?.removeEventListener("contextmenu", onContext);
      el?.removeEventListener("pointerenter", onPointerEnter);
      el?.removeEventListener("pointerdown", onPointerDown);
      el?.removeEventListener("pointerleave", onPointerLeave);
      el?.removeEventListener("pointerdown", onPriceScalePointerDown);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      if (linkedCrosshairFrameRef.current !== null) {
        cancelAnimationFrame(linkedCrosshairFrameRef.current);
        linkedCrosshairFrameRef.current = null;
      }
      pendingLinkedCrosshairRef.current = null;
      const sibs = siblingScalesRef.current?.current;
      if (sibs) {
        const i = sibs.indexOf(ts);
        if (i >= 0) sibs.splice(i, 1);
      }
      registerTimeScaleRef.current?.(null);
      registerResetView?.(null);
      if (linkedCrosshairId) {
        registerLinkedCrosshair?.(linkedCrosshairId, null);
      }
      // Clean up HTF EMA poll timers
      for (const htfInterval of ["5m", "15m", "1h", "4h"] as HtfInterval[]) {
        stopHtfDataFeed(htfInterval);
      }
      if (onRegisterScreenshotRef.current) {
        onRegisterScreenshotRef.current(null);
      }
      chart.remove();
      chartRef.current = null;
      rightScaleRef.current = null;
      deltaRef.current = null;
      setChartReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (onRegisterScreenshot) {
      onRegisterScreenshot(() => {
        if (!chartRef.current) return null;
        try {
          return chartRef.current.takeScreenshot(true, false);
        } catch {
          return null;
        }
      });
    }
  }, [onRegisterScreenshot]);

  // Re-apply tick formatter when the timezone changes.
  // Do NOT call resetTimeScale() here — that would wipe the user's current
  // pan/zoom position every time they switch TZ.
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      timeScale: { tickMarkFormatter: makeTickFormatter(tz) },
      localization: makeLocalization(tz),
    });
  }, [tz, symbol]);

  // Horizontal levels from zones.py — calendar date is the reference day only.
  // Purple thick = Prev 1W H/L. Blue thick = this week's Monday H/L.
  // White thick = PDH/PDL. White dash = Prev 1D mid.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const zoneLine of zoneLinesRef.current) {
      try { series.removePriceLine(zoneLine.line); } catch (_) { /* already removed */ }
    }
    zoneLinesRef.current = [];
    copyableZonePricesRef.current = [];
    if (!levelsEnabled) return;

    // Map zone title codes → human-readable speech labels
    const ZONE_LABELS: Record<string, string> = {
      PDH: "Previous Day High",
      PDL: "Previous Day Low",
      PDM: "Previous Day Mid",
      "75%": "Previous Day 75%",
      "25%": "Previous Day 25%",
      MH: "Monday High",
      ML: "Monday Low",
      WH: "Weekend High",
      WM: "Weekend Mid",
      WL: "Weekend Low",
      PWH: "Previous Week High",
      PWL: "Previous Week Low",
    };

    const add = (
      price: number,
      color: string,
      width: number,
      style: LineStyle,
      title: string,
    ) => {
      const roundedPrice = roundPrice(price);
      const line = series.createPriceLine({
        price: roundedPrice,
        color,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineWidth: width as any,
        lineStyle: style,
        axisLabelVisible: false,
        title,
      });
      const label = ZONE_LABELS[title] ?? title;
      zoneLinesRef.current.push({ line, price: roundedPrice, labelVisible: false });
      copyableZonePricesRef.current.push({ price: roundedPrice, label, isCustom: false });
    };

    if (zones) {
      if (lineToggles.weekly && zones.prevWeek) {
        add(zones.prevWeek.high, "#ce93d8", 2.5, LineStyle.Solid, "PWH");
        add(zones.prevWeek.low, "#ce93d8", 2.5, LineStyle.Solid, "PWL");
      }
      if (lineToggles.monday && zones.monday) {
        add(zones.monday.high, "#42a5f5", 2, LineStyle.Solid, "MH");
        add(zones.monday.low, "#42a5f5", 2, LineStyle.Solid, "ML");
      }
      if (lineToggles.pdhlm && zones.prevDay) {
        add(zones.prevDay.high, "#ffffff", 2.5, LineStyle.Solid, "PDH");
        add(zones.prevDay.mid, "rgba(255,255,255,0.85)", 2, LineStyle.Dashed, "PDM");
        add(zones.prevDay.low, "#ffffff", 2.5, LineStyle.Solid, "PDL");
      }
      if (lineToggles.fibb && zones.prevDay) {
        add(zones.prevDay.p75, "#ffeb3b", 2, LineStyle.Dotted, "75%");
        add(zones.prevDay.p25, "#ffeb3b", 2, LineStyle.Dotted, "25%");
      }
      if (lineToggles.weekend && zones.weekend) {
        add(zones.weekend.high, "#42a5f5", 2, LineStyle.Solid, "WH");
        add(zones.weekend.mid, "rgba(66, 165, 245, 0.85)", 2, LineStyle.Dashed, "WM");
        add(zones.weekend.low, "#42a5f5", 2, LineStyle.Solid, "WL");
      }
    }
    for (let i = 0; i < customLevels.length; i++) {
      const level = customLevels[i]!;
      const color = CUSTOM_LEVEL_COLORS[level.color] ?? "#f8ea3b";
      const roundedPrice = roundPrice(level.price);
      const line = series.createPriceLine({
        price: roundedPrice,
        color,
        lineWidth: 3,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: false,
        title: `C${i + 1}`,
      });
      zoneLinesRef.current.push({ line, price: roundedPrice, labelVisible: false });
      copyableZonePricesRef.current.push({ price: roundedPrice, label: "Liquidity Pool", isCustom: true });
    }
    scheduleZoneLabelVisibilityUpdate();
  }, [zones, lineToggles, customLevels, chartReady, levelsEnabled]);

  // --- Polling: initial history load + poll every :00, :05, :10, ..., :55 seconds mark ---
  useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      try {
        setStatus("connecting");
        const snapshot = await fetchLatestKlines(interval, 500, symbol);
        if (cancelled || !candleRef.current || snapshot.length === 0) return;

        const clean = cleanAndSort(snapshot);
        cacheRef.current = clean;
        seedHistory(interval, clean, symbol);

        let series: Kline[];
        if (heikin) {
          const built = heikinSeriesAndAnchor(clean);
          series = built.series;
          lastClosedHaRef.current = built.lastClosed;
          lastHaRef.current = built.lastClosed;
        } else {
          series = clean;
          lastClosedHaRef.current = null;
          lastHaRef.current = null;
        }
        displayCacheRef.current = series;
        rebuildHoverData(clean, series);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candleRef.current.setData(series as any);
        if (footprintEnabledRef.current && deltaRef.current) {
          deltaRef.current.setData(clean.map((b) => {
            const dv = candleDelta(b);
            return {
              time: b.time as Time,
              value: dv,
              color: dv >= 0 ? "#08907a" : "#e23442",
            };
          }));
        }

        if (series.length > 0) {
          const lastBar = series[series.length - 1]!;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
          if (!heikin) setTabTitle(lastBar.close);
        }

        recomputeEmas(clean);
        paintLatestOhlc();
        updateClosePriceLine();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => applyDefaultView());
        });
        setStatus("live");
      } catch (err) {
        if (!cancelled) {
          console.warn(`[chart] initial fetch failed for ${interval}:`, err);
          setStatus("off");
        }
      }
    };

    void loadInitial();

    const pollLatest = async () => {
      if (cancelled || !candleRef.current) return;
      try {
        const latest = await fetchLatestKlines(interval, 20, symbol);
        if (cancelled || !candleRef.current || latest.length === 0) return;
        updateWithLatestBars(latest);
        setStatus("live");
      } catch (err) {
        if (!cancelled) {
          console.warn(`[chart] poll failed for ${interval}:`, err);
        }
      }
    };

    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNextPoll = () => {
      if (cancelled) return;
      const now = Date.now();
      const intervalMs = 2000;
      const remainder = now % intervalMs;
      // Wait until next 2-second mark (:00, :02, :04, ..., :58) + 50ms buffer
      const delay = (intervalMs - remainder) + 50;
      pollTimer = setTimeout(async () => {
        await pollLatest();
        scheduleNextPoll();
      }, delay);
    };

    scheduleNextPoll();

    const onVisibilityChange = () => {
      if (document.hidden) {
        tabHiddenRef.current = true;
      } else {
        tabHiddenRef.current = false;
        void pollLatest();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [interval, heikin, symbol]);

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
        title={`EMA ${p} — Click to ${on ? "Hide" : "Show"}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleEma(p);
        }}
      >
        <span className="chip-num">{p}</span>
      </button>
    );
  });

  const toggleFootprint = () => {
    const next = !footprintEnabledRef.current;
    footprintEnabledRef.current = next;
    setFootprintEnabled(next);
    const chart = chartRef.current;
    if (next) {
      createDeltaSeries();
    } else {
      if (deltaHoverRef.current) deltaHoverRef.current.style.display = "none";
      deltaHoverKeyRef.current = null;
      const delta = deltaRef.current;
      if (chart && delta) {
        chart.removeSeries(delta);
        if (chart.panes().length > 1) chart.removePane(1);
      }
      deltaRef.current = null;
    }
  };

  return (
    <>
      {/* Header: [symbol] [Level] [right-col: (EMA·Delta·OHLC) / (HTF row)] */}
      <div className="cell-header">
        <span className="symbol">
          {symbol} · {formatTfLabel(interval)} · Binance{heikin ? " · Heikin Ashi" : ""}
        </span>
        <div className="cell-header-controls">
          {/* Level sits alone so it stays vertically centred regardless of whether row2 exists */}
          <button
            type="button"
            className={`level-chip${levelsEnabled ? " active" : " off"}`}
            aria-pressed={levelsEnabled}
            title={`Levels — Click to ${levelsEnabled ? "Hide" : "Show"} All Price Lines`}
            onClick={(e) => {
              e.stopPropagation();
              toggleLevels();
            }}
          >
            Level
          </button>
          {/* Right sub-column: row1 (EMA chips · Delta · OHLC) + row2 (HTF, aligns under "10") */}
          <div className="cell-header-right">
            <div className="cell-header-row">
              <div className="ema-group">{emaLegend}</div>
              {allowFootprint && (
                <button
                  type="button"
                  className={`footprint-chip${footprintEnabled ? " active" : " off"}`}
                  aria-pressed={footprintEnabled}
                  title={`Footprint delta — Click to ${footprintEnabled ? "Hide" : "Show"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFootprint();
                  }}
                >
                  Delta
                </button>
              )}
              <div className="ohlc-bar">
                <span><b>O</b> <span ref={ohlcOpenRef} /></span>
                <span><b>H</b> <span ref={ohlcHighRef} /></span>
                <span><b>L</b> <span ref={ohlcLowRef} /></span>
                <span><b>C</b> <span ref={ohlcCloseRef} /></span>
              </div>
            </div>
            {/* HTF row — aligns under "10" because it shares the right sub-column */}
            {allowHtfEma && (
              <div className="cell-header-htf-row">
                {HTF_EMA_CONFIGS.map((cfg) => (
                  <button
                    key={cfg.key}
                    type="button"
                    className={`footprint-chip${htfEnabled[cfg.key] ? " active" : " off"}`}
                    aria-pressed={htfEnabled[cfg.key]}
                    title={`${cfg.label} EMA — Click to ${htfEnabled[cfg.key] ? "Hide" : "Show"}`}
                    style={htfEnabled[cfg.key] ? { background: cfg.color, borderColor: cfg.color, color: "#0b0e13" } : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleHtfEma(cfg.key);
                    }}
                  >
                    {cfg.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer removed: no live label, no TZ dropdown per chart.
          TZ is controlled by the single global dropdown (bottom-right of screen). */}

      <div
        ref={containerRef}
        className="chart-canvas"
        style={{ width: "100%", height: "100%", cursor: "crosshair" }}
      />
      {copyToast && (
        <div className="copy-toast" role="status">
          <span className="copy-toast-icon">✓</span>
          <span>
            Successfully copied <strong>{copyToast}</strong> to the clipboard
          </span>
        </div>
      )}
      <div ref={deltaHoverRef} className="delta-hover-value" aria-hidden="true" />

      {/* Right-click context menu */}
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
              onResetView?.();
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <polyline points="3 4 3 9 8 9" />
            </svg>
            Reset Price Scale
          </button>
          {/* EMA Alert */}
          {contextMenu.emaContext && (onSetEmaAlertRef.current || onCancelEmaAlertRef.current) && (
            <button
              className="context-menu-item"
              onClick={() => {
                if (contextMenu.emaContext!.hasAlert) {
                  onCancelEmaAlertRef.current?.(contextMenu.emaContext!.period);
                } else {
                  onSetEmaAlertRef.current?.(contextMenu.emaContext!.period);
                }
                setContextMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {contextMenu.emaContext.hasAlert ? (
                  <>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </>
                )}
              </svg>
              {contextMenu.emaContext.hasAlert
                ? `Cancel Alert: ${contextMenu.emaContext.interval} ${contextMenu.emaContext.period} EMA`
                : `Set Alert: ${contextMenu.emaContext.interval} ${contextMenu.emaContext.period} EMA`
              }
            </button>
          )}

          {/* Price Alert */}
          {contextMenu.priceContext && (onSetPriceAlertRef.current || onCancelPriceAlertRef.current) && (
            <button
              className="context-menu-item"
              onClick={() => {
                if (contextMenu.priceContext!.hasAlert) {
                  onCancelPriceAlertRef.current?.(contextMenu.priceContext!.price);
                } else {
                  onSetPriceAlertRef.current?.(contextMenu.priceContext!.price, contextMenu.priceContext!.label);
                }
                setContextMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {contextMenu.priceContext.hasAlert ? (
                  <>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </>
                )}
              </svg>
              {contextMenu.priceContext.hasAlert
                ? `Cancel Alert: ${contextMenu.priceContext.label}`
                : `Set Alert: ${contextMenu.priceContext.label}`
              }
            </button>
          )}

          {contextMenu.customLevel && (
            <>
              {editingLevel ? (
                <div
                  className="context-menu-edit-form"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    className="context-menu-input"
                    value={editPriceInput}
                    onChange={(e) => setEditPriceInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        const val = parseFloat(editPriceInput.replace(/,/g, "").trim());
                        if (Number.isFinite(val) && val > 0 && contextMenu.customLevel) {
                          onEditCustomLevel?.(contextMenu.customLevel.price, val);
                        }
                        setContextMenu(null);
                        setEditingLevel(false);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingLevel(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="context-menu-save-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const val = parseFloat(editPriceInput.replace(/,/g, "").trim());
                      if (Number.isFinite(val) && val > 0 && contextMenu.customLevel) {
                        onEditCustomLevel?.(contextMenu.customLevel.price, val);
                      }
                      setContextMenu(null);
                      setEditingLevel(false);
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditPriceInput(String(contextMenu.customLevel!.price));
                    setEditingLevel(true);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                  Edit Price level
                </button>
              )}
              <button
                className="context-menu-item"
                onClick={() => {
                  const price = contextMenu.customLevel!.price;
                  setContextMenu(null);
                  setEditingLevel(false);
                  onDeleteCustomLevel?.(price);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
                Remove this line
              </button>
            </>
          )}
        </div>
      )}

      {/* Dismiss the context menu on any global click. */}
      <ContextMenuDismiss
        onAnyClick={() => {
          setContextMenu(null);
          setEditingLevel(false);
        }}
      />
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