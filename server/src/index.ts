/**
 * Single Express + Socket.IO server.
 *
 * Layout: 1 service in docker-compose exposes port 8000. The Next.js standalone
 * server is reverse-proxied behind the same Express process so only one port
 * is needed. This keeps the whole stack on localhost:8000 as requested.
 *
 * Responsibilities:
 *  - On boot: fetch 500 historical 5m + 3m + 1m candles for BTCUSDT spot.
 *  - Open ONE Binance WebSocket, fan out kline ticks to every browser.
 *  - Serve the built Next.js static export from /web/out/.
 */

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { Server as IOServer } from "socket.io";

import { klines, klinesFutures, klinesPages, streamKlines } from "./binance.js";

const SYMBOL = "btcusdt";
// Fixed layout: 5m raw (top-left), 3m HA (bottom-left), 1m raw + HA (right).
// All three intervals are booted eagerly so every chart is ready immediately.
const DEFAULT_INTERVALS = ["5m", "3m", "1m"] as const;
const ALLOWED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
]);
type Interval = string;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: true, credentials: true },
});

/**
 * Maintain a per-interval cache of the most recent N candles. New WS ticks
 * either update the open candle (closed=false) or append a new closed candle.
 * This is the only place state lives; clients hold nothing.
 */
const HISTORY_LIMIT = 50_000;
const BOOT_PAGES = 10;
const history = new Map<Interval, unknown[]>();

async function loadHistory() {
  await Promise.all(DEFAULT_INTERVALS.map((interval) => loadInterval(interval)));
  io.emit("history", Object.fromEntries(history));
}

/** Load + cache one interval, and drop the still-open last bar so the client
 *  doesn't paint a "cut off" half-candle. The first websocket tick re-adds
 *  it cleanly via series.update(). */
async function loadInterval(interval: Interval) {
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error(`unsupported interval: ${interval}`);
  }
  const bars = await klinesPages(SYMBOL, interval, BOOT_PAGES, 1000);
  const last = bars[bars.length - 1] as { closed?: boolean } | undefined;
  if (last && last.closed === false) bars.pop();
  history.set(interval, bars);
  console.log(`[boot] loaded ${bars.length} ${interval} candles for ${SYMBOL}`);
}

/** Switch the big left chart to a new interval. Loads history if missing,
 *  adds the stream subscription if needed, and broadcasts the new history
 *  to every connected socket. */
async function ensureInterval(interval: Interval) {
  if (history.has(interval)) return;
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error(`unsupported interval: ${interval}`);
  }
  await loadInterval(interval);
  // Also subscribe the live stream if it's not already streaming this one.
  liveStream.add(interval);
  io.emit("history", { [interval]: history.get(interval) });
}

const liveStream = streamKlines(SYMBOL, [...DEFAULT_INTERVALS], (interval, k) => {
  const intervalKey = interval as Interval;
  const bars = history.get(intervalKey);
  if (!bars) return;
  const last = bars[bars.length - 1] as { time: number } | undefined;
  if (last && last.time === k.time) {
    // update open candle in place
    bars[bars.length - 1] = k;
  } else if (k.closed || !last || k.time > last.time) {
    // new bar: append (or roll over if the gap is large)
    if (last && k.time > last.time + 1) {
      // trim stale closed bars beyond the limit
      while (bars.length > HISTORY_LIMIT) bars.shift();
    }
    bars.push(k);
  }
  io.emit("kline", { interval, k });
});

io.on("connection", (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);
  socket.emit("history", Object.fromEntries(history));
  socket.on("disconnect", () => console.log(`[ws] client disconnected: ${socket.id}`));
});

// --- API for debugging (no auth, no keys, no rate limiting, single user) -----
app.get("/api/status", (_req, res) => {
  res.json({
    symbol: SYMBOL,
    intervals: [...history.keys()],
    history: Object.fromEntries(
      [...history.entries()].map(([k, v]) => [k, v.length]),
    ),
    clients: io.sockets.sockets.size,
  });
});

/** HTTP endpoint to switch interval (kept for compatibility). */
app.post("/api/interval/:name", async (req, res) => {
  const name = String(req.params.name);
  try {
    await ensureInterval(name);
    res.json({ interval: name, count: history.get(name)?.length ?? 0 });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Paginated older candles for infinite scroll-back. `endTime` is ms. */
app.get("/api/klines/:interval", async (req, res) => {
  try {
    const interval = String(req.params.interval);
    if (!ALLOWED_INTERVALS.has(interval)) {
      res.status(400).json({ error: "unsupported interval" });
      return;
    }
    const endTime = req.query.endTime != null ? Number(req.query.endTime) : undefined;
    const limit = Math.min(Number(req.query.limit) || 1000, 1000);
    const bars = await klines(SYMBOL, interval, limit, endTime);
    res.json(bars);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

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
 * GET /api/zones/:date
 *
 * Calendar date is ONLY the reference day for drawing horizontal levels.
 * Day boundaries are UTC 00:00 (Binance 1d/1w candles), not UTC+8.
 * OHLC comes from USDT-M futures — same as zones.py.
 */
app.get("/api/zones/:date", async (req, res) => {
  try {
    const dateStr = String(req.params.date);
    const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
    if (!y || !m || !d) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    const todayOpenMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const todayOpenSec = Math.floor(todayOpenMs / 1000);
    const endMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999);

    const [daily, weekly] = await Promise.all([
      klinesFutures(SYMBOL, "1d", 20, endMs),
      klinesFutures(SYMBOL, "1w", 8, endMs),
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

    const prevWeekSrc = barAt(weekly, weekStartSec - 7 * 86400);
    const prevWeek = prevWeekSrc ? { high: prevWeekSrc.high, low: prevWeekSrc.low } : null;

    res.json({ date: dateStr, prevWeek, monday, prevDay });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Serve the static Next.js export -----------------------------------------
// `next build` with `output: "export"` produces `web/out/index.html` plus the
// JS/CSS chunks under `_next/static/`. Express serves them as plain files.
const webOut = path.resolve(__dirname, "..", "web", "out");
const webNextStatic = path.join(webOut, "_next");

app.use("/_next", express.static(webNextStatic));

// Fallback: if the user requests a deep path that isn't a real file (e.g.
// `/some/random/url`), serve the SPA entry so React takes over.
app.get(/^(?!\/(?:api|socket\.io|_next)\/).*/, (_req, res, next) => {
  res.sendFile(path.join(webOut, "index.html"), (err) => {
    if (err) next();
  });
});

// Static asset root (favicon, etc.) last.
app.use(express.static(webOut));

// --- Boot order --------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 8000);

(async () => {
  try {
    await loadHistory();
  } catch (err) {
    console.error("[boot] history load failed:", err);
    process.exit(1);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[boot] listening on http://localhost:${PORT}`);
  });
})();

const shutdown = () => {
  console.log("[shutdown] closing");
  liveStream.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
