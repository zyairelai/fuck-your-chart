"use client";

import { useEffect, useRef, useState } from "react";
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
  9: "#ff9800",
  21: "#4caf50",
  50: "#ff9800",
  200: "#e91e63",
};
const EMA_LINE_WIDTH: Record<number, number> = {
  9: 1.5,
  21: 1.5,
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
  /** Timeframe string from Binance ("1m", "3m", "5m", "1h", ...). The big
   *  left chart receives whatever the user picks from the top bar; the 1m
   *  charts stay pinned to "1m". */
  interval: string;
  heikin?: boolean;
  emas?: number[];
  /** EMAs that should start in the OFF state (line hidden, chip darkened).
   *  Used on the 1m charts where 50/200 are noisy by default — the user can
   *  still click the chip to turn them on. */
  defaultEmaOff?: number[];
  /** Display timezone offset (hours). Controlled by the top-bar picker; same
   *  value applied to every chart. */
  tz?: TzOffset;
  /** Register this chart's time scale so siblings can mirror zoom/pan. */
  registerTimeScale?: (api: ITimeScaleApi<Time> | null) => void;
  siblingScales?: React.MutableRefObject<ITimeScaleApi<Time>[]>;
  /** Register this chart's right price scale so siblings mirror vertical range. */
  registerPriceScale?: (api: IPriceScaleApi | null) => void;
  siblingPriceScales?: React.MutableRefObject<IPriceScaleApi[]>;
}

export default function Chart({
  interval,
  heikin = false,
  emas = [],
  defaultEmaOff = [],
  tz = 0,
  registerTimeScale,
  siblingScales,
  registerPriceScale,
  siblingPriceScales,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  const rightScaleRef = useRef<IPriceScaleApi | null>(null);
  const cacheRef = useRef<Kline[]>([]);
  /** Last Heikin Ashi open/close — needed to compute the next HA bar from
   *  one raw bar without re-running toHeikin() over the whole history. */
  const lastHaRef = useRef<{ open: number; close: number } | null>(null);
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
      priceLineVisible: false,
      lastValueVisible: false,
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
        chartRef.current.timeScale().fitContent();
        ro.disconnect();
      }
    });
    if (el) ro.observe(el);

    return () => {
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
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      timeScale: { tickMarkFormatter: makeTickFormatter(tz) },
    });
    chartRef.current.timeScale().resetTimeScale();
  }, [tz]);

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
      // Seed the per-tick HA scratchpad from the last HA bar we just rendered.
      if (heikin && series.length > 0) {
        const tail = series[series.length - 1]!;
        lastHaRef.current = { open: tail.open, close: tail.close };
      } else {
        lastHaRef.current = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.setData(series as any);
      if (raw.length > 0) {
        const first = raw[0]!.open;
        const lastBar = series[series.length - 1]!;
        setLastPrice(lastBar.close);
        setChange(first === 0 ? 0 : ((lastBar.close - first) / first) * 100);
        // Cache the RAW bars — Heikin Ashi is always derived from these so
        // EMA close values and HA prev-rolling-state stay consistent as WS
        // ticks arrive. We never mix HA bars into the cache.
        recomputeEmas(raw);
      }
      chartRef.current?.timeScale().fitContent();
    });

    sock.on("kline", (msg: { interval: string; k: Kline }) => {
      if (msg.interval !== interval) return;
      if (!candleRef.current) return;
      const k = msg.k;

      // Detect whether this tick opens a NEW bar (time > last cached time)
      // vs. just updating the current (still-open) bar. Binance pushes a
      // kline update roughly every second; only when a bar actually closes
      // and a new one opens do we want to advance the viewport by one bar.
      const cached = cacheRef.current;
      const prevTime = cached.length > 0 ? cached[cached.length - 1]!.time : 0;
      const isNewBar = k.time > prevTime;

      // Keep the RAW cache in sync first — the Heikin Ashi view (if enabled)
      // is always derived from the full history so its prevHAOpen / prevHAClose
      // stays coherent across bar rollovers.
      if (cached.length > 0) {
        if (isNewBar) {
          cached.push(k);
        } else {
          cached[cached.length - 1] = k;
        }
      }

      // Compute the bar we want to push to the candle series. For raw charts
      // that's just `k`; for Heikin Ashi charts we have to recompute the LAST
      // bar from the previous HA values plus the new raw bar — otherwise the
      // candle body and wick drift off the rest of the series.
      let candlePayload: Kline = k;
      if (heikin) {
        const prev = lastHaRef.current;
        const ha = toHeikinOne(
          k,
          prev?.open ?? 0,
          prev?.close ?? 0,
          prev === null,
        );
        lastHaRef.current = { open: ha.open, close: ha.close };
        candlePayload = ha;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleRef.current.update(candlePayload as any);

      setLastPrice(candlePayload.close);

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
            line.update({ time: k.time as Time, value: tail });
          }
        }
      }

      // Only advance the viewport when a NEW bar has actually opened — not
      // on every intra-second tick of the still-open bar. This is what was
      // making the chart visibly jump forward every second.
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
  const sign = change == null ? "" : change >= 0 ? "+" : "";

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

      {/* Footer — live indicator. */}
      <div className="cell-footer">
        <span className={status === "live" ? "ok" : "muted"}>
          {status === "live" ? "● live" : status === "connecting" ? "connecting…" : "● disconnected"}
        </span>
      </div>

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