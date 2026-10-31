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
import type { Socket } from "socket.io-client";
import { getSharedSocket } from "../lib/socket";
import {
  seedHistory,
  applyLiveKline,
  getHistory,
  loadOlderHistory,
  subscribeHistory,
  pullAuthoritativeKlines,
} from "../lib/historyStore";

/** Mirror the server's Kline shape. */
interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
  closed: boolean;
}


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

type LinkedCrosshairId = "raw" | "heikin";
type LinkedCrosshairSync = (time: number | null) => void;

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

function formatCountdown(interval: string, barTime: number): string {
  const step = intervalSeconds(interval);
  const closeTime = barTime + step;
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, closeTime - now);
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
  /** Register this chart's time scale so siblings can mirror zoom/pan. */
  registerTimeScale?: (api: ITimeScaleApi<Time> | null) => void;
  siblingScales?: React.MutableRefObject<ITimeScaleApi<Time>[]>;
  /** Price scales to synchronize while this chart's price axis is dragged. */
  registerPriceScale?: (api: IPriceScaleApi | null) => void;
  siblingPriceScales?: React.MutableRefObject<IPriceScaleApi[]>;
  onChartDoubleClick?: () => void;
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
  emas = [],
  defaultEmaOff = [],
  defaultFootprintEnabled = false,
  defaultLevelsEnabled = interval !== "3m",
  tz = 0,
  zones = null,
  lineToggles = { weekly: true, monday: false, pdhlm: true, fibb: false, weekend: false },
  customLevels = [],
  onDeleteCustomLevel,
  registerTimeScale,
  siblingScales,
  registerPriceScale,
  siblingPriceScales,
  onChartDoubleClick,
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
  /** Last closed bar EMA values: {period → closedEma}. Live forming candle EMA is derived smoothly from this without mutating closed state. */
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
  const suppressLinkedCrosshairRef = useRef(false);
  const linkedCrosshairGenerationRef = useRef(0);
  const lastLinkedCrosshairTimeRef = useRef<number | null>(null);
  const pendingLinkedCrosshairRef = useRef<{ time: number | null } | null>(null);
  const linkedCrosshairFrameRef = useRef<number | null>(null);
  const linkedCrosshairActiveRef = useRef(false);
  const pointerInsideChartRef = useRef(false);
  const deltaHoverPositionFrameRef = useRef<number | null>(null);
  /** Cached pane1 offsetTop — refreshed on resize, used to avoid layout reflow on every crosshair move. */
  const pane1OffsetTopRef = useRef<number>(0);
  /** rAF-throttle: pending candle payload waiting to be flushed to the series. */
  const pendingCandleRef = useRef<Kline | null>(null);
  /** rAF-throttle: pending per-EMA values {period → value} waiting to flush. */
  const pendingEmaRef = useRef<Map<number, { time: number; value: number }>>(new Map());
  /** rAF handle for the candle+EMA flush. */
  const paintRafRef = useRef<number | null>(null);
  const tabHiddenRef = useRef(false);
  const missedTicksRef = useRef(false);
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
  const [footprintEnabled, setFootprintEnabled] = useState(defaultFootprintEnabled);
  const footprintEnabledRef = useRef(defaultFootprintEnabled);
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
    const color = isUp ? "#26a69a" : "#ef5350";
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
      deltaColor: delta >= 0 ? "#00c853" : "#ef5350",
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
        color: value >= 0 ? "#26a69a" : "#ef5350",
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
        line.setData([]);
        continue;
      }
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
          color: value >= 0 ? "#26a69a" : "#ef5350",
        };
      }));
    }
    const lastBar = series[series.length - 1]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
    if (interval === "1m" && !heikin) setTabTitle(lastBar.close);
    paintEmas(series);
    paintLatestOhlc();
    updateClosePriceLine();
    if (pinnedToRightRef.current) {
      applyDefaultView();
    }
  };

  /** Reconcile closed klines against official Binance REST endpoint.
   *  Guarantees 100% CoinGlass-identical candles, bar counts, and smooth EMAs. */
  const reconcileAuthoritative = async () => {
    if (!candleRef.current) return;
    try {
      const authoritativeRaw = await pullAuthoritativeKlines(interval, 200);
      if (!candleRef.current) return;

      const lastAuthTime = authoritativeRaw[authoritativeRaw.length - 1]?.time ?? 0;
      const currentCache = cacheRef.current;
      const localLast = currentCache[currentCache.length - 1];
      const merged = authoritativeRaw.slice();
      if (localLast && localLast.time > lastAuthTime && !localLast.closed) {
        merged.push(localLast);
      }
      cacheRef.current = merged;

      let series: Kline[];
      if (heikin) {
        const built = heikinSeriesAndAnchor(cacheRef.current);
        series = built.series;
        lastClosedHaRef.current = built.lastClosed;
        lastHaRef.current = built.lastClosed;
      } else {
        series = cacheRef.current;
        lastClosedHaRef.current = null;
        lastHaRef.current = null;
      }
      displayCacheRef.current = series;
      rebuildHoverData(cacheRef.current, series);

      if (!tabHiddenRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candleRef.current.setData(series as any);
        if (footprintEnabledRef.current && deltaRef.current) {
          deltaRef.current.setData(cacheRef.current.map((b) => {
            const dv = candleDelta(b);
            return {
              time: b.time as Time,
              value: dv,
              color: dv >= 0 ? "#26a69a" : "#ef5350",
            };
          }));
        }
        paintEmas(series);
        const lastBar = series[series.length - 1]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
        paintLatestOhlc();
        updateClosePriceLine();
      }
    } catch (err) {
      console.warn(`[chart] reconcile failed for ${interval}:`, err);
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
        background: { color: "transparent" },
        textColor: "#bfc4ce",
        fontSize: 12,
        fontFamily: "Arial, Helvetica, sans-serif",
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
        vertLine: { color: "rgba(190, 196, 208, 0.7)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39" },
        horzLine: { color: "rgba(190, 196, 208, 0.7)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39" },
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
    registerPriceScale?.(right);

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
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
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
          color: value >= 0 ? "#26a69a" : "#ef5350",
        };
      }));
      const lastBar = series[series.length - 1]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
      const first = savedBars[0]!.open;
      if (interval === "1m" && !heikin) setTabTitle(lastBar.close);
      recomputeEmas(savedBars);
      paintLatestOhlc();
      updateClosePriceLine();
      requestAnimationFrame(() => applyDefaultView());
    }

    // --- Time-scale sync ----------------------------------------------------
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
        const totalBars = cached.length + futureBarCount(interval) + RIGHT_GAP_BARS;
        const distFromRight = totalBars - range.to;
        pinnedToRightRef.current = distFromRight < 3;
        if (range.from < 30) {
          void loadOlderHistory(interval);
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
      if (linkedCrosshairActiveRef.current) {
        linkedCrosshairActiveRef.current = false;
      }
      chart.applyOptions({
        crosshair: {
          horzLine: { visible: true, labelVisible: true },
        },
      });
    };
    const onPointerLeave = () => {
      pointerInsideChartRef.current = false;
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
    let priceScaleFrame: number | null = null;
    let priceScalePointerId: number | null = null;
    const syncPriceScale = () => {
      updateZoneLabelVisibility();
      const range = right.getVisibleRange();
      if (range) {
        for (const sibling of siblingPriceScales?.current ?? []) {
          if (sibling === right) continue;
          const siblingRange = sibling.getVisibleRange();
          if (
            !siblingRange
            || siblingRange.from !== range.from
            || siblingRange.to !== range.to
          ) {
            sibling.setVisibleRange(range);
          }
        }
      }
      if (priceScalePointerId !== null) {
        priceScaleFrame = requestAnimationFrame(syncPriceScale);
      }
    };
    const onPriceScalePointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !el || right.width() <= 0) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX < rect.right - right.width()) return;
      priceScalePointerId = e.pointerId;
      if (priceScaleFrame === null) {
        priceScaleFrame = requestAnimationFrame(syncPriceScale);
      }
    };
    const onPriceScalePointerUp = (e: PointerEvent) => {
      if (e.pointerId !== priceScalePointerId) return;
      priceScalePointerId = null;
      if (priceScaleFrame !== null) {
        cancelAnimationFrame(priceScaleFrame);
        priceScaleFrame = null;
      }
      syncPriceScale();
    };
    el?.addEventListener("dblclick", onDoubleClick);
    el?.addEventListener("contextmenu", onContext);
    el?.addEventListener("pointerdown", onPriceScalePointerDown);
    window.addEventListener("pointerup", onPriceScalePointerUp);
    window.addEventListener("pointercancel", onPriceScalePointerUp);

    const onVisibilityChange = () => {
      if (document.hidden) {
        tabHiddenRef.current = true;
        if (paintRafRef.current !== null) {
          cancelAnimationFrame(paintRafRef.current);
          paintRafRef.current = null;
        }
        if (linkedCrosshairFrameRef.current !== null) {
          cancelAnimationFrame(linkedCrosshairFrameRef.current);
          linkedCrosshairFrameRef.current = null;
        }
        if (zoneLabelFrameRef.current !== null) {
          cancelAnimationFrame(zoneLabelFrameRef.current);
          zoneLabelFrameRef.current = null;
        }
        if (deltaHoverPositionFrameRef.current !== null) {
          cancelAnimationFrame(deltaHoverPositionFrameRef.current);
          deltaHoverPositionFrameRef.current = null;
        }
        pendingCandleRef.current = null;
        pendingEmaRef.current.clear();
      } else {
        tabHiddenRef.current = false;
        void reconcileAuthoritative();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // --- Countdown timer (every second) ------------------------------------
    const countdownTimer = setInterval(() => {
      updateClosePriceLine();
    }, 1000);

    // Place the default view once the cell has a real size AND history is in.
    // Do not fitContent() on an empty/0-width chart — that is what left the
    // 1m panes stuck on the left with a huge empty gap.
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
      if (linkedCrosshairFrameRef.current !== null) {
        cancelAnimationFrame(linkedCrosshairFrameRef.current);
        linkedCrosshairFrameRef.current = null;
      }
      if (zoneLabelFrameRef.current !== null) {
        cancelAnimationFrame(zoneLabelFrameRef.current);
        zoneLabelFrameRef.current = null;
      }
      if (deltaHoverPositionFrameRef.current !== null) {
        cancelAnimationFrame(deltaHoverPositionFrameRef.current);
        deltaHoverPositionFrameRef.current = null;
      }
      if (paintRafRef.current !== null) {
        cancelAnimationFrame(paintRafRef.current);
        paintRafRef.current = null;
      }
      if (priceScaleFrame !== null) cancelAnimationFrame(priceScaleFrame);
      clearInterval(countdownTimer);
      if (closeLineRef.current && candleRef.current) {
        try {
          candleRef.current.removePriceLine(closeLineRef.current);
        } catch (_) { /* ignore */ }
      }
      closeLineRef.current = null;
      pendingLinkedCrosshairRef.current = null;
      el?.removeEventListener("dblclick", onDoubleClick);
      el?.removeEventListener("contextmenu", onContext);
      el?.removeEventListener("pointerdown", onPriceScalePointerDown);
      el?.removeEventListener("pointerenter", onPointerEnter);
      el?.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerup", onPriceScalePointerUp);
      window.removeEventListener("pointercancel", onPriceScalePointerUp);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      const sibs = siblingScales?.current;
      if (sibs) {
        const i = sibs.indexOf(ts);
        if (i >= 0) sibs.splice(i, 1);
      }
      const priceScales = siblingPriceScales?.current;
      if (priceScales) {
        const i = priceScales.indexOf(right);
        if (i >= 0) priceScales.splice(i, 1);
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
      width: 1 | 2 | 3 | 4,
      style: LineStyle,
      title: string,
    ) => {
      const roundedPrice = roundHalf(price);
      const line = series.createPriceLine({
        price: roundedPrice,
        color,
        lineWidth: width,
        lineStyle: style,
        axisLabelVisible: false,
        title,
      });
      zoneLinesRef.current.push({ line, price: roundedPrice, labelVisible: false });
      copyableZonePricesRef.current.push(roundedPrice);
    };

    if (zones) {
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
    }
    for (let i = 0; i < customLevels.length; i++) {
      const level = customLevels[i]!;
      const color = level.color === "red"
        ? "#ef5350"
        : level.color === "green"
          ? "#7cfc00"
          : "#ffeb3b";
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

  // --- socket: history + live updates --------------------------------------
  useEffect(() => {
    const sock = getSharedSocket();

    const onConnect = () => setStatus("live");
    const onDisconnect = () => setStatus("off");
    const onConnectError = () => setStatus("off");

    if (sock.connected) setStatus("live");

    sock.on("connect", onConnect);
    sock.on("disconnect", onDisconnect);
    sock.on("connect_error", onConnectError);

    const onPrice = (p: number) => {
      if (interval === "1m" && !heikin) setTabTitle(p);
    };

    const onHistory = (payload: Record<string, Kline[]>) => {
      const snapshot = payload[interval];
      if (!snapshot || !candleRef.current) return;
      seedHistory(interval, snapshot);
      const raw = getHistory(interval);
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

      cacheRef.current = raw.slice();
      displayCacheRef.current = series;
      rebuildHoverData(raw, series);

      if (tabHiddenRef.current) {
        missedTicksRef.current = true;
        return;
      }

      // Candles only — future times live on `futureRef` so live `update()`
      // can still mutate the last real bar.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      deltaRef.current?.setData(raw.map((bar) => {
        const value = candleDelta(bar);
        return {
          time: bar.time as Time,
          value,
          color: value >= 0 ? "#26a69a" : "#ef5350",
        };
      }));
      if (series.length > 0) {
        const lastBar = series[series.length - 1]!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current?.setData(futureWhitespace(lastBar.time, interval) as any);
        if (interval === "1m" && !heikin) setTabTitle(lastBar.close);
        const first = raw[0]!.open;
        recomputeEmas(raw);
      }
      paintLatestOhlc();
      updateClosePriceLine();
      // Frame the latest candles after layout. Two rAFs wait for autoSize to
      // pick up the cell's real width (0-width mount otherwise looks empty).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyDefaultView());
      });
    };

    const onKline = (msg: { interval: string; k: Kline }) => {
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
      if (!isNewBar && !isSameBar) {
        if (!bar.closed) return;
        const historicalIndex = cached.findIndex((candidate) => candidate.time === timeSec);
        if (historicalIndex < 0) return;
        cached[historicalIndex] = bar;
        applyLiveKline(interval, bar);
        void reconcileAuthoritative();
        return;
      }

      // A stream can deliver the next bar before the prior bar's final update.
      // Settle that prior bar first so the new HA open uses the correct anchor.
      if (heikin && isNewBar && cached.length > 0) {
        const previousRaw = cached[cached.length - 1]!;
        if (!previousRaw.closed) {
          const finalizedRaw = { ...previousRaw, closed: true };
          cached[cached.length - 1] = finalizedRaw;
          applyLiveKline(interval, finalizedRaw);

          const anchor = lastClosedHaRef.current;
          const finalizedHa = toHeikinOne(
            finalizedRaw,
            anchor?.open ?? 0,
            anchor?.close ?? 0,
            cached.length === 1,
          );
          lastClosedHaRef.current = { open: finalizedHa.open, close: finalizedHa.close };
          lastHaRef.current = lastClosedHaRef.current;
          if (!tabHiddenRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            candleRef.current.update(finalizedHa as any);
          }
          const displayed = displayCacheRef.current;
          if (displayed.length > 0) {
            displayed[displayed.length - 1] = finalizedHa;
            updateHoverData(cached, displayed, displayed.length - 1);
          }
        }
      }

      // ── RAW cache update ──────────────────────────────────────────────────
      if (isNewBar) {
        cached.push(bar);
      } else if (isSameBar && cached.length > 0) {
        cached[cached.length - 1] = bar;
      }
      applyLiveKline(interval, bar);

      // Derive the displayed bar from the last closed HA candle; the live
      // candle never becomes its own rolling anchor.
      let candlePayload: Kline = bar;
      if (heikin) {
        const anchor = lastClosedHaRef.current;
        const ha = toHeikinOne(
          bar,
          anchor?.open ?? 0,
          anchor?.close ?? 0,
          cached.length === 1 && !anchor,
        );
        if (bar.closed) {
          lastClosedHaRef.current = { open: ha.open, close: ha.close };
          lastHaRef.current = { open: ha.open, close: ha.close };
        }
        candlePayload = ha;
      }

      const displayed = displayCacheRef.current;
      if (isNewBar) {
        displayed.push(candlePayload);
      } else if (isSameBar && displayed.length > 0) {
        displayed[displayed.length - 1] = candlePayload;
      }
      if (displayed.length > 0) {
        updateHoverData(cached, displayed, displayed.length - 1);
      }

      // Whenever a candle closes or rolls over: pull authoritative Binance klines
      // to keep all panes and EMAs perfectly aligned.
      if (bar.closed || isNewBar) {
        void reconcileAuthoritative();
      }

      // If tab is in background: bypass canvas paint, viewport shift, and EMA series updates!
      if (tabHiddenRef.current) {
        missedTicksRef.current = true;
        return;
      }

      // ── Close price line + countdown update ──────────────────────────────
      updateClosePriceLine();

      // ── Series update — rAF-throttled ─────────────────────────────────────
      pendingCandleRef.current = candlePayload;
      scheduleZoneLabelVisibilityUpdate();

      if (isNewBar && futureRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        futureRef.current.setData(futureWhitespace(timeSec, interval) as any);
      }

      if (interval === "1m" && !heikin) setTabTitle(bar.close);

      // ── EMA live intra-bar update (smooth interpolation from lastClosedEmaRef) ──
      if (displayed.length > 0 && emas.length > 0) {
        for (let i = 0; i < emas.length; i++) {
          const period = emas[i]!;
          const closedEma = lastClosedEmaRef.current.get(period);
          if (closedEma === undefined) {
            paintEmas(displayed);
            break;
          }
          const alpha = 2 / (period + 1);
          const liveValue = candlePayload.close * alpha + closedEma * (1 - alpha);
          pendingEmaRef.current.set(period, { time: timeSec, value: liveValue });
        }
      }

      // Schedule the actual canvas paint if not already pending.
      if (paintRafRef.current === null) {
        paintRafRef.current = requestAnimationFrame(() => {
          paintRafRef.current = null;
          // Flush candle.
          const cp = pendingCandleRef.current;
          if (cp && candleRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            candleRef.current.update(cp as any);
            pendingCandleRef.current = null;
          }
          // Flush delta.
          if (footprintEnabledRef.current && deltaRef.current && cp) {
            const dv = candleDelta(cp);
            deltaRef.current.update({
              time: cp.time as Time,
              value: dv,
              color: dv >= 0 ? "#26a69a" : "#ef5350",
            });
          }
          // Flush EMAs.
          for (const [period, pt] of pendingEmaRef.current) {
            const idx = emas.indexOf(period);
            const line = idx >= 0 ? emaRefs.current[idx] : undefined;
            if (line && emaEnabledRef.current.has(period)) {
              line.update({ time: pt.time as Time, value: pt.value });
            }
          }
          pendingEmaRef.current.clear();
        });
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
    };

    sock.on("price", onPrice);
    sock.on("history", onHistory);
    sock.on("kline", onKline);

    return () => {
      sock.off("connect", onConnect);
      sock.off("disconnect", onDisconnect);
      sock.off("connect_error", onConnectError);
      sock.off("price", onPrice);
      sock.off("history", onHistory);
      sock.off("kline", onKline);
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
      rebuildHoverData(raw, series);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      deltaRef.current?.setData(raw.map((bar) => {
        const value = candleDelta(bar);
        return {
          time: bar.time as Time,
          value,
          color: value >= 0 ? "#26a69a" : "#ef5350",
        };
      }));
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


  const toggleEmaPair = (p1: number, p2: number) => {
    setEmaEnabled((prev) => {
      const next = new Set(prev);
      const isNowOn = !(next.has(p1) || next.has(p2));
      for (const p of [p1, p2]) {
        if (isNowOn) next.add(p);
        else next.delete(p);
        const idx = emas.indexOf(p);
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
              const smoothed = ema(values, p);
              const data = smoothed.map((v, j) => ({ time: bars[j]!.time as Time, value: v }));
              line.setData(data);
            }
          }
        }
      }
      emaEnabledRef.current = next;
      return next;
    });
  };

  // EMA legend chips — CLICKABLE to toggle the line on/off. "Off" chips are
  // darkened (mixed with the dark cell background) so the user can see at a
  // glance which EMAs are active.
  let emaLegend: React.ReactNode;
  if (interval === "1m") {
    const pairs: [number, number][] = [
      [10, 20],
      [50, 200],
    ];
    emaLegend = pairs.map(([p1, p2]) => {
      const on1 = emaEnabled.has(p1);
      const on2 = emaEnabled.has(p2);
      const pairOn = on1 || on2;
      const base1 = EMA_COLOR[p1] ?? "#fff";
      const base2 = EMA_COLOR[p2] ?? "#fff";
      const bg1 = on1 ? base1 : darken(base1, 0.7);
      const bg2 = on2 ? base2 : darken(base2, 0.7);
      const text1 = on1 ? "#0b0e13" : "#787b87";
      const text2 = on2 ? "#0b0e13" : "#787b87";
      return (
        <button
          key={`${p1}-${p2}`}
          type="button"
          className={`ema-chip-pair${pairOn ? "" : " off"}`}
          title={`EMA ${p1} & ${p2} — click to ${pairOn ? "hide" : "show"}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleEmaPair(p1, p2);
          }}
        >
          <span className="ema-chip-segment" style={{ background: bg1, color: text1 }}>
            {p1}
          </span>
          <span className="ema-chip-segment" style={{ background: bg2, color: text2 }}>
            {p2}
          </span>
        </button>
      );
    });
  } else {
    emaLegend = emas.map((p) => {
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
  }

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
        <span className="tf">
          {interval}
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
          level
        </button>
        <div className="ema-group">{emaLegend}</div>
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
          footprint
        </button>
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