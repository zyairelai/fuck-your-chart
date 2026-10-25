# fuck-your-chart

Three live BTC/USDT charts in a single Docker container on `localhost:8000`. Inspired by the layout of [OpenTerminal](https://github.com/ErTasselli/OpenTerminal) but stripped down to exactly three charts and a single WebSocket — no widgets, no AI, no DB, no API keys.

| Layer | Stack |
|---|---|
| Backend | Node.js 22 + Express 4 + Socket.IO + `ws` |
| Frontend | Next.js 15 (static export) + React 19 + `lightweight-charts` v5 |
| Data | `fapi.binance.com` for historical klines · `stream.binance.com` for live ticks |

## Run

```bash
docker compose up --build
```
```bash
docker system prune -a --volumes
```

Open: <http://localhost:8000>

`GET /api/status` returns a JSON snapshot of loaded candles + connected clients.

## What you see

- **Left (big):** 3-minute candles with EMA 20 / 50 / 200.
- **Top right:** 1-minute Heikin Ashi candles.
- **Bottom right:** 1-minute Heikin Ashi candles (second instance).

Layout is a CSS grid; no `react-grid-layout`, no draggable widgets, no resize handles. It's exactly three panels and never anything else.

## How "live" works

On boot the Express server fetches **500 historical candles per interval** from the Binance Futures REST API (`/fapi/v1/klines`) and seeds each connected browser with them on `socket connect`. Then it opens **one** combined WebSocket to Binance and forwards every kline tick to every browser over Socket.IO. The browser only ever talks to localhost — no `fetchKlines` polling, no per-interval re-fetching, no spamming.

Each chart subscribes to its own interval, calls `series.update(k)` for the open candle (which mutates in place until the candle closes), and appends a fresh bar on rollover. EMA lines are recomputed on history load and patched on the open candle's tail using a local cache so the overlay tracks the live price smoothly.

Every chart also has a fixed lower footprint-delta histogram, enabled by default and controlled by the `footprint` header toggle. Delta is Binance taker-buy BTC volume minus taker-sell BTC volume for each candle; bars are green for positive delta and red for negative delta. Hover a bar to show its signed integer delta above the bar. Turning the toggle off removes the entire pane. The pane divider is subtle and cannot be dragged.

The two 1-minute charts on the right share their crosshair: hovering either chart aligns the other chart to the same candle time and updates both OHLC and footprint-delta readouts.

## A note on the data source

History is loaded from the **futures perp** REST endpoint (the user asked for "BTCUSDT futures perp"). Live ticks come from the **spot** WebSocket — in the sandbox where this image was built, the futures WS server pushes nothing for the `kline` topic (other topics like `trade` and `depth` work fine). Spot and futures perp trade at essentially the same price (basis is sub-basis-point), so the charts look identical to the eye. If you want pure futures WS live ticks, change `SPOT_WS` to `FAPI_WS` in `server/src/binance.ts` — the rest of the pipeline is agnostic to the source.

## Project layout

```
.
├── docker-compose.yml      # 1 service, exposes 127.0.0.1:8000
├── server/                 # Express + Socket.IO + Binance WS
│   ├── src/binance.ts      # klines() + streamKlines()
│   └── src/index.ts        # history load + WS fan-out + static serve
└── web/                    # Next.js app (build -> static /out)
    ├── app/page.tsx        # 3-panel grid
    └── components/Chart.tsx# lightweight-charts + Socket.IO consumer
```
