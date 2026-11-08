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


interface HoverData {
  open: string;
  high: string;
  low: string;
  close: string;
  change: string;
  changeClass: "up" | "down";
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

/** Default zoom: ~9px per bar so candles stay readable (CoinGlass-like).
 *  Visible bar count then follows pane width instead of stuffing 500 bars in. */
const TARGET_BAR_SPACING = 9;
/** Tiny extra pad after the last *future* whitespace bar. */
const RIGHT_GAP_BARS = 2;

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

/** Snap level prices to 0.0 / 0.5 / 1.0 (0.45 → 0.5). */
function roundHalf(n: number): number {
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
const DEFAULT_BAR_SPACING = 9;
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
    priceFormatter: formatPrice,
  };
}

function formatPrice(price: number): string {
  return String(Math.round(price));
}

const PRICE_FORMAT = {
  type: "custom" as const,
  minMove: 1,
  formatter: formatPrice,
};

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

export type LinkedCrosshairId = "raw" | "heikin";
export type LinkedCrosshairSync = (time: number | null) => void;

const DEFAULT_EMAS: number[] = [10, 20, 50, 200];
const DEFAULT_EMA_OFF: number[] = [];

interface Props {
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
  /** Display timezone offset (hours). Shared global state from page. */
  tz?: TzOffset;
  /** Horizontal levels from the calendar date (does not move the chart). */
  zones?: Zones | null;
  lineToggles?: LineToggles;
  customLevels?: CustomLevel[];
  onDeleteCustomLevel?: (price: number) => void;
  onChartDoubleClick?: () => void;
  registerTimeScale?: (api: ITimeScaleApi<Time> | null) => void;
  siblingScales?: React.MutableRefObject<ITimeScaleApi<Time>[]>;
  linkedCrosshairId?: LinkedCrosshairId;
  registerLinkedCrosshair?: (
    id: LinkedCrosshairId,
    sync: LinkedCrosshairSync | null,
  ) => void;
  onLinkedCrosshair?: (id: LinkedCrosshairId, time: number | null) => void;
}

export default function Chart({
  interval,
  heikin = false,
  emas = DEFAULT_EMAS,
  defaultEmaOff = DEFAULT_EMA_OFF,
  allowFootprint = true,
  defaultFootprintEnabled = false,
  defaultLevelsEnabled = true,
  tz = 0,
  zones = null,
  lineToggles = { weekly: true, monday: false, pdhlm: true, fibb: false, weekend: false },
  customLevels = [],
  onDeleteCustomLevel,
  onChartDoubleClick,
  registerTimeScale,
  siblingScales,
  linkedCrosshairId,
  registerLinkedCrosshair,
  onLinkedCrosshair,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
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
  const copyableZonePricesRef = useRef<number[]>([]);
  const zoneLabelFrameRef = useRef<number | null>(null);

  const lastHaRef = useRef<{ open: number; close: number } | null>(null);
  const lastClosedHaRef = useRef<{ open: number; close: number } | null>(null);
  /** True while the user's visible range covers the latest bar. When the user
   *  drags left into history we set this to false and stop auto-following. */
  const pinnedToRightRef = useRef(true);
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
  const ohlcChangeRef = useRef<HTMLSpanElement | null>(null);
  const deltaHoverRef = useRef<HTMLDivElement | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const deltaHoverKeyRef = useRef<string | null>(null);
  const hoverDataRef = useRef(new Map<number, HoverData>());

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
  const [levelsEnabled, setLevelsEnabled] = useState(defaultLevelsEnabled);
  const levelsEnabledRef = useRef(defaultLevelsEnabled);
  levelsEnabledRef.current = levelsEnabled;
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Right-click context menu state. */
  const customLevelsRef = useRef(customLevels);
  customLevelsRef.current = customLevels;
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    customLevel?: CustomLevel | null;
  } | null>(null);

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
    if (ohlcChangeRef.current) {
      ohlcChangeRef.current.textContent = data.change;
      ohlcChangeRef.current.className = data.changeClass;
    }
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
    const previous = index > 0 ? displayed[index - 1]! : null;
    const baseline = previous ? previous.close : bar.open;
    const change = ((bar.close - baseline) / (baseline || 1)) * 100;
    const delta = candleDelta(rawBar);
    const data: HoverData = {
      open: fmt(bar.open),
      high: fmt(bar.high),
      low: fmt(bar.low),
      close: fmt(bar.close),
      change: `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`,
      changeClass: change >= 0 ? "up" : "down",
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

  /** Full state flush when waking from background tab sleep. */
  const flushFullState = () => {
    const series = displayCacheRef.current;
    const raw = cacheRef.current;
    if (!candleRef.current || series.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candleRef.current.setData(series as any);
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
      const older = await fetchOlderKlines(interval, endTime, 1000);
      const cut = older.filter((bar) => bar.time < firstTime);
      if (cut.length === 0) {
        exhaustedOlderRef.current = true;
        return;
      }
      const raw = cleanAndSort([...cut, ...cacheRef.current]);
      cacheRef.current = raw;
      seedHistory(interval, raw);

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
      seedHistory(interval, clean);
      return;
    }

    const prevLastTime = raw[raw.length - 1]!.time;
    const barMap = new Map<number, Kline>();
    for (const b of raw) barMap.set(b.time, b);
    for (const b of latestBars) barMap.set(b.time, b);
    const merged = cleanAndSort([...barMap.values()]);
    cacheRef.current = merged;
    seedHistory(interval, merged);

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

    if (!tabHiddenRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
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
      if (series.length > 0) {
        const lastBar = series[series.length - 1]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
        if (!heikin) setTabTitle(lastBar.close);
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
    rightScaleRef.current?.setAutoScale(true);
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
        priceFormat: PRICE_FORMAT,
        crosshairMarkerVisible: false,
      });
    };
    for (const period of emas) {
      if (period >= 50) addEma(period);
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
      priceFormat: PRICE_FORMAT,
    });
    candleRef.current = candle;

    if (footprintEnabledRef.current) createDeltaSeries();

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
      tOriginating = true;
      try {
        const siblings = siblingScales?.current ?? [];
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const cached = cacheRef.current;
        pinnedToRightRef.current = range.to >= cached.length - 2;
        if (range.from < 30) {
          void loadOlderHistoryForChart();
        }
        for (const sib of siblings) {
          if (sib && sib !== ts) sib.setVisibleLogicalRange(range);
        }
      } finally {
        setTimeout(() => {
          tOriginating = false;
        }, 0);
      }
    };
    ts.subscribeVisibleLogicalRangeChange(onTimeRange);
    registerTimeScale?.(ts);

    // OHLC hover legend — find the bar closest to the cursor's time.
    const onCrosshair = (p: MouseEventParams) => {
      const time = p.time == null ? null : (p.time as number);
      updateHoverAtTime(time);
      if (p.point != null && linkedCrosshairActiveRef.current) {
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
    containerRef.current?.addEventListener("pointerleave", onPointerLeave);

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
          pointerInsideChartRef.current = false;
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
      if (!onChartDoubleClick) return;
      const series = candleRef.current;
      let closestPrice: number | null = null;
      let minPixelDiff = Infinity;
      if (series && copyableZonePricesRef.current.length > 0 && el) {
        const rect = el.getBoundingClientRect();
        const y = e.clientY - rect.top;
        for (const price of copyableZonePricesRef.current) {
          const lineY = series.priceToCoordinate(price);
          if (lineY == null) continue;
          const diff = Math.abs(lineY - y);
          if (diff < minPixelDiff) {
            minPixelDiff = diff;
            closestPrice = price;
          }
        }
      }
      if (closestPrice == null || minPixelDiff > 10) {
        onChartDoubleClick();
        return;
      }

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
          const lineY = series.priceToCoordinate(roundHalf(level.price));
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

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        customLevel: matchedCustomLevel,
      });
    };

    el?.addEventListener("dblclick", onDoubleClick);
    el?.addEventListener("contextmenu", onContext);

    // --- Countdown timer (every second) ------------------------------------
    const countdownTimer = setInterval(() => {
      updateClosePriceLine();
    }, 1000);

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
      if (closeLineRef.current && candleRef.current) {
        try {
          candleRef.current.removePriceLine(closeLineRef.current);
        } catch (_) { /* ignore */ }
      }
      closeLineRef.current = null;
      el?.removeEventListener("dblclick", onDoubleClick);
      el?.removeEventListener("contextmenu", onContext);
      el?.removeEventListener("pointerenter", onPointerEnter);
      el?.removeEventListener("pointerleave", onPointerLeave);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      if (linkedCrosshairFrameRef.current !== null) {
        cancelAnimationFrame(linkedCrosshairFrameRef.current);
        linkedCrosshairFrameRef.current = null;
      }
      pendingLinkedCrosshairRef.current = null;
      const sibs = siblingScales?.current;
      if (sibs) {
        const i = sibs.indexOf(ts);
        if (i >= 0) sibs.splice(i, 1);
      }
      registerTimeScale?.(null);
      if (linkedCrosshairId) {
        registerLinkedCrosshair?.(linkedCrosshairId, null);
      }
      chart.remove();
      chartRef.current = null;
      rightScaleRef.current = null;
      deltaRef.current = null;
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
    for (const zoneLine of zoneLinesRef.current) {
      try { series.removePriceLine(zoneLine.line); } catch (_) { /* already removed */ }
    }
    zoneLinesRef.current = [];
    copyableZonePricesRef.current = [];
    if (!levelsEnabled) return;

    const add = (
      price: number,
      color: string,
      width: number,
      style: LineStyle,
      title: string,
    ) => {
      const roundedPrice = roundHalf(price);
      const line = series.createPriceLine({
        price: roundedPrice,
        color,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineWidth: width as any,
        lineStyle: style,
        axisLabelVisible: false,
        title,
      });
      zoneLinesRef.current.push({ line, price: roundedPrice, labelVisible: false });
      copyableZonePricesRef.current.push(roundedPrice);
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
      const roundedPrice = roundHalf(level.price);
      const line = series.createPriceLine({
        price: roundedPrice,
        color,
        lineWidth: 3,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: false,
        title: `C${i + 1}`,
      });
      zoneLinesRef.current.push({ line, price: roundedPrice, labelVisible: false });
      copyableZonePricesRef.current.push(roundedPrice);
    }
    scheduleZoneLabelVisibilityUpdate();
  }, [zones, lineToggles, customLevels, chartReady, levelsEnabled]);

  // --- Polling: initial history load + poll every :00, :05, :10, ..., :55 seconds mark ---
  useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      try {
        setStatus("connecting");
        const snapshot = await fetchLatestKlines(interval, 500);
        if (cancelled || !candleRef.current || snapshot.length === 0) return;

        const clean = cleanAndSort(snapshot);
        cacheRef.current = clean;
        seedHistory(interval, clean);

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
        const latest = await fetchLatestKlines(interval, 20);
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
      const intervalMs = 3000;
      const remainder = now % intervalMs;
      // Wait until next 3-second mark (:00, :03, :06, ..., :57) + 50ms buffer
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
      {/* Header — timeframe + level + EMA + foot + OHLC. */}
      <div className="cell-header">
        <span className="symbol">
          BTCUSDT · {formatTfLabel(interval)} · Binance{heikin ? " · Heikin Ashi" : ""}
        </span>
        <button
          type="button"
          className={`level-chip${levelsEnabled ? " active" : " off"}`}
          aria-pressed={levelsEnabled}
          title={`Levels — click to ${levelsEnabled ? "hide" : "show"} all price lines`}
          onClick={(e) => {
            e.stopPropagation();
            setLevelsEnabled((prev) => !prev);
          }}
        >
          Level
        </button>
        <div className="ema-group">{emaLegend}</div>
        {allowFootprint && (
          <button
            type="button"
            className={`footprint-chip${footprintEnabled ? " active" : " off"}`}
            aria-pressed={footprintEnabled}
            title={`Footprint delta — click to ${footprintEnabled ? "hide" : "show"}`}
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
          <span ref={ohlcChangeRef} />
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
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <polyline points="3 4 3 9 8 9" />
            </svg>
            Reset Price Scale
          </button>
          {contextMenu.customLevel && (
            <button
              className="context-menu-item"
              onClick={() => {
                const price = contextMenu.customLevel!.price;
                setContextMenu(null);
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
          )}
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