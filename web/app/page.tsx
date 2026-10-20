"use client";

import { useRef, useState } from "react";
import type { ITimeScaleApi, IPriceScaleApi, Time } from "lightweight-charts";
import Chart from "../components/Chart";
import TopBar, { TZ_OFFSETS, type TzOffset } from "../components/TopBar";

export default function Page() {
  // Shared registries so the two right-side 1m charts mirror BOTH axes.
  //   - time scales -> pan/zoom together
  //   - price scales -> vertical moves on one drive the other
  const oneMinuteTimeScales = useRef<ITimeScaleApi<Time>[]>([]);
  const oneMinutePriceScales = useRef<IPriceScaleApi[]>([]);

  const registerTime = (api: ITimeScaleApi<Time> | null) => {
    if (api) {
      if (!oneMinuteTimeScales.current.includes(api)) {
        oneMinuteTimeScales.current.push(api);
      }
    }
  };
  const registerPrice = (api: IPriceScaleApi | null) => {
    if (api) {
      if (!oneMinutePriceScales.current.includes(api)) {
        oneMinutePriceScales.current.push(api);
      }
    }
  };

  // Big left chart's interval — chosen from the top bar.
  const [bigInterval, setBigInterval] = useState<string>("3m");
  // Global display timezone — chosen from the top bar's right side; applied
  // to every chart so they all show HH:mm / day labels the same way.
  const [tz, setTz] = useState<TzOffset>(8);
  // Narrow the type so the chart prop stays strict.
  const tzProp = (TZ_OFFSETS as readonly number[]).includes(tz) ? (tz as TzOffset) : 0;

  /** Top bar -> server handshake. Tells the backend to load + subscribe the
   *  picked interval; the server will then start emitting "history" and
   *  "kline" events for it. We update local state either way so the UI
   *  responds instantly. */
  const onPickInterval = (next: string) => {
    setBigInterval(next);
    fetch(`/api/interval/${encodeURIComponent(next)}`, { method: "POST" }).catch(
      (err) => console.error("[top-bar] interval switch failed", err),
    );
  };

  return (
    <>
      <TopBar
        interval={bigInterval}
        onIntervalChange={onPickInterval}
        tz={tz}
        onTzChange={setTz}
      />
      <main className="page">
        {/* Left: big Heikin Ashi chart whose timeframe is picked from the top
            bar. Starts on "3m". Full EMA set 9 / 21 / 50 / 200. */}
        <div className="cell" style={{ gridColumn: "1", gridRow: "1 / span 2" }}>
          <Chart
            interval={bigInterval}
            heikin
            emas={[9, 21, 50, 200]}
            tz={tzProp}
          />
        </div>
        {/* Top right: 1m raw candles, EMA 9 / 21 / 50 / 200 (50 & 200 off by
            default — click the darkened chip to turn them on). Synced sibling. */}
        <div className="cell" style={{ gridColumn: "2", gridRow: "1" }}>
          <Chart
            interval="1m"
            emas={[9, 21, 50, 200]}
            defaultEmaOff={[50, 200]}
            tz={tzProp}
            registerTimeScale={registerTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerPrice}
            siblingPriceScales={oneMinutePriceScales}
          />
        </div>
        {/* Bottom right: 1m Heikin Ashi, EMA 9 / 21 / 50 / 200 (50 & 200 off by
            default). Synced sibling. */}
        <div className="cell" style={{ gridColumn: "2", gridRow: "2" }}>
          <Chart
            interval="1m"
            heikin
            emas={[9, 21, 50, 200]}
            defaultEmaOff={[50, 200]}
            tz={tzProp}
            registerTimeScale={registerTime}
            siblingScales={oneMinuteTimeScales}
            registerPriceScale={registerPrice}
            siblingPriceScales={oneMinutePriceScales}
          />
        </div>
      </main>
    </>
  );
}