"use client";

import { useCallback, useRef, useState } from "react";
import type { ITimeScaleApi, IPriceScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar from "../components/TopBar";
import type { TzOffset } from "../components/Chart";

interface Pdhlm {
  high: number;
  low: number;
  mid: number;
}

export default function Page() {
  // ── Right column: 1m raw (top) + 1m HA (bottom) — sync time & price ────
  const oneMinuteTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const oneMinutePriceScales = useRef<IPriceScaleApi[]>([]);
  const rightPriceScaleLock = useRef(false);

  const registerRightTime = (api: ITimeScaleApi<Time> | null) => {
    if (api && !oneMinuteTimeScales.current.includes(api))
      oneMinuteTimeScales.current.push(api);
  };
  const registerRightPrice = (api: IPriceScaleApi | null) => {
    if (api && !oneMinutePriceScales.current.includes(api))
      oneMinutePriceScales.current.push(api);
  };

  // Global timezone — ONE dropdown at the bottom-right of the whole screen.
  const [tz, setTz] = useState<TzOffset>(8);

  // PDHLM — fetched whenever the TopBar date changes.
  const [pdhlm, setPdhlm] = useState<Pdhlm | null>(null);

  const onDateChange = useCallback(async (date: string) => {
    try {
      const res = await fetch(`/api/pdhlm/${encodeURIComponent(date)}`);
      if (!res.ok) { setPdhlm(null); return; }
      const data = (await res.json()) as Pdhlm;
      setPdhlm(data);
    } catch {
      setPdhlm(null);
    }
  }, []);

  return (
    <>
      <TopBar onDateChange={onDateChange} />
      <main className="page">
        {/* Top-left: 5m · raw candles */}
        <div className="cell">
          <Chart
            interval="5m"
            emas={[10, 20, 50, 200]}
            defaultEmaOff={[50, 200]}
            tz={tz}
            pdhlm={pdhlm}
          />
        </div>
        {/* Top-right: 1m · raw candles, synced with bottom-right */}
        <div className="cell">
          <Chart
            interval="1m"
            emas={[10, 20, 50, 200]}
            defaultEmaOff={[50, 200]}
            tz={tz}
            pdhlm={pdhlm}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerRightPrice}
            siblingPriceScales={oneMinutePriceScales}
            priceScaleLock={rightPriceScaleLock}
          />
        </div>
        {/* Bottom-left: 3m · Heikin Ashi */}
        <div className="cell">
          <Chart
            interval="3m"
            heikin
            emas={[10, 20, 50, 200]}
            tz={tz}
            pdhlm={pdhlm}
          />
        </div>
        {/* Bottom-right: 1m · Heikin Ashi, synced with top-right */}
        <div className="cell">
          <Chart
            interval="1m"
            heikin
            emas={[10, 20, 50, 200]}
            defaultEmaOff={[50, 200]}
            tz={tz}
            pdhlm={pdhlm}
            registerTimeScale={registerRightTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerRightPrice}
            siblingPriceScales={oneMinutePriceScales}
            priceScaleLock={rightPriceScaleLock}
          />
        </div>
      </main>

      {/* Single global TZ dropdown — bottom-right of screen, controls all 4 charts */}
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