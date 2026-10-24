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

import { klines, streamKlines } from "./binance.js";

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
const HISTORY_LIMIT = 500;
const history = new Map<Interval, unknown[]>();

async function loadHistory() {
  for (const interval of DEFAULT_INTERVALS) {
    await loadInterval(interval);
  }
  io.emit("history", Object.fromEntries(history));
}

/** Load + cache one interval, and drop the still-open last bar so the client
 *  doesn't paint a "cut off" half-candle. The first websocket tick re-adds
 *  it cleanly via series.update(). */
async function loadInterval(interval: Interval) {
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error(`unsupported interval: ${interval}`);
  }
  const bars = await klines(SYMBOL, interval, HISTORY_LIMIT);
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

/**
 * GET /api/pdhlm/:date  — Previous Day High / Low / Mid for BTCUSDT.
 *
 * `date` is the "selected / today" date in YYYY-MM-DD format.
 * We return the H/L/M of the day BEFORE that date (UTC calendar day).
 * The Binance spot 1d kline for a given UTC date opens at 00:00 UTC and
 * closes at 23:59:59 UTC, so we just fetch the candle that opens at
 * midnight UTC of the previous day.
 */
app.get("/api/pdhlm/:date", async (req, res) => {
  try {
    const dateStr = String(req.params.date);
    // Parse selected date and go back one calendar day.
    const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
    const selectedMs = Date.UTC(y, m - 1, d, 0, 0, 0);
    const prevDayOpenMs = selectedMs - 86400_000;

    // Binance 1d kline: startTime=prevDayOpenMs, limit=1
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${prevDayOpenMs}&limit=1`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance 1d kline failed: ${r.status}`);
    const raw = (await r.json()) as (string | number)[][];
    if (!raw.length) {
      res.status(404).json({ error: "no data for previous day" });
      return;
    }
    const row = raw[0]!;
    const high = Number(row[2]);
    const low  = Number(row[3]);
    const mid  = (high + low) / 2;
    const prevDateMs = prevDayOpenMs;
    const pDate = new Date(prevDateMs);
    const prevDateStr = `${pDate.getUTCFullYear()}-${String(pDate.getUTCMonth()+1).padStart(2,"0")}-${String(pDate.getUTCDate()).padStart(2,"0")}`;
    res.json({ date: prevDateStr, high, low, mid });
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
