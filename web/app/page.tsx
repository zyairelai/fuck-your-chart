"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ITimeScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset, Zones, LineToggles, CustomLevel, LinkedCrosshairId, LinkedCrosshairSync } from "../components/Chart";
import { fetchZones } from "../lib/zones";
import { play5mCloseAlert, playTestChirp, getAudioContext } from "../lib/audioAlert";

const ALL_EMAS = [10, 20, 50, 200];
const STORAGE_KEY_CUSTOM_LEVELS = "fuck-your-chart:custom-levels:v1";

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

export interface AppSettings {
  lineToggles: LineToggles;
  levelsEnabled: boolean;
  emaEnabled: number[];
}

const DEFAULT_TOGGLES: LineToggles = {
  weekly: true,
  monday: false,
  pdhlm: true,
  fibb: false,
  weekend: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  lineToggles: DEFAULT_TOGGLES,
  levelsEnabled: true,
  emaEnabled: ALL_EMAS,
};

const STORAGE_KEY_SETTINGS = "fuck-your-chart:settings:v1";

function getLocalSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const toggles = (parsed.lineToggles && typeof parsed.lineToggles === "object") ? parsed.lineToggles : parsed;
    return {
      lineToggles: {
        weekly: typeof toggles.weekly === "boolean" ? toggles.weekly : DEFAULT_TOGGLES.weekly,
        monday: typeof toggles.monday === "boolean" ? toggles.monday : DEFAULT_TOGGLES.monday,
        pdhlm: typeof toggles.pdhlm === "boolean" ? toggles.pdhlm : DEFAULT_TOGGLES.pdhlm,
        fibb: typeof toggles.fibb === "boolean" ? toggles.fibb : DEFAULT_TOGGLES.fibb,
        weekend: typeof toggles.weekend === "boolean" ? toggles.weekend : DEFAULT_TOGGLES.weekend,
      },
      levelsEnabled: typeof parsed.levelsEnabled === "boolean" ? parsed.levelsEnabled : true,
      emaEnabled: Array.isArray(parsed.emaEnabled) ? parsed.emaEnabled : ALL_EMAS,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function setLocalSettings(s: AppSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(s));
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

function areSettingsEqual(a: AppSettings, b: AppSettings): boolean {
  if (a.levelsEnabled !== b.levelsEnabled) return false;
  if (!areTogglesEqual(a.lineToggles, b.lineToggles)) return false;
  if (a.emaEnabled.length !== b.emaEnabled.length) return false;
  const setA = new Set(a.emaEnabled);
  for (const n of b.emaEnabled) {
    if (!setA.has(n)) return false;
  }
  return true;
}

export default function Page() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTimeframe, setSelectedTimeframe] = useState<string | null>(null);

  const linkedTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const linkedCrosshairSync = useRef<Record<LinkedCrosshairId, LinkedCrosshairSync | null>>({
    raw: null,
    heikin: null,
  });

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
    const target = source === "raw" ? "heikin" : "raw";
    linkedCrosshairSync.current[target]?.(time);
  };

  const handleTimeframeChange = (tf: string | null) => {
    linkedTimeScales.current = [];
    linkedCrosshairSync.current = { raw: null, heikin: null };
    setSelectedTimeframe(tf);
  };
  const [tz, setTz] = useState<TzOffset>(8);
  const [switchedLayout, setSwitchedLayout] = useState(false);
  const [zones, setZones] = useState<Zones | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => getLocalSettings());
  const toggles = appSettings.lineToggles;
  const levelsEnabled = appSettings.levelsEnabled;
  const emaEnabled = appSettings.emaEnabled;
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
          play5mCloseAlert();
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
          play5mCloseAlert();
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

  const handleSymbolChange = useCallback((newSymbol: string) => {
    setSymbol(newSymbol);
    if (selectedDate) {
      void fetchZones(selectedDate, newSymbol).then(setZones);
    }
  }, [selectedDate]);

  const onDateChange = useCallback(async (date: string) => {
    setSelectedDate(date);
    const data = await fetchZones(date, symbol);
    setZones(data);
  }, [symbol]);

  // Fetch all settings from backend (or fall back to localStorage)
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = (await res.json()) as { lineToggles: LineToggles; levelsEnabled: boolean; emaEnabled: number[] };
        const remote: AppSettings = {
          lineToggles: data.lineToggles ?? DEFAULT_TOGGLES,
          levelsEnabled: typeof data.levelsEnabled === "boolean" ? data.levelsEnabled : true,
          emaEnabled: Array.isArray(data.emaEnabled) ? data.emaEnabled : ALL_EMAS,
        };
        setAppSettings((prev) => (areSettingsEqual(prev, remote) ? prev : remote));
        setLocalSettings(remote);
      }
    } catch {
      // Backend unavailable (GitHub Pages etc.) — keep local state
    }
  }, []);

  // Initial load of settings + background poll for cross-browser sync
  useEffect(() => {
    void fetchSettings();

    const pollInterval = setInterval(() => {
      void fetchSettings();
    }, 2000);

    const onFocus = () => { void fetchSettings(); };
    window.addEventListener("focus", onFocus);

    // Cross-tab sync within the same browser
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_SETTINGS && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as AppSettings;
          if (parsed.lineToggles && typeof parsed.lineToggles === "object") {
            setAppSettings((prev) => (areSettingsEqual(prev, parsed) ? prev : parsed));
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
  }, [fetchSettings]);
  const onToggle = useCallback((key: keyof LineToggles) => {
    setAppSettings((prev) => {
      const next: AppSettings = { ...prev, lineToggles: { ...prev.lineToggles, [key]: !prev.lineToggles[key] } };
      setLocalSettings(next);
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
      return next;
    });
  }, []);

  const onToggleLevels = useCallback(() => {
    setAppSettings((prev) => {
      const next: AppSettings = { ...prev, levelsEnabled: !prev.levelsEnabled };
      setLocalSettings(next);
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
      return next;
    });
  }, []);

  const onToggleEma = useCallback((period: number) => {
    setAppSettings((prev) => {
      const set = new Set(prev.emaEnabled);
      if (set.has(period)) set.delete(period); else set.add(period);
      const next: AppSettings = { ...prev, emaEnabled: Array.from(set) };
      setLocalSettings(next);
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
      return next;
    });
  }, []);

  const rawInterval = selectedTimeframe ?? "5m";
  const topHaInterval = selectedTimeframe ?? "15m";
  const isSynchronized = selectedTimeframe !== null;

  return (
    <>
      <TopBar
        symbol={symbol}
        onSymbolChange={handleSymbolChange}
        onDateChange={onDateChange}
        toggles={toggles}
        onToggle={onToggle}
        selectedTimeframe={selectedTimeframe}
        onTimeframeChange={handleTimeframeChange}
        customLevelsReady={customLevelsReady}
        customLevelsError={customLevelsError}
        onAddCustom={(price, color) => customLevelsRequest("POST", { price, color })}
        onClearCustom={() => customLevelsRequest("DELETE")}
        beep5mEnabled={beep5mEnabled}
        onToggleBeep5m={toggleBeep5m}
      />
      <main className={`page${switchedLayout ? " switched" : ""}`}>
        <div className="cell chart-main">
          <Chart
            key={`raw-${symbol}-${rawInterval}`}
            symbol={symbol}
            interval={rawInterval}
            emas={ALL_EMAS}
            allowFootprint={true}
            defaultFootprintEnabled={true}
            defaultLevelsEnabled={true}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onChartDoubleClick={toggleLayout}
            registerTimeScale={isSynchronized ? registerLinkedTime : undefined}
            siblingScales={isSynchronized ? linkedTimeScales : undefined}
            linkedCrosshairId={isSynchronized ? "raw" : undefined}
            registerLinkedCrosshair={isSynchronized ? registerLinkedCrosshair : undefined}
            onLinkedCrosshair={isSynchronized ? syncLinkedCrosshair : undefined}
            levelsEnabled={levelsEnabled}
            onToggleLevels={onToggleLevels}
            emaEnabled={emaEnabled}
            onToggleEma={onToggleEma}
          />
        </div>
        <div className="cell chart-ha-top">
          <Chart
            key={`ha-top-${symbol}-${topHaInterval}`}
            symbol={symbol}
            interval={topHaInterval}
            heikin
            emas={ALL_EMAS}
            allowFootprint={false}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={false}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onChartDoubleClick={toggleLayout}
            registerTimeScale={isSynchronized ? registerLinkedTime : undefined}
            siblingScales={isSynchronized ? linkedTimeScales : undefined}
            linkedCrosshairId={isSynchronized ? "heikin" : undefined}
            registerLinkedCrosshair={isSynchronized ? registerLinkedCrosshair : undefined}
            onLinkedCrosshair={isSynchronized ? syncLinkedCrosshair : undefined}
            emaEnabled={emaEnabled}
            onToggleEma={onToggleEma}
          />
        </div>
        <div className="cell chart-ha-bottom">
          <Chart
            key={`ha-bottom-${symbol}-3m`}
            symbol={symbol}
            interval="3m"
            heikin
            emas={ALL_EMAS}
            allowFootprint={false}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={false}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            onChartDoubleClick={toggleLayout}
            emaEnabled={emaEnabled}
            onToggleEma={onToggleEma}
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
    </>
  );
}
