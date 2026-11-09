/**
 * Single Express server for Docker.
 * Serves the static Next.js export (/web/out) and REST endpoints for
 * klines, zones, and custom levels. No WebSockets or background loops.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

import { klinesFutures } from "./binance.js";

const SYMBOL = "btcusdt";
const ALLOWED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Persistent custom levels (file-backed) ---
const DATA_DIR = path.resolve(__dirname, "..", "data");
const LEVELS_FILE = path.join(DATA_DIR, "custom-levels.json");

function loadCustomLevels(): { price: number; color: "red" | "yellow" | "green" }[] {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const raw = readFileSync(LEVELS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (l): l is { price: number; color: "red" | "yellow" | "green" } =>
          typeof l === "object" && l !== null &&
          typeof (l as { price?: unknown }).price === "number" &&
          isCustomLevelColor((l as { color?: unknown }).color),
      );
    }
  } catch {
    // File missing or corrupt — start fresh
  }
  return [];
}

function saveCustomLevels(levels: { price: number; color: "red" | "yellow" | "green" }[]) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LEVELS_FILE, JSON.stringify(levels, null, 2), "utf8");
  } catch (err) {
    console.error("[custom-levels] could not save:", err);
  }
}

function isCustomLevelColor(value: unknown): value is "red" | "yellow" | "green" {
  return value === "red" || value === "yellow" || value === "green";
}

const customLevels = loadCustomLevels();
console.log(`[boot] loaded ${customLevels.length} custom level(s) from ${LEVELS_FILE}`);

const app = express();
app.use(cors());
app.use(express.json());

// --- REST Endpoints ---
app.get("/api/status", (_req, res) => {
  res.json({
    symbol: SYMBOL,
    status: "ok",
    customLevelsCount: customLevels.length,
  });
});

app.get("/api/custom-levels", (_req, res) => {
  res.json({ customLevels });
});

app.post("/api/custom-levels", (req, res) => {
  const body: unknown = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "price and color are required" });
    return;
  }
  const level = body as { price?: unknown; color?: unknown };
  if (
    typeof level.price !== "number"
    || !Number.isFinite(level.price)
    || level.price <= 0
    || !isCustomLevelColor(level.color)
  ) {
    res.status(400).json({ error: "price must be positive and color must be red, yellow, or green" });
    return;
  }
  customLevels.push({
    price: Math.round(level.price * 2) / 2,
    color: level.color,
  });
  saveCustomLevels(customLevels);
  res.status(201).json({ customLevels });
});

app.delete("/api/custom-levels", (req, res) => {
  const queryPrice = req.query.price != null ? Number(req.query.price) : undefined;
  const bodyPrice = req.body && typeof req.body === "object" && "price" in req.body
    ? Number((req.body as { price?: unknown }).price)
    : undefined;
  const targetPrice = queryPrice ?? bodyPrice;

  if (targetPrice !== undefined && Number.isFinite(targetPrice)) {
    const roundedTarget = Math.round(targetPrice * 2) / 2;
    const index = customLevels.findIndex(
      (l) => Math.abs(Math.round(l.price * 2) / 2 - roundedTarget) < 0.01,
    );
    if (index >= 0) {
      customLevels.splice(index, 1);
    }
  } else {
    customLevels.length = 0;
  }
  saveCustomLevels(customLevels);
  res.json({ customLevels });
});

/** Paginated candles for initial load and polling. */
app.get("/api/klines/:interval", async (req, res) => {
  try {
    const interval = String(req.params.interval);
    if (!ALLOWED_INTERVALS.has(interval)) {
      res.status(400).json({ error: "unsupported interval" });
      return;
    }
    const symbol = String(req.query.symbol || SYMBOL).toLowerCase();
    const endTime = req.query.endTime != null ? Number(req.query.endTime) : undefined;
    const limit = Math.min(Number(req.query.limit) || 1000, 1000);
    const bars = await klinesFutures(symbol, interval, limit, endTime);
    res.json(bars);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function fibRange(high: number, low: number) {
  const mid = (high + low) / 2;
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
 * Calendar date reference day for drawing horizontal levels.
 */
app.get("/api/zones/:date", async (req, res) => {
  try {
    const dateStr = String(req.params.date);
    const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
    if (!y || !m || !d) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    const symbol = String(req.query.symbol || SYMBOL).toLowerCase();
    const todayOpenMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const todayOpenSec = Math.floor(todayOpenMs / 1000);
    const endMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999);

    const [daily, weekly] = await Promise.all([
      klinesFutures(symbol, "1d", 20, endMs),
      klinesFutures(symbol, "1w", 8, endMs),
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
    const prevWeek = prevWeekSrc ? { high: prevWeekSrc.high, low: prevWeekSrc.low } : null;

    res.json({ date: dateStr, prevWeek, monday, prevDay, weekend });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Serve the static Next.js export ---
const webOut = path.resolve(__dirname, "..", "web", "out");
const webNextStatic = path.join(webOut, "_next");

app.use("/_next", express.static(webNextStatic));

// Static assets (favicon.ico, robots.txt, etc.) served directly:
app.use(express.static(webOut));

// SPA fallback: any other route returns index.html for client-side routing
app.get(/^(?!\/(?:api|_next)\/).*/, (_req, res, next) => {
  res.sendFile(path.join(webOut, "index.html"), (err) => {
    if (err) next();
  });
});

// --- Boot ---
const PORT = Number(process.env.PORT ?? 8000);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  console.log("[shutdown] closing");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
