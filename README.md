# pi-lilac-tracker

Tracks Lilac model supply states and subscription discount rates over time, capturing the ~10-minute lock-in windows described in [Lilac's billing docs](https://docs.getlilac.com/billing/subscription-rates#live-per-model-discounts).

**Tracked models** (mirroring [`pi-lilac-provider`](https://github.com/monotykamary/pi-lilac-provider)):
- `google/gemma-4-31b-it` (Gemma 4)
- `zai-org/glm-5.1` (GLM 5.1)
- `zai-org/glm-5.2` (GLM 5.2)
- `moonshotai/kimi-k2.6` (Kimi K2.6)
- `minimaxai/minimax-m2.7` (MiniMax M2.7)
- `minimaxai/minimax-m3` (MiniMax M3)

## What it captures

The Lilac `/status` API returns per-model:
- **Supply state** (`low` / `medium` / `healthy` / `high`)
- **Discount percent** — subscription discount based on supply
- **Credit multiplier** — effective price factor (e.g. 0.75 = pay 75% of list price)
- **TPS** — current throughput
- **TTFB** — time to first byte
- **Uptime %** — 24h uptime

Lilac claims these rates lock in every ~10 minutes. This tracker polls at 60s intervals (adapting to 30s when state changes) to capture those transitions with high resolution. Over a year this produces ~52K–105K entries — trivial for JSONL.

## Quick start

```bash
# Install dependencies
npm install

# Set your Lilac API key
echo "LILAC_API_KEY=your-key-here" >> .env

# Start both server and web frontend
npm run dev
```

The server starts on `http://localhost:3100` and the Vite dev server on `http://localhost:5173` (which proxies `/api` to the backend).

## Architecture

### Server (`server/index.ts`)

- Polls `https://api.getlilac.com/status` at adaptive intervals
- Appends each snapshot to an unbounded JSONL file (`data/snapshots.jsonl`)
- Serves historical data via REST API:
  - `GET /api/snapshots` — all snapshots (supports `?from=ISO&to=ISO`)
  - `GET /api/snapshots/latest` — most recent snapshot
  - `GET /api/snapshots/count` — total snapshot count
  - `GET /api/pricing` — current list prices from `/v1/models`
  - `GET /api/status` — server health + polling status

### Web frontend (`src/`)

Vite + React + Tailwind + Recharts — styled after pi-tps-web.

- **Model cards** — current supply state, discount %, multiplier, TPS, TTFT
- **Supply state timeline** — color-coded blocks showing state transitions over time
- **Time series charts** — discount %, credit multiplier, TPS, TTFT, uptime

## Adaptive polling

| Condition | Interval |
|-----------|----------|
| Default | 60s |
| Supply state change detected | 30s for 5 minutes |

This gives higher resolution around transitions while keeping baseline cost low (~52K entries/year at 60s vs ~105K at 30s).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LILAC_API_KEY` | — | Required. Your Lilac API key |
| `POLL_INTERVAL` | `60` | Base polling interval in seconds |
| `PORT` | `3100` | Server port |
| `DATA_FILE` | `./data/snapshots.jsonl` | Path to JSONL storage |

## Data format

Each line in `snapshots.jsonl`:

```json
{
  "timestamp": "2026-06-06T12:34:56.789Z",
  "supply_updated_at": "2026-06-06T12:30:00.000Z",
  "window": "24h",
  "window_secs": 86400,
  "stale": false,
  "models": {
    "moonshotai/kimi-k2.6": {
      "id": "moonshotai/kimi-k2.6",
      "name": "Kimi K2.6",
      "tps": 68.99,
      "ttfb_seconds": 0.57,
      "uptime_pct": 99.99,
      "supply_state": "medium",
      "discount_percent": 25,
      "credit_multiplier": 0.75
    }
  }
}
```
