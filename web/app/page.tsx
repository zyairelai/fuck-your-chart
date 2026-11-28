"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ITimeScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset, Zones, LineToggles, CustomLevel, CustomLevelColor, LinkedCrosshairId, LinkedCrosshairSync, HtfEmaKey } from "../components/Chart";
import { fetchZones } from "../lib/zones";
import { playCandleCloseAlert, playTestChirp, getAudioContext, preloadWestminsterChime } from "../lib/audioAlert";
import { emptyAlertState, loadAlertState, saveAlertState, speakAlertText } from "../lib/alertStore";
import type { EmaAlert, PriceAlert, AlertState } from "../lib/alertStore";

const ALL_EMAS = [10, 20, 50, 200];
const STORAGE_KEY_CUSTOM_LEVELS = "fuck-your-chart:custom-levels:v1";
const STORAGE_KEY_HTF_EMA = "fuck-your-chart:htf-ema:v1";

function getLocalHtfEma(): Record<HtfEmaKey, boolean> {
  if (typeof window === "undefined") {
    return { "15m200": false, "1h200": false, "4h200": false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_HTF_EMA);
    if (!raw) return { "15m200": false, "1h200": false, "4h200": false };
    const parsed = JSON.parse(raw);
    return {
      "15m200": Boolean(parsed["15m200"]),
      "1h200": Boolean(parsed["1h200"]),
      "4h200": Boolean(parsed["4h200"]),
    };
  } catch {
    return { "15m200": false, "1h200": false, "4h200": false };
  }
}

function setLocalHtfEma(state: Record<HtfEmaKey, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_HTF_EMA, JSON.stringify(state));
  } catch {}
}

function getLocalCustomLevels(): CustomLevel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_CUSTOM_LEVELS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setLocalCustomLevels(levels: CustomLevel[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_CUSTOM_LEVELS, JSON.stringify(levels));
  } catch {}
}

function areLevelsEqual(a: CustomLevel[], b: CustomLevel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].price !== b[i].price || a[i].color !== b[i].color) {
      return false;
    }
  }
  return true;
}

const DEFAULT_TOGGLES: LineToggles = {
  weekly: true,
  monday: false,
  pdhlm: true,
  fibb: false,
  weekend: false,
};

const STORAGE_KEY_TOGGLES = "fuck-your-chart:line-toggles:v1";

function getLocalToggles(): LineToggles | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_TOGGLES);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LineToggles;
    if (
      typeof parsed.weekly === "boolean" &&
      typeof parsed.monday === "boolean" &&
      typeof parsed.pdhlm === "boolean" &&
      typeof parsed.fibb === "boolean" &&
      typeof parsed.weekend === "boolean"
    ) return parsed;
  } catch {}
  return null;
}

function setLocalToggles(t: LineToggles) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_TOGGLES, JSON.stringify(t));
  } catch {}
}

function areTogglesEqual(a: LineToggles, b: LineToggles): boolean {
  return (
    a.weekly === b.weekly &&
    a.monday === b.monday &&
    a.pdhlm === b.pdhlm &&
    a.fibb === b.fibb &&
    a.weekend === b.weekend
  );
}

function drawDomTreeToCanvas(
  element: HTMLElement,
  ctx: CanvasRenderingContext2D,
  originRect: DOMRect
) {
  if (
    element.classList.contains("context-menu") ||
    element.classList.contains("copy-toast") ||
    element.classList.contains("screenshot-toast") ||
    element.classList.contains("chart-maximize-btn")
  ) {
    return;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return;
  }

  const rect = element.getBoundingClientRect();
  const x = rect.left - originRect.left;
  const y = rect.top - originRect.top;
  const w = rect.width;
  const h = rect.height;

  if (w <= 0 || h <= 0) return;

  const bg = style.backgroundColor;
  const hasBg = bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";

  const borderWidth = parseFloat(style.borderWidth) || 0;
  const borderColor = style.borderColor;
  const hasBorder =
    borderWidth > 0 &&
    borderColor &&
    borderColor !== "transparent" &&
    borderColor !== "rgba(0, 0, 0, 0)";

  const borderRadius = parseFloat(style.borderRadius) || 0;

  if (hasBg || hasBorder) {
    ctx.save();
    ctx.beginPath();
    if (borderRadius > 0 && typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, borderRadius);
    } else {
      ctx.rect(x, y, w, h);
    }
    if (hasBg) {
      ctx.fillStyle = bg;
      ctx.fill();
    }
    if (hasBorder) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  if (element.tagName === "SELECT") {
    const sel = element as HTMLSelectElement;
    const text = sel.options[sel.selectedIndex]?.text || sel.value;
    if (text) {
      ctx.save();
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.fillStyle = style.color;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(text, x + w / 2, y + h / 2);
      ctx.restore();
    }
    return;
  }

  for (let i = 0; i < element.childNodes.length; i++) {
    const node = element.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent;
      if (!rawText || !rawText.trim()) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const textRect = range.getBoundingClientRect();
      if (textRect.width === 0 || textRect.height === 0) continue;

      const tx = textRect.left - originRect.left;
      const ty = textRect.top - originRect.top + textRect.height / 2;

      ctx.save();
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.fillStyle = style.color;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(rawText.trim(), tx, ty);
      ctx.restore();
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      drawDomTreeToCanvas(node as HTMLElement, ctx, originRect);
    }
  }
}

function intervalToLabel(interval: string): string {
  const m = /^(\d+)([mhd])$/i.exec(interval);
  if (!m) return interval;
  const n = m[1]!;
  const u = m[2]!.toLowerCase();
  if (u === "m") return `${n} minute`;
  if (u === "h") return `${n} hour`;
  return `${n} day`;
}

export default function Page() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTimeframe, setSelectedTimeframe] = useState<string | null>(null);
  const [maximizedChart, setMaximizedChart] = useState<"main" | "ha-top" | "ha-bottom" | null>(null);
  const [singleTimeframe, setSingleTimeframe] = useState<string | null>(null);
  const maximizedChartRef = useRef(maximizedChart);
  maximizedChartRef.current = maximizedChart;

  // 2-layout mode by default: 15m HA covers the 3m slot; double-click on ha-top pops out 3m (3-layout)
  const [haTopExpanded, setHaTopExpanded] = useState(true);

  const rawScreenshotRef = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const haTopScreenshotRef = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const haBottomScreenshotRef = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const [screenshotToast, setScreenshotToast] = useState<string | null>(null);

  const linkedTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const linkedCrosshairSync = useRef<Record<LinkedCrosshairId, LinkedCrosshairSync | null>>({
    raw: null,
    heikin: null,
    "heikin-bottom": null,
  });

  /** Imperative handles so each chart can trigger resetView() on its sibling. */
  const rawResetViewRef = useRef<(() => void) | null>(null);
  const haTopResetViewRef = useRef<(() => void) | null>(null);

  const registerLinkedTime = (api: ITimeScaleApi<Time> | null) => {
    if (api && !linkedTimeScales.current.includes(api)) {
      linkedTimeScales.current.push(api);
    }
  };
  const registerLinkedCrosshair = (
    id: LinkedCrosshairId,
    sync: LinkedCrosshairSync | null,
  ) => {
    linkedCrosshairSync.current[id] = sync;
  };
  const syncLinkedCrosshair = (source: LinkedCrosshairId, time: number | null) => {
    // Broadcast to every chart except the source
    for (const [id, fn] of Object.entries(linkedCrosshairSync.current) as [LinkedCrosshairId, LinkedCrosshairSync | null][]) {
      if (id !== source) fn?.(time);
    }
  };

  const handleTimeframeChange = (tf: string | null) => {
    linkedTimeScales.current = [];
    linkedCrosshairSync.current = { raw: null, heikin: null, "heikin-bottom": null };
    // Reset HTF EMA chips to off whenever the timeframe changes.
    const allOff: Record<HtfEmaKey, boolean> = { "15m200": false, "1h200": false, "4h200": false };
    setHtfEnabled(allOff);
    setLocalHtfEma(allOff);
    if (maximizedChart !== null) {
      setSingleTimeframe(tf);
    } else {
      setSelectedTimeframe(tf);
    }
  };

  // When toggling 1 layout mode, dispatch window resize so charts recalculate full dimensions
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 40);
    return () => clearTimeout(timer);
  }, [maximizedChart]);

  // Also resize when 2-layout (ha-top expanded) changes
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 40);
    return () => clearTimeout(timer);
  }, [haTopExpanded]);

  // handleToggleMaximize kept for compatibility (no longer called from buttons, but harmless)
  const handleToggleMaximize = (chartId: "main" | "ha-top" | "ha-bottom") => {
    if (maximizedChart === chartId) {
      setMaximizedChart(null);
      setSingleTimeframe(null);
    } else {
      setMaximizedChart(chartId);
      const currentInterval =
        chartId === "main"
          ? (selectedTimeframe ?? "5m")
          : chartId === "ha-top"
          ? (selectedTimeframe ?? "15m")
          : "3m";
      setSingleTimeframe(currentInterval);
    }
  };

  const handleChartDoubleClick = (chartId: "main" | "ha-top" | "ha-bottom") => {
    if (chartId === "main") {
      // 5m: toggle side-by-side layout
      toggleLayout();
      return;
    }
    if (chartId === "ha-bottom") {
      // 3m: expand 15m HA to cover 3m slot (collapse back to 2-layout)
      setHaTopExpanded(true);
      return;
    }
    // ha-top: toggle 2-layout (expand/collapse 3m slot)
    setHaTopExpanded((prev) => !prev);
  };
  const [tz, setTz] = useState<TzOffset>(8);
  const [switchedLayout, setSwitchedLayout] = useState(true);
  const [levelsEnabledMain, setLevelsEnabledMain] = useState(true);
  const [levelsEnabledHaTop, setLevelsEnabledHaTop] = useState(true);
  const [levelsEnabledHaBottom, setLevelsEnabledHaBottom] = useState(true);
  const [htfEnabled, setHtfEnabled] = useState<Record<HtfEmaKey, boolean>>({
    "15m200": false,
    "1h200": false,
    "4h200": false,
  });

  useEffect(() => {
    setHtfEnabled(getLocalHtfEma());
  }, []);

  const handleHtfEnabledChange = useCallback((next: Record<HtfEmaKey, boolean>) => {
    setHtfEnabled(next);
    setLocalHtfEma(next);
  }, []);

  // ── Alert state ────────────────────────────────────────────────────────────
  const [alertState, setAlertState] = useState<AlertState>(emptyAlertState);
  useEffect(() => { setAlertState(loadAlertState()); }, []);

  const handleSetEmaAlert = useCallback((chartId: "main" | "ha-top" | "ha-bottom", interval: string, period: number) => {
    const id = `${chartId}-ema-${period}`;
    const speechText = `${intervalToLabel(interval)} touching ${period} E. M. A.`;
    const alert: EmaAlert = { id, kind: "ema", chartId, period, speechText };
    setAlertState((prev) => {
      const emas = prev.emas.filter((a) => a.id !== id);
      const next = { ...prev, emas: [...emas, alert] };
      saveAlertState(next);
      return next;
    });
  }, []);

  const handleCancelEmaAlert = useCallback((chartId: "main" | "ha-top" | "ha-bottom", period: number) => {
    const id = `${chartId}-ema-${period}`;
    setAlertState((prev) => {
      const next = { ...prev, emas: prev.emas.filter((a) => a.id !== id) };
      saveAlertState(next);
      return next;
    });
  }, []);

  const handleSetPriceAlert = useCallback((price: number, label: string) => {
    const id = `price-${Math.round(price)}`;
    const speechText = `Price touching ${label}`;
    const alert: PriceAlert = { id, kind: "price", price, speechText };
    setAlertState((prev) => {
      const prices = prev.prices.filter((a) => Math.round(a.price) !== Math.round(price));
      const next = { ...prev, prices: [...prices, alert] };
      saveAlertState(next);
      return next;
    });
  }, []);

  const handleCancelPriceAlert = useCallback((price: number) => {
    setAlertState((prev) => {
      const next = { ...prev, prices: prev.prices.filter((a) => Math.round(a.price) !== Math.round(price)) };
      saveAlertState(next);
      return next;
    });
  }, []);

  const handleAlertTriggered = useCallback((id: string, speechText: string) => {
    speakAlertText(speechText);
    setAlertState((prev) => {
      const next = {
        emas: prev.emas.filter((a) => a.id !== id),
        prices: prev.prices.filter((a) => a.id !== id),
      };
      saveAlertState(next);
      return next;
    });
  }, []);
  const [zones, setZones] = useState<Zones | null>(null);
  const [toggles, setToggles] = useState<LineToggles>(DEFAULT_TOGGLES);
  const [customLevels, setCustomLevels] = useState<CustomLevel[]>([]);
  const [customLevelsReady, setCustomLevelsReady] = useState(false);
  const [customLevelsError, setCustomLevelsError] = useState<string | null>(null);

  // 5-minute candle close alert (independent of active timeframe)
  const [beep5mEnabled, setBeep5mEnabled] = useState(false);

  const toggleBeep5m = useCallback(() => {
    setBeep5mEnabled((prev) => {
      const next = !prev;
      if (next) {
        getAudioContext();
        playTestChirp();
        // Pre-decode the Westminster MP3 into the AudioContext buffer while user interaction
        // is still fresh — avoids any autoplay block when the chime fires later.
        preloadWestminsterChime();
      }
      return next;
    });
  }, []);

  // Exact wall-clock timer for 5m candle close alert (:00, :05, :10, etc.)
  useEffect(() => {
    if (!beep5mEnabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastBeepedBar = -1;
    const stepMs = 300000; // strictly 5 minutes

    const scheduleNextBeep = () => {
      if (cancelled) return;
      const now = Date.now();
      const msIntoCurrentBar = now % stepMs;
      const msUntilClose = stepMs - msIntoCurrentBar;

      timer = setTimeout(() => {
        if (cancelled) return;
        const currentNow = Date.now();
        const barTimestamp = Math.floor(currentNow / stepMs) * stepMs;
        if (lastBeepedBar !== barTimestamp) {
          lastBeepedBar = barTimestamp;
          playCandleCloseAlert(barTimestamp);
        }
        scheduleNextBeep();
      }, msUntilClose);
    };

    scheduleNextBeep();

    // High-frequency backup interval (100ms) to guarantee exact :00 turn
    const backupInterval = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      const msIntoCurrentBar = now % stepMs;
      if (msIntoCurrentBar >= 0 && msIntoCurrentBar < 600) {
        const barTimestamp = Math.floor(now / stepMs) * stepMs;
        if (lastBeepedBar !== barTimestamp) {
          lastBeepedBar = barTimestamp;
          playCandleCloseAlert(barTimestamp);
        }
      }
    }, 100);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      clearInterval(backupInterval);
    };
  }, [beep5mEnabled]);

  const toggleLayout = useCallback(() => {
    setSwitchedLayout((prev) => !prev);
  }, []);

  const customLevelsRequest = useCallback(async (method: "GET" | "POST" | "DELETE", body?: CustomLevel) => {
    try {
      const res = await fetch("/api/custom-levels", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        const result = (await res.json()) as { customLevels: CustomLevel[] };
        setCustomLevels((prev) => {
          if (areLevelsEqual(prev, result.customLevels)) return prev;
          setLocalCustomLevels(result.customLevels);
          return result.customLevels;
        });
        setCustomLevelsError(null);
        return;
      }
    } catch {
      // Fallback to localStorage (e.g. static hosting on GitHub Pages)
    }

    let current = getLocalCustomLevels();
    if (method === "POST" && body) {
      const roundedPrice = Math.round(body.price * 2) / 2;
      current = [...current, { price: roundedPrice, color: body.color }];
    } else if (method === "DELETE") {
      current = [];
    }
    setLocalCustomLevels(current);
    setCustomLevels((prev) => (areLevelsEqual(prev, current) ? prev : current));
    setCustomLevelsError(null);
  }, []);

  const onEditCustomLevel = useCallback(async (oldPrice: number, newPrice: number) => {
    const roundedOld = Math.round(oldPrice * 2) / 2;
    const roundedNew = Math.round(newPrice * 2) / 2;
    let targetColor: CustomLevelColor = "yellow";

    // 1. Optimistically update local state immediately so line moves instantly
    setCustomLevels((prev) => {
      const match = prev.find((l) => Math.abs(Math.round(l.price * 2) / 2 - roundedOld) < 0.01);
      if (match) targetColor = match.color;
      const next = prev.map((l) =>
        Math.abs(Math.round(l.price * 2) / 2 - roundedOld) < 0.01
          ? { ...l, price: roundedNew }
          : l
      );
      setLocalCustomLevels(next);
      return next;
    });

    // 2. Persist to server (try PUT, fallback to DELETE + POST for backward compatibility)
    try {
      const res = await fetch("/api/custom-levels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPrice, newPrice }),
      });
      if (res.ok) {
        const result = (await res.json()) as { customLevels: CustomLevel[] };
        setCustomLevels((prev) => {
          if (areLevelsEqual(prev, result.customLevels)) return prev;
          setLocalCustomLevels(result.customLevels);
          return result.customLevels;
        });
        setCustomLevelsError(null);
        return;
      }

      // If PUT is not supported (e.g. 404 or 405 on existing server container), do DELETE + POST
      await fetch(`/api/custom-levels?price=${encodeURIComponent(oldPrice)}`, { method: "DELETE" });
      const postRes = await fetch("/api/custom-levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price: newPrice, color: targetColor }),
      });
      if (postRes.ok) {
        const result = (await postRes.json()) as { customLevels: CustomLevel[] };
        setCustomLevels((prev) => {
          if (areLevelsEqual(prev, result.customLevels)) return prev;
          setLocalCustomLevels(result.customLevels);
          return result.customLevels;
        });
        setCustomLevelsError(null);
        return;
      }
    } catch {
      // Offline / standalone fallback
    }
  }, []);

  const onDeleteCustomLevel = useCallback(async (price: number) => {
    try {
      const res = await fetch(`/api/custom-levels?price=${encodeURIComponent(price)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const result = (await res.json()) as { customLevels: CustomLevel[] };
        setCustomLevels((prev) => {
          if (areLevelsEqual(prev, result.customLevels)) return prev;
          setLocalCustomLevels(result.customLevels);
          return result.customLevels;
        });
        setCustomLevelsError(null);
        return;
      }
    } catch {
      // Fallback to localStorage
    }

    const roundedTarget = Math.round(price * 2) / 2;
    const current = getLocalCustomLevels().filter(
      (l) => Math.abs(Math.round(l.price * 2) / 2 - roundedTarget) >= 0.01,
    );
    setLocalCustomLevels(current);
    setCustomLevels((prev) => (areLevelsEqual(prev, current) ? prev : current));
    setCustomLevelsError(null);
  }, []);

  useEffect(() => {
    // Initial fetch on mount
    void customLevelsRequest("GET")
      .catch((err: unknown) => {
        setCustomLevelsError(err instanceof Error ? err.message : "Could not load custom levels");
      })
      .finally(() => setCustomLevelsReady(true));

    // Auto-sync custom levels across browsers/tabs every 2s without manual refresh
    const pollInterval = setInterval(() => {
      void customLevelsRequest("GET");
    }, 2000);

    // Immediate sync when tab/window regains focus (e.g. switching from Firefox to Chrome)
    const onFocus = () => {
      void customLevelsRequest("GET");
    };
    window.addEventListener("focus", onFocus);

    // Cross-tab sync within the same browser
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_CUSTOM_LEVELS && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          if (Array.isArray(parsed)) {
            setCustomLevels((prev) => (areLevelsEqual(prev, parsed) ? prev : parsed));
          }
        } catch {}
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      clearInterval(pollInterval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [customLevelsRequest]);

  const onDateChange = useCallback(async (date: string) => {
    setSelectedDate(date);
    const data = await fetchZones(date, symbol);
    setZones(data);
  }, [symbol]);

  // Fetch line-toggle settings from backend (or fall back to localStorage)
  const fetchToggles = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = (await res.json()) as { lineToggles: LineToggles };
        const remote = data.lineToggles;
        setToggles((prev) => (areTogglesEqual(prev, remote) ? prev : remote));
        setLocalToggles(remote);
      }
    } catch {
      // Backend unavailable (GitHub Pages etc.) — keep local state
    }
  }, []);

  // Initial load of toggles + background poll for cross-browser sync
  useEffect(() => {
    // Seed from localStorage immediately so there's no flicker before the network round-trip
    const saved = getLocalToggles();
    if (saved) setToggles(saved);

    void fetchToggles();

    const pollInterval = setInterval(() => {
      void fetchToggles();
    }, 2000);

    const onFocus = () => { void fetchToggles(); };
    window.addEventListener("focus", onFocus);

    // Cross-tab sync within the same browser
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_TOGGLES && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as LineToggles;
          if (typeof parsed.weekly === "boolean") {
            setToggles((prev) => (areTogglesEqual(prev, parsed) ? prev : parsed));
          }
        } catch {}
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      clearInterval(pollInterval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [fetchToggles]);

  const onToggle = useCallback((key: keyof LineToggles) => {
    setToggles((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setLocalToggles(next);
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
      return next;
    });
  }, []);

  const rawInterval =
    maximizedChart === "main"
      ? (singleTimeframe ?? (selectedTimeframe ?? "5m"))
      : (selectedTimeframe ?? "5m");
  const topHaInterval =
    maximizedChart === "ha-top"
      ? (singleTimeframe ?? (selectedTimeframe ?? "15m"))
      : (selectedTimeframe ?? "15m");
  const haBottomInterval =
    maximizedChart === "ha-bottom"
      ? (singleTimeframe ?? "3m")
      : "3m";

  const isSynchronized = selectedTimeframe !== null && maximizedChart === null;

  const activeTimeframeInTopBar =
    maximizedChart !== null
      ? (singleTimeframe ?? (maximizedChart === "main" ? rawInterval : maximizedChart === "ha-top" ? topHaInterval : haBottomInterval))
      : selectedTimeframe;

  const handleTakeScreenshot = useCallback(async () => {
    const mainEl = document.querySelector<HTMLElement>("main.page");
    if (!mainEl) return;

    try {
      const mainRect = mainEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const masterCanvas = document.createElement("canvas");
      masterCanvas.width = Math.round(mainRect.width * dpr);
      masterCanvas.height = Math.round(mainRect.height * dpr);

      const ctx = masterCanvas.getContext("2d");
      if (!ctx) return;

      // Scale context to DPR so all drawing uses standard CSS pixels
      ctx.scale(dpr, dpr);

      // Background matching page
      ctx.fillStyle = "#131722";
      ctx.fillRect(0, 0, mainRect.width, mainRect.height);

      // Cells and their getters
      const cellConfigs = [
        { selector: ".chart-main", getter: rawScreenshotRef.current },
        { selector: ".chart-ha-top", getter: haTopScreenshotRef.current },
        { selector: ".chart-ha-bottom", getter: haBottomScreenshotRef.current },
      ];

      for (const { selector, getter } of cellConfigs) {
        const cell = mainEl.querySelector<HTMLElement>(selector);
        if (!cell) continue;

        const cellRect = cell.getBoundingClientRect();
        if (cellRect.width <= 0 || cellRect.height <= 0) continue;
        const cellX = cellRect.left - mainRect.left;
        const cellY = cellRect.top - mainRect.top;
        const cellW = cellRect.width;
        const cellH = cellRect.height;

        // Draw cell container (background, border, rounded corner clipping)
        ctx.save();
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(cellX, cellY, cellW, cellH, 4);
        } else {
          ctx.rect(cellX, cellY, cellW, cellH);
        }
        ctx.fillStyle = "#141823";
        ctx.fill();
        ctx.strokeStyle = "#202636";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.clip();

        // 1. Draw chart canvas
        let drawn = false;
        if (getter) {
          try {
            const chartCanvas = getter();
            if (chartCanvas && chartCanvas.width > 0 && chartCanvas.height > 0) {
              ctx.drawImage(chartCanvas, cellX, cellY, cellW, cellH);
              drawn = true;
            }
          } catch (e) {
            console.error("Screenshot capture error", e);
          }
        }

        // Fallback: draw all canvas elements in cell
        if (!drawn) {
          const canvases = cell.querySelectorAll<HTMLCanvasElement>("canvas");
          canvases.forEach((c) => {
            const cr = c.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              ctx.drawImage(c, cr.left - mainRect.left, cr.top - mainRect.top, cr.width, cr.height);
            }
          });
        }

        // 2. Draw cell header DOM overlay
        const cellHeader = cell.querySelector<HTMLElement>(".cell-header");
        if (cellHeader) {
          drawDomTreeToCanvas(cellHeader, ctx, mainRect);
        }

        ctx.restore();
      }

      // Draw global TZ dropdown badge
      const tzWrapper = document.querySelector<HTMLElement>(".global-tz-wrapper");
      if (tzWrapper) {
        drawDomTreeToCanvas(tzWrapper, ctx, mainRect);
      }

      // Export PNG and trigger immediate download
      masterCanvas.toBlob((blob) => {
        if (!blob) return;

        // Copy to clipboard if supported
        if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
          try {
            void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          } catch {}
        }

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const filename = `BTCUSDT_${dateStr}.png`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 200);

        setScreenshotToast(`Snapshot saved: ${filename}`);
        setTimeout(() => setScreenshotToast(null), 2500);
      }, "image/png");
    } catch (err) {
      console.error("handleTakeScreenshot failed", err);
    }
  }, []);

  return (
    <>
      <TopBar
        symbol={symbol}
        onDateChange={onDateChange}
        toggles={toggles}
        onToggle={onToggle}
        selectedTimeframe={activeTimeframeInTopBar}
        onTimeframeChange={handleTimeframeChange}
        customLevelsReady={customLevelsReady}
        customLevelsError={customLevelsError}
        onAddCustom={(price, color) => customLevelsRequest("POST", { price, color })}
        onClearCustom={() => customLevelsRequest("DELETE")}
        beep5mEnabled={beep5mEnabled}
        onToggleBeep5m={toggleBeep5m}
        onTakeScreenshot={handleTakeScreenshot}
      />
      <main className={`page${switchedLayout ? " switched" : ""}${maximizedChart ? ` maximized-${maximizedChart}` : ""}${haTopExpanded ? " ha-top-expanded" : ""}`}>
        <div className="cell chart-main">
          <Chart
            key={`raw-${symbol}-${rawInterval}-${isSynchronized}`}
            symbol={symbol}
            interval={rawInterval}
            emas={ALL_EMAS}
            allowFootprint={true}
            defaultFootprintEnabled={true}
            allowHtfEma={true}
            htfEnabled={htfEnabled}
            onHtfEnabledChange={handleHtfEnabledChange}
            levelsEnabled={levelsEnabledMain}
            onLevelsEnabledChange={setLevelsEnabledMain}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onEditCustomLevel={onEditCustomLevel}
            onChartDoubleClick={() => handleChartDoubleClick("main")}
            isMaximized={maximizedChart === "main"}
            onToggleMaximize={() => handleToggleMaximize("main")}
            onRegisterScreenshot={(fn) => { rawScreenshotRef.current = fn; }}
            registerTimeScale={isSynchronized ? registerLinkedTime : undefined}
            siblingScales={isSynchronized ? linkedTimeScales : undefined}
            linkedCrosshairId="raw"
            registerLinkedCrosshair={registerLinkedCrosshair}
            onLinkedCrosshair={syncLinkedCrosshair}
            registerResetView={(fn) => { rawResetViewRef.current = fn; }}
            onResetView={isSynchronized ? () => { haTopResetViewRef.current?.(); } : undefined}
            emaAlerts={selectedTimeframe === null ? alertState.emas.filter((a) => a.chartId === "main") : undefined}
            priceAlerts={selectedTimeframe === null ? alertState.prices : undefined}
            allowPriceAlerts={selectedTimeframe === null}
            onSetEmaAlert={selectedTimeframe === null ? (period) => handleSetEmaAlert("main", rawInterval, period) : undefined}
            onCancelEmaAlert={selectedTimeframe === null ? (period) => handleCancelEmaAlert("main", period) : undefined}
            onSetPriceAlert={selectedTimeframe === null ? handleSetPriceAlert : undefined}
            onCancelPriceAlert={selectedTimeframe === null ? handleCancelPriceAlert : undefined}
            onAlertTriggered={selectedTimeframe === null ? handleAlertTriggered : undefined}
          />
        </div>
        <div className="cell chart-ha-top">
          <Chart
            key={`ha-top-${symbol}-${topHaInterval}-${isSynchronized}`}
            symbol={symbol}
            interval={topHaInterval}
            heikin
            emas={ALL_EMAS}
            allowFootprint={false}
            defaultFootprintEnabled={false}
            levelsEnabled={levelsEnabledHaTop}
            onLevelsEnabledChange={setLevelsEnabledHaTop}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onEditCustomLevel={onEditCustomLevel}
            onChartDoubleClick={() => handleChartDoubleClick("ha-top")}
            isMaximized={maximizedChart === "ha-top"}
            onToggleMaximize={() => handleToggleMaximize("ha-top")}
            onRegisterScreenshot={(fn) => { haTopScreenshotRef.current = fn; }}
            registerTimeScale={isSynchronized ? registerLinkedTime : undefined}
            siblingScales={isSynchronized ? linkedTimeScales : undefined}
            linkedCrosshairId="heikin"
            registerLinkedCrosshair={registerLinkedCrosshair}
            onLinkedCrosshair={syncLinkedCrosshair}
            registerResetView={(fn) => { haTopResetViewRef.current = fn; }}
            onResetView={isSynchronized ? () => { rawResetViewRef.current?.(); } : undefined}
            emaAlerts={selectedTimeframe === null ? alertState.emas.filter((a) => a.chartId === "ha-top") : undefined}
            onSetEmaAlert={selectedTimeframe === null ? (period) => handleSetEmaAlert("ha-top", topHaInterval, period) : undefined}
            onCancelEmaAlert={selectedTimeframe === null ? (period) => handleCancelEmaAlert("ha-top", period) : undefined}
            onAlertTriggered={selectedTimeframe === null ? handleAlertTriggered : undefined}
          />
        </div>
        <div className="cell chart-ha-bottom">
          <Chart
            key={`ha-bottom-${symbol}-${haBottomInterval}`}
            symbol={symbol}
            interval={haBottomInterval}
            heikin
            emas={ALL_EMAS}
            allowFootprint={false}
            defaultFootprintEnabled={false}
            levelsEnabled={levelsEnabledHaBottom}
            onLevelsEnabledChange={setLevelsEnabledHaBottom}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onEditCustomLevel={onEditCustomLevel}
            onChartDoubleClick={() => handleChartDoubleClick("ha-bottom")}
            isMaximized={maximizedChart === "ha-bottom"}
            onToggleMaximize={() => handleToggleMaximize("ha-bottom")}
            onRegisterScreenshot={(fn) => { haBottomScreenshotRef.current = fn; }}
            linkedCrosshairId="heikin-bottom"
            registerLinkedCrosshair={registerLinkedCrosshair}
            onLinkedCrosshair={syncLinkedCrosshair}
            emaAlerts={selectedTimeframe === null ? alertState.emas.filter((a) => a.chartId === "ha-bottom") : undefined}
            onSetEmaAlert={selectedTimeframe === null ? (period) => handleSetEmaAlert("ha-bottom", haBottomInterval, period) : undefined}
            onCancelEmaAlert={selectedTimeframe === null ? (period) => handleCancelEmaAlert("ha-bottom", period) : undefined}
            onAlertTriggered={selectedTimeframe === null ? handleAlertTriggered : undefined}
          />
        </div>
      </main>

      {/* Global TZ dropdown in bottom-right corner (under price scale) */}
      <div className="global-tz-wrapper">
        <select
          className="global-tz-select"
          value={tz}
          onChange={(e) => setTz(Number(e.target.value) as TzOffset)}
          title="Display timezone (all charts)"
        >
          <option value={0}>UTC</option>
          <option value={4}>UTC+4</option>
          <option value={8}>UTC+8</option>
        </select>
      </div>

      {screenshotToast && (
        <div className="screenshot-toast" role="status">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>{screenshotToast}</span>
        </div>
      )}
    </>
  );
}
