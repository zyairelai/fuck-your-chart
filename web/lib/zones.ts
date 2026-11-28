import type { Zones } from "../components/Chart";
import { fetchFromBinanceDirect } from "./historyStore";

function fibRange(high: number, low: number) {
  const mid = (high + low) / 2;
  // Same odd-integer nudge as zones.py so 75%/25% match the CLI.
  let sumHM = high + mid;
  if (Number.isInteger(sumHM) && sumHM % 2 !== 0) sumHM += 1;
  let sumLM = low + mid;
  if (Number.isInteger(sumLM) && sumLM % 2 !== 0) sumLM -= 1;
  return { high, low, mid, p75: sumHM / 2, p25: sumLM / 2 };
}

function barAt(bars: { time: number; high: number; low: number }[], openSec: number) {
  return bars.find((b) => b.time === openSec)
    ?? [...bars].reverse().find((b) => b.time <= openSec);
}

/**
 * Compute Previous 4H High/Low (P4HL) using closed candles & Mother Bar loop:
 * Ignore index [-1] (forming/unclosed 4H candle), start at [-2], and walk
 * backwards while [i-1] completely engulfs [i].
 */
function computeP4hl(bars4h: { high: number; low: number }[]): { high: number; low: number } | null {
  if (bars4h.length < 2) return null;
  let idx = bars4h.length - 2;
  while (idx > 0) {
    const curr = bars4h[idx]!;
    const prev = bars4h[idx - 1]!;
    if (prev.high >= curr.high && prev.low <= curr.low) {
      idx -= 1;
    } else {
      break;
    }
  }
  const mother = bars4h[idx]!;
  return { high: mother.high, low: mother.low };
}

/**
 * Fetch zones (PDH, PDL, PDM, PWH, PWL, PWM, MH, ML, WH, WL, WM, fibb, P4HL).
 * Tries the local backend API first; if unavailable (e.g. on GitHub Pages),
 * computes them directly from Binance Futures 1d/1w/4h candles.
 */
export async function fetchZones(dateStr: string, symbol = "BTCUSDT"): Promise<Zones | null> {
  try {
    const res = await fetch(`/api/zones/${encodeURIComponent(dateStr)}?symbol=${encodeURIComponent(symbol)}`);
    if (res.ok) {
      return (await res.json()) as Zones;
    }
  } catch {
    // Fallback below
  }

  try {
    const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
    if (!y || !m || !d) return null;
    const todayOpenMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const todayOpenSec = Math.floor(todayOpenMs / 1000);
    const endMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999);

    const [daily, weekly, fourHour] = await Promise.all([
      fetchFromBinanceDirect("1d", 20, endMs, symbol),
      fetchFromBinanceDirect("1w", 8, endMs, symbol),
      fetchFromBinanceDirect("4h", 50, endMs, symbol),
    ]);

    const refDow = new Date(todayOpenMs).getUTCDay(); // 0=Sun, 1=Mon, 5=Fri
    const prevDayOpenSec = refDow === 1
      ? todayOpenSec - 3 * 86400 // Monday → Friday
      : todayOpenSec - 86400;
    const prevSrc = barAt(daily, prevDayOpenSec);
    const prevDay = prevSrc ? fibRange(prevSrc.high, prevSrc.low) : null;

    const daysSinceMon = (refDow + 6) % 7;
    const weekStartSec = todayOpenSec - daysSinceMon * 86400;
    const mondaySrc = barAt(daily, weekStartSec);
    const monday = mondaySrc ? { high: mondaySrc.high, low: mondaySrc.low } : null;

    const saturdaySrc = daily.find((bar) => bar.time === weekStartSec - 2 * 86400);
    const sundaySrc = daily.find((bar) => bar.time === weekStartSec - 86400);
    let weekend: { high: number; low: number; mid: number } | null = null;
    if (saturdaySrc && sundaySrc) {
      const high = Math.max(saturdaySrc.high, sundaySrc.high);
      const low = Math.min(saturdaySrc.low, sundaySrc.low);
      weekend = { high, low, mid: (high + low) / 2 };
    }

    const prevWeekSrc = barAt(weekly, weekStartSec - 7 * 86400);
    const prevWeek = prevWeekSrc
      ? { high: prevWeekSrc.high, low: prevWeekSrc.low, mid: (prevWeekSrc.high + prevWeekSrc.low) / 2 }
      : null;

    const p4hl = computeP4hl(fourHour);

    return { prevWeek, monday, prevDay, weekend, p4hl };
  } catch (err) {
    console.warn("[zones] client-side zones calculation failed:", err);
    return null;
  }
}

