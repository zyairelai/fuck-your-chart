"use client";

/**
 * Top bar — matched to `sample/style.css` `.top-bar`.
 *
 *  LEFT  : timeframe picker (drives the big left chart's interval).
 *  RIGHT : global display-timezone picker (drives every chart's HH:mm / day
 *          labels on the time axis).
 *
 * There is intentionally ONE timezone selector at the top — not one per chart
 * — so switching it updates every chart at once.
 */

const TIMEFRAMES = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

export const TZ_OFFSETS = [0, 4, 8] as const;
export type TzOffset = (typeof TZ_OFFSETS)[number];

interface Props {
  /** Currently selected interval for the big left chart. */
  interval: string;
  /** Called when the user picks a new interval. */
  onIntervalChange: (next: string) => void;
  /** Currently selected display timezone offset (hours). */
  tz: TzOffset;
  /** Called when the user picks a new timezone. */
  onTzChange: (next: TzOffset) => void;
}

function tzLabel(v: TzOffset): string {
  if (v === 0) return "UTC";
  return `UTC+${v}`;
}

export default function TopBar({
  interval,
  onIntervalChange,
  tz,
  onTzChange,
}: Props) {
  const pick = (tf: Timeframe) => {
    if (tf === interval) return;
    onIntervalChange(tf);
  };

  return (
    <header className="top-bar">
      <div className="tf-group" role="group" aria-label="timeframe">
        {TIMEFRAMES.map((tf) => {
          const active = tf === interval;
          return (
            <button
              key={tf}
              type="button"
              className={"tf-btn" + (active ? " active" : "")}
              onClick={() => pick(tf)}
              aria-pressed={active}
            >
              {tf}
            </button>
          );
        })}
      </div>

      <div className="top-bar-spacer" />

      <div className="tz-group" title="Display timezone (global)">
        <span className="tz-label">TZ</span>
        <div className="tf-group tz-pick">
          {TZ_OFFSETS.map((v) => {
            const active = v === tz;
            return (
              <button
                key={v}
                type="button"
                className={"tf-btn" + (active ? " active" : "")}
                onClick={() => onTzChange(v)}
                aria-pressed={active}
              >
                {tzLabel(v)}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}