"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ITimeScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset, Zones, LineToggles, CustomLevel, LinkedCrosshairId, LinkedCrosshairSync } from "../components/Chart";

const ALL_EMAS = [10, 20, 50, 200];

const DEFAULT_TOGGLES: LineToggles = {
  weekly: true,
  monday: false,
  pdhlm: true,
  fibb: false,
  weekend: false,
};

export default function Page() {
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
  const [toggles, setToggles] = useState<LineToggles>(DEFAULT_TOGGLES);
  const [customLevels, setCustomLevels] = useState<CustomLevel[]>([]);
  const [customLevelsReady, setCustomLevelsReady] = useState(false);
  const [customLevelsError, setCustomLevelsError] = useState<string | null>(null);

  const toggleLayout = useCallback(() => {
    setSwitchedLayout((prev) => !prev);
  }, []);

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

  const rawInterval = selectedTimeframe ?? "5m";
  const topHaInterval = selectedTimeframe ?? "15m";
  const isSynchronized = selectedTimeframe !== null;

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
      <main className={`page${switchedLayout ? " switched" : ""}`}>
        <div className="cell chart-main">
          <Chart
            key={`raw-${rawInterval}`}
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
          />
        </div>
        <div className="cell chart-ha-top">
          <Chart
            key={`ha-top-${topHaInterval}`}
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
          />
        </div>
        <div className="cell chart-ha-bottom">
          <Chart
            key="ha-bottom-3m"
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
