"use client";

import { useCallback, useRef, useState } from "react";
import type { ITimeScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset, Zones, LineToggles, CustomLevel, CustomLevelColor } from "../components/Chart";

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

  const registerRightTime = (api: ITimeScaleApi<Time> | null) => {
    if (api && !oneMinuteTimeScales.current.includes(api))
      oneMinuteTimeScales.current.push(api);
  };
  const [tz, setTz] = useState<TzOffset>(8);
  const [zones, setZones] = useState<Zones | null>(null);
  const [toggles, setToggles] = useState<LineToggles>(DEFAULT_TOGGLES);
  const [customLevels, setCustomLevels] = useState<CustomLevel[]>([]);

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

  return (
    <>
      <TopBar
        onDateChange={onDateChange}
        toggles={toggles}
        onToggle={onToggle}
        onAddCustom={(price, color) => setCustomLevels((prev) => [...prev, { price, color }])}
        onClearCustom={() => setCustomLevels([])}
      />
      <main className="page">
        <div className="cell">
          <Chart
            interval="5m"
            emas={ALL_EMAS}
            defaultEmaOff={FIVE_M_EMA_OFF}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
          />
        </div>
        <div className="cell">
          <Chart
            interval="1m"
            emas={ALL_EMAS}
            defaultEmaOff={ONE_M_EMA_OFF}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
          />
        </div>
        <div className="cell">
          <Chart
            interval="3m"
            heikin
            emas={ALL_EMAS}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
          />
        </div>
        <div className="cell">
          <Chart
            interval="1m"
            heikin
            emas={ALL_EMAS}
            defaultEmaOff={ONE_M_EMA_OFF}
            tz={tz}
            zones={zones}
            lineToggles={toggles}
            customLevels={customLevels}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
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
