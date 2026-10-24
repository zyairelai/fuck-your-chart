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
  const haClose = (cur.open + cur.high + cur.low + cur.close) / 4;
  const haOpen = isFirst ? (cur.open + cur.close) / 2 : (prevHAOpen + prevHAClose) / 2;
  const haHigh = Math.max(cur.high, haOpen, haClose);
  const haLow = Math.min(cur.low, haOpen, haClose);
  return { time: cur.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: cur.volume, closed: cur.closed };
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
 *   9   -> orange  (#ff9800)
 *   21  -> green   (#4caf50)
 *   50  -> orange  (#ff9800)  (sample uses the same orange, lineWidth 2.5)
 *   200 -> pink    (#e91e63)
 */
const EMA_COLOR: Record<number, string> = {
  10: "#ff9800",
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

/** Format HH:mm for axis tick marks. Each call remembers the previously
 *  formatted tick's day-of-week so we can prefix "Mon ", "Tue ", ... on the
 *  first tick of a new calendar day (in the chosen timezone). This mirrors
 *  the day-label rendering used by TradingView's chart axis. */
function makeTickFormatter(tz: TzOffset): (t: Time) => string {
  let prevDay = -1;
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

interface Props {
  /** Timeframe string from Binance ("1m", "3m", "5m"). */
  interval: string;
  heikin?: boolean;
  emas?: number[];
  /** EMAs that should start in the OFF state (line hidden, chip darkened). */
  defaultEmaOff?: number[];
  /** Display timezone offset (hours). Shared global state from page. */
  tz?: TzOffset;
  /** Previous Day H/L/M — drawn as price lines on this chart. */
  pdhlm?: { high: number; low: number; mid: number } | null;
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
  pdhlm = null,
  registerTimeScale,
  siblingScales,
  registerPriceScale,
  siblingPriceScales,
  priceScaleLock,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  const rightScaleRef = useRef<IPriceScaleApi | null>(null);
  const cacheRef = useRef<Kline[]>([]);
  /** PDHLM price line handles - cleared/redrawn when pdhlm prop changes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdhlmLinesRef = useRef<any[]>([]);
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
  const [status, setStatus] = useState<"connecting" | "live" | "off">("connecting");
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

  /** (Re)compute every EMA line series from the current cached bars. */
  const recomputeEmas = (bars: Kline[]) => {
    cacheRef.current = bars.slice();
    const values = bars.map((b) => b.close);
    for (let i = 0; i < emas.length; i++) {
      const period = emas[i]!;
      const line = emaRefs.current[i];
      if (!line) continue;
      if (!emaEnabled.has(period)) {
        // Off: clear the line so nothing is drawn.
        line.setData([]);
        continue;
      }
      const smoothed = ema(values, period);
      const data = smoothed.map((v, j) => ({ time: bars[j]!.time as Time, value: v }));
      line.setData(data);
    }
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
      const idx = emas.indexOf(period);
      const line = idx >= 0 ? emaRefs.current[idx] : undefined;
      if (line) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        line.applyOptions({ visible: isNowOn } as any);
        if (!isNowOn) {
          line.setData([]);
        } else {
          // Re-feed data so it lights up immediately.
          const cached = cacheRef.current;
          if (cached.length > 0) {
            const values = cached.map((b) => b.close);
            const smoothed = ema(values, period);
            const data = smoothed.map((v, j) => ({ time: cached[j]!.time as Time, value: v }));
            line.setData(data);
          }
        }
      }
      return next;
    });
  };

  /** Reset BOTH axes — canonical "Reset price scale" / "Reset chart view". */
  const resetView = () => {
    const c = chartRef.current;
    if (!c) return;
    rightScaleRef.current?.setAutoScale(true);
    c.timeScale().fitContent();
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
        rightOffset: 12,
        barSpacing: 6,
        fixLeftEdge: true,
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
      // Show current price label on right axis + dotted price line.
      priceLineVisible: true,
      lastValueVisible: true,
    });
    candleRef.current = candle;

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
      tOriginating = true;
      try {
        const siblings = siblingScales?.current ?? [];
        const siblingPrices = siblingPriceScales?.current ?? [];
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const cached = cacheRef.current;
        if (cached.length > 0) {
          const totalBars = cached.length + 12;
          const distFromRight = totalBars - range.to;
          pinnedToRightRef.current = distFromRight < 3;
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
      const cached = cacheRef.current;
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

    // Watch for first real size arrival. autoSize:true keeps the chart in
    // step with container changes, but it doesn't auto-call fitContent() —
    // if we fit when the container was 0px wide (initial mount), the
    // logical range gets locked to one bar and every tick keeps it stuck.
    // Re-fit once we transition from 0 -> real width.
    const ro = new ResizeObserver(() => {
      if (!chartRef.current) return;
      const w = el?.clientWidth ?? 0;
      if (w > 0) {
        positionInitialView();
        ro.disconnect();
      }
    });

    // positionInitialView — called once the container has a real width.
    // Instead of fitContent() (which compresses 500 bars into a tiny cell),
    // we show the last INITIAL_BARS bars with a comfortable right gap.
    // This gives a clean first impression regardless of timeframe.
    const INITIAL_BARS = 150;
    const positionInitialView = () => {
      const c = chartRef.current;
      if (!c) return;
      const cached = cacheRef.current;
      // Use cached length if history has already arrived; otherwise let
      // fitContent handle it (history will reposition once it loads).
      if (cached.length === 0) {
        c.timeScale().fitContent();
        return;
      }
      const total = cached.length;
      c.timeScale().setVisibleLogicalRange({
        from: Math.max(0, total - INITIAL_BARS),
        to: total + 10, // 10-bar right gap so live candle has breathing room
      });
    };

    if (el) ro.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      el?.removeEventListener("contextmenu", onContext);
      registerTimeScale?.(null);
      registerPriceScale?.(null);
      chart.remove();
      chartRef.current = null;
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
    });
  }, [tz]);

  // Draw PDHLM price lines whenever the prop changes.
  // High + Low: thick solid white. Mid: dashed semi-transparent white.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    // Remove old lines.
    for (const pl of pdhlmLinesRef.current) {
      try { series.removePriceLine(pl); } catch (_) { /* already removed */ }
    }
    pdhlmLinesRef.current = [];
    if (!pdhlm) return;
    const { high, low, mid } = pdhlm;
    pdhlmLinesRef.current.push(
      series.createPriceLine({
        price: high,
        color: "#ffffff",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "PDH",
      })
    );
    pdhlmLinesRef.current.push(
      series.createPriceLine({
        price: mid,
        color: "rgba(255,255,255,0.55)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "PDM",
      })
    );
    pdhlmLinesRef.current.push(
      series.createPriceLine({
        price: low,
        color: "#ffffff",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "PDL",
      })
    );
  }, [pdhlm]);

  // --- socket: history + live updates --------------------------------------
  useEffect(() => {
    const sock: Socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });

    sock.on("connect", () => setStatus("live"));
    sock.on("disconnect", () => setStatus("off"));
    sock.on("connect_error", () => setStatus("off"));

    sock.on("history", (payload: Record<string, Kline[]>) => {
      const raw = payload[interval];
      if (!raw || !candleRef.current) return;
      const series = heikin ? toHeikin(raw) : raw;

      if (heikin && series.length > 0) {
        // Seed BOTH HA refs from the last bar in the history snapshot.
        // History bars from the REST endpoint are all closed, so the last
        // one is the correct settled anchor for the next live bar.
        const tail = series[series.length - 1]!;
        lastHaRef.current = { open: tail.open, close: tail.close };
        lastClosedHaRef.current = { open: tail.open, close: tail.close };
      } else {
        lastHaRef.current = null;
        lastClosedHaRef.current = null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      if (raw.length > 0) {
        const first = raw[0]!.open;
        const lastBar = series[series.length - 1]!;
        setLastPrice(lastBar.close);
        setChange(first === 0 ? 0 : ((lastBar.close - first) / first) * 100);
        // Cache the RAW bars so EMA and HA derivations stay consistent.
        recomputeEmas(raw);
      }
      // Position the view: show the last 150 bars with a right gap.
      // Works for every interval (1m, 3m, 5m…) regardless of bar count.
      if (chartRef.current) {
        const el = containerRef.current;
        const w = el?.clientWidth ?? 0;
        if (w > 0) {
          // Container already has real size — position immediately.
          const total = raw.length;
          chartRef.current.timeScale().setVisibleLogicalRange({
            from: Math.max(0, total - 150),
            to: total + 10,
          });
        }
        // If container is still 0-width the ResizeObserver will call
        // positionInitialView once it gets a real size.
      }
    });

    sock.on("kline", (msg: { interval: string; k: Kline }) => {
      if (msg.interval !== interval) return;
      if (!candleRef.current) return;
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
      // If timeSec < prevTime (out-of-order / duplicate), silently ignore.

      // ── Heikin Ashi computation ───────────────────────────────────────────
      // KEY FIX: always derive the live HA bar from `lastClosedHaRef`
      // (the settled anchor of the most recently *closed* bar).  We must NOT
      // use a ref that mutates on every intra-bar tick, because that would
      // make the next bar's haOpen = (mid-state-open + mid-state-close) / 2
      // instead of (prev-closed-haOpen + prev-closed-haClose) / 2.
      let candlePayload: Kline = bar;
      if (heikin) {
        const prev = lastClosedHaRef.current;
        const ha = toHeikinOne(
          bar,
          prev?.open ?? 0,
          prev?.close ?? 0,
          prev === null,
        );
        // Only advance the closed-anchor when this bar actually closes.
        // Intra-bar ticks leave `lastClosedHaRef` untouched.
        if (bar.closed) {
          lastClosedHaRef.current = { open: ha.open, close: ha.close };
          lastHaRef.current = { open: ha.open, close: ha.close };
        }
        candlePayload = ha;
      }

      // ── Series update ─────────────────────────────────────────────────────
      // series.update() with the same timestamp overwrites the bar in-place;
      // a greater timestamp appends a new bar to the right.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.update(candlePayload as any);

      setLastPrice(candlePayload.close);

      // ── EMA update ───────────────────────────────────────────────────────
      if (cached.length > 0 && emas.length > 0) {
        for (let i = 0; i < emas.length; i++) {
          const period = emas[i]!;
          const line = emaRefs.current[i];
          if (!line) continue;
          if (!emaEnabled.has(period)) continue;
          const values = cached.map((c) => c.close);
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
        <span className="venue">Binance · Futures</span>
        <span className="tf">
          {interval}
          {heikin ? " · Heikin Ashi" : ""}
        </span>
        <div className="ema-group">{emaLegend}</div>
      </div>

      {/* OHLC hover legend — TradingView style. Now shown on every cell. */}
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

      {/* Footer removed: no live label, no TZ dropdown per chart.
          TZ is controlled by the single global dropdown (bottom-right of screen). */}

      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

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
            Reset price scale
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