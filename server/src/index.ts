/**
 * Single Express + Socket.IO server.
 *
 * Layout: 1 service in docker-compose exposes port 8000. The Next.js standalone
 * server is reverse-proxied behind the same Express process so only one port
 * is needed. This keeps the whole stack on localhost:8000 as requested.
 *
 * Responsibilities:
 *  - On boot: fetch 500 historical 3m + 1m candles for BTCUSDT futures perp.
 *  - Open ONE Binance WebSocket, fan out kline ticks to every browser.
 *  - Serve the built Next.js app from /web/.next/standalone.
 */

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { Server as IOServer } from "socket.io";

import { klines, streamKlines } from "./binance.js";

const SYMBOL = "btcusdt";
// The 1m charts are always pinned to "1m". The big chart on the left starts
// on "3m" but can be switched at runtime from the top-bar timeframe picker.
// Any Binance-supported interval is accepted; the server boots with the two
// defaults and streams / kline events for whatever else a client requests.
const DEFAULT_INTERVALS = ["3m", "1m"] as const;
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

/** HTTP endpoint the top-bar timeframe picker hits when the user clicks a
 *  button. Loads history for the new interval (idempotent), subscribes the
 *  live stream, and returns the cached bars. */
app.post("/api/interval/:name", async (req, res) => {
  const name = String(req.params.name);
  try {
    await ensureInterval(name);
    res.json({ interval: name, count: history.get(name)?.length ?? 0 });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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
