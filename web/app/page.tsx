"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IPriceScaleApi, ITimeScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset, Zones, LineToggles, CustomLevel, CustomLevelColor } from "../components/Chart";

type LinkedCrosshairId = "raw" | "heikin";
type LinkedCrosshairSync = (time: number | null) => void;

const ALL_EMAS = [10, 20, 50, 200];
/** 5m: 50 + 200 on by default; 10 + 20 off. */
const FIVE_M_EMA_OFF = [10, 20];
/** 1m: 10 + 20 on by default; 50 + 200 off (too noisy). */
const ONE_M_EMA_OFF = [50, 200];

const DEFAULT_TOGGLES: LineToggles = {
  weekly: true,
  monday: false,
  pdhlm: true,
  fibb: false,
  weekend: false,
};

export default function Page() {
  // ── Right column: 1m raw (top) + 1m HA (bottom) — sync time ────────────
  const oneMinuteTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const oneMinutePriceScales = useRef<IPriceScaleApi[]>([]);
  const oneMinuteCrosshairSync = useRef<Record<LinkedCrosshairId, LinkedCrosshairSync | null>>({
    raw: null,
    heikin: null,
  });

  const registerRightTime = (api: ITimeScaleApi<Time> | null) => {
    if (api && !oneMinuteTimeScales.current.includes(api))
      oneMinuteTimeScales.current.push(api);
  };
  const registerRightPriceScale = (api: IPriceScaleApi | null) => {
    if (api && !oneMinutePriceScales.current.includes(api))
      oneMinutePriceScales.current.push(api);
  };
  const registerRightCrosshair = (
    id: LinkedCrosshairId,
    sync: LinkedCrosshairSync | null,
  ) => {
    oneMinuteCrosshairSync.current[id] = sync;
  };
  const syncRightCrosshair = (source: LinkedCrosshairId, time: number | null) => {
    const target = source === "raw" ? "heikin" : "raw";
    oneMinuteCrosshairSync.current[target]?.(time);
  };

  // ── Left column: when a timeframe is selected, sync raw (top) + HA (bottom) ─
  const leftTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const leftPriceScales = useRef<IPriceScaleApi[]>([]);
  const leftCrosshairSync = useRef<Record<LinkedCrosshairId, LinkedCrosshairSync | null>>({
    raw: null,
    heikin: null,
  });

  const registerLeftTime = (api: ITimeScaleApi<Time> | null) => {
    if (api && !leftTimeScales.current.includes(api))
      leftTimeScales.current.push(api);
  };
  const registerLeftPriceScale = (api: IPriceScaleApi | null) => {
    if (api && !leftPriceScales.current.includes(api))
      leftPriceScales.current.push(api);
  };
  const registerLeftCrosshair = (
    id: LinkedCrosshairId,
    sync: LinkedCrosshairSync | null,
  ) => {
    leftCrosshairSync.current[id] = sync;
  };
  const syncLeftCrosshair = (source: LinkedCrosshairId, time: number | null) => {
    const target = source === "raw" ? "heikin" : "raw";
    leftCrosshairSync.current[target]?.(time);
  };

  const [selectedTimeframe, setSelectedTimeframe] = useState<string | null>(null);

  const handleTimeframeChange = (tf: string | null) => {
    leftTimeScales.current = [];
    leftPriceScales.current = [];
    leftCrosshairSync.current = { raw: null, heikin: null };
    setSelectedTimeframe(tf);
  };
  const [tz, setTz] = useState<TzOffset>(8);
  const [mirroredLayout, setMirroredLayout] = useState(false);
  const [expandedChart, setExpandedChart] = useState<"5m" | "3m" | null>(null);
  const [zones, setZones] = useState<Zones | null>(null);
  const [toggles, setToggles] = useState<LineToggles>(DEFAULT_TOGGLES);
  const [customLevels, setCustomLevels] = useState<CustomLevel[]>([]);
  const [customLevelsReady, setCustomLevelsReady] = useState(false);
  const [customLevelsError, setCustomLevelsError] = useState<string | null>(null);

  const customLevelsRequest = useCallback(async (method: "GET" | "POST" | "DELETE", body?: CustomLevel) => {
    const res = await fetch("/api/custom-levels", {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const result = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(result?.error ?? `Custom levels request failed (${res.status})`);
    }
    const result = (await res.json()) as { customLevels: CustomLevel[] };
    setCustomLevels(result.customLevels);
    setCustomLevelsError(null);
  }, []);

  const onDeleteCustomLevel = useCallback(async (price: number) => {
    try {
      const res = await fetch(`/api/custom-levels?price=${encodeURIComponent(price)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const result = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(result?.error ?? `Failed to delete custom level (${res.status})`);
      }
      const result = (await res.json()) as { customLevels: CustomLevel[] };
      setCustomLevels(result.customLevels);
      setCustomLevelsError(null);
    } catch (err) {
      setCustomLevelsError(err instanceof Error ? err.message : "Could not delete custom level");
    }
  }, []);

  useEffect(() => {
    void customLevelsRequest("GET")
      .catch((err: unknown) => {
        setCustomLevelsError(err instanceof Error ? err.message : "Could not load custom levels");
      })
      .finally(() => setCustomLevelsReady(true));
  }, [customLevelsRequest]);

  const onDateChange = useCallback(async (date: string) => {
    try {
      const res = await fetch(`/api/zones/${encodeURIComponent(date)}`);
      if (!res.ok) { setZones(null); return; }
      const data = (await res.json()) as Zones;
      setZones(data);
    } catch {
      setZones(null);
    }
  }, []);

  const onToggle = useCallback((key: keyof LineToggles) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const topInterval = selectedTimeframe ?? "5m";
  const bottomInterval = selectedTimeframe ?? "3m";
  const isStaticMode = selectedTimeframe !== null;
  // Sync props are only wired when a TF is selected — default 5m/3m are independent.
  const isLeftSynchro = isStaticMode;

  return (
    <>
      <TopBar
        onDateChange={onDateChange}
        toggles={toggles}
        onToggle={onToggle}
        selectedTimeframe={selectedTimeframe}
        onTimeframeChange={handleTimeframeChange}
        customLevelsReady={customLevelsReady}
        customLevelsError={customLevelsError}
        onAddCustom={(price, color) => customLevelsRequest("POST", { price, color })}
        onClearCustom={() => customLevelsRequest("DELETE")}
      />
      <main
        className={`page${mirroredLayout ? " mirrored" : ""}${expandedChart ? ` expanded-${expandedChart}` : ""}`}
      >
        <div className="cell chart-5m">
          <Chart
            key={`left-raw-${topInterval}`}
            interval={topInterval}
            emas={ALL_EMAS}
            defaultEmaOff={FIVE_M_EMA_OFF}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={true}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            staticMode={isStaticMode}
            registerTimeScale={isLeftSynchro ? registerLeftTime : undefined}
            siblingScales={isLeftSynchro ? leftTimeScales : undefined}
            registerPriceScale={isLeftSynchro ? registerLeftPriceScale : undefined}
            siblingPriceScales={isLeftSynchro ? leftPriceScales : undefined}
            linkedCrosshairId={isLeftSynchro ? "raw" : undefined}
            registerLinkedCrosshair={isLeftSynchro ? registerLeftCrosshair : undefined}
            onLinkedCrosshair={isLeftSynchro ? syncLeftCrosshair : undefined}
            onChartDoubleClick={() => {
              setExpandedChart((current) => current === "5m" ? null : "5m");
            }}
          />
        </div>
        <div className="cell chart-1m-raw">
          <Chart
            interval="1m"
            emas={ALL_EMAS}
            defaultEmaOff={ONE_M_EMA_OFF}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={true}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerRightPriceScale}
            siblingPriceScales={oneMinutePriceScales}
            linkedCrosshairId="raw"
            registerLinkedCrosshair={registerRightCrosshair}
            onLinkedCrosshair={syncRightCrosshair}
            onChartDoubleClick={() => setMirroredLayout((current) => !current)}
          />
        </div>
        <div className="cell chart-3m-ha">
          <Chart
            key={`left-ha-${bottomInterval}`}
            interval={bottomInterval}
            heikin
            emas={ALL_EMAS}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={selectedTimeframe !== null ? true : false}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            staticMode={isStaticMode}
            registerTimeScale={isLeftSynchro ? registerLeftTime : undefined}
            siblingScales={isLeftSynchro ? leftTimeScales : undefined}
            registerPriceScale={isLeftSynchro ? registerLeftPriceScale : undefined}
            siblingPriceScales={isLeftSynchro ? leftPriceScales : undefined}
            linkedCrosshairId={isLeftSynchro ? "heikin" : undefined}
            registerLinkedCrosshair={isLeftSynchro ? registerLeftCrosshair : undefined}
            onLinkedCrosshair={isLeftSynchro ? syncLeftCrosshair : undefined}
            onChartDoubleClick={() => {
              setExpandedChart((current) => current === "3m" ? null : "3m");
            }}
          />
        </div>
        <div className="cell chart-1m-ha">
          <Chart
            interval="1m"
            heikin
            emas={ALL_EMAS}
            defaultEmaOff={ONE_M_EMA_OFF}
            defaultFootprintEnabled={false}
            defaultLevelsEnabled={true}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            onDeleteCustomLevel={onDeleteCustomLevel}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerRightPriceScale}
            siblingPriceScales={oneMinutePriceScales}
            linkedCrosshairId="heikin"
            registerLinkedCrosshair={registerRightCrosshair}
            onLinkedCrosshair={syncRightCrosshair}
            onChartDoubleClick={() => setMirroredLayout((current) => !current)}
          />
        </div>
      </main>

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
