/**
 * Lilac Supply Tracker — Server
 *
 * Polls https://api.getlilac.com/status at adaptive intervals and appends
 * snapshots to an ever-growing JSONL file. Serves historical data via REST API
 * for the web frontend.
 *
 * Polling strategy:
 *   - Lilac's discount/supply state updates every ~10 minutes (600s lock-in window).
 *   - Default interval: 5 minutes. Polling twice per window catches a transition
 *     within ~5 min instead of waiting up to a full 10-min window for stale data.
 *   - When a state change is detected, reduce to 1 minute for 10 minutes.
 *     This lets us observe when the new state stabilises, since we don't know
 *     exactly when the 10-minute window started.
 *   - ~10.5K entries/year at 5m; trivial for JSONL.
 */

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import compression from "compression";
import "dotenv/config";

// ─── Config ──────────────────────────────────────────────────────────────────

const LILAC_API_KEY = process.env.LILAC_API_KEY || "";
const STATUS_URL = "https://api.getlilac.com/status";
const MODELS_URL = "https://api.getlilac.com/v1/models";
const PORT = parseInt(process.env.PORT || "3100", 10);
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data/snapshots.jsonl");
const DEFAULT_POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL || "300", 10)) * 1000;
const FAST_POLL_INTERVAL_MS = 60_000;
const FAST_POLL_DECAY_MS = 10 * 60 * 1000;

const TRACKED_MODELS = new Set([
  "google/gemma-4-31b-it",
  "zai-org/glm-5.1",
  "zai-org/glm-5.2",
  "moonshotai/kimi-k2.6",
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelSnapshot {
  id: string;
  name: string;
  tps: number | null;
  ttfb_seconds: number | null;
  uptime_pct: number | null;
  supply_state: string;
  discount_percent: number;
  credit_multiplier: number;
}

interface Snapshot {
  timestamp: string;
  supply_updated_at: string | null;
  window: string | null;
  window_secs: number | null;
  stale: boolean | null;
  models: Record<string, ModelSnapshot>;
}

interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
}

// ─── JSONL Store ─────────────────────────────────────────────────────────────

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendSnapshot(snapshot: Snapshot): void {
  ensureDataDir();
  fs.appendFileSync(DATA_FILE, JSON.stringify(snapshot) + "\n");
}

function readSnapshots(from?: string, to?: string): Snapshot[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  const lines = fs.readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean);
  const snapshots: Snapshot[] = [];
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;

  for (const line of lines) {
    try {
      const s = JSON.parse(line) as Snapshot;
      const ts = new Date(s.timestamp).getTime();
      if (ts >= fromMs && ts <= toMs) {
        snapshots.push(s);
      }
    } catch {
      // skip malformed lines
    }
  }
  return snapshots;
}

function getLastSnapshot(): Snapshot | null {
  if (!fs.existsSync(DATA_FILE)) return null;
  const lines = fs.readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as Snapshot;
  } catch {
    return null;
  }
}

function getSnapshotCount(): number {
  if (!fs.existsSync(DATA_FILE)) return 0;
  return fs.readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean).length;
}

// ─── Fetch from Lilac API ────────────────────────────────────────────────────

async function fetchStatus(): Promise<Snapshot | null> {
  if (!LILAC_API_KEY) {
    console.error("LILAC_API_KEY not set — cannot poll");
    return null;
  }

  try {
    const response = await fetch(STATUS_URL, {
      headers: { Authorization: `Bearer ${LILAC_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.error(`Status API error: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;

    const models: Record<string, ModelSnapshot> = {};
    const rawModels = data.models;
    if (Array.isArray(rawModels)) {
      for (const m of rawModels) {
        if (!m || typeof m !== "object" || !m.id) continue;
        if (!TRACKED_MODELS.has(m.id)) continue;
        models[m.id] = {
          id: m.id,
          name: m.name || m.id,
          tps: m.tps != null ? Number(m.tps) : null,
          ttfb_seconds: m.ttfb_seconds != null ? Number(m.ttfb_seconds) : null,
          uptime_pct: m.uptime_pct != null ? Number(m.uptime_pct) : null,
          supply_state: String(m.current_subscription_supply_state || "unknown"),
          discount_percent: Number(m.current_subscription_discount_percent ?? 0),
          credit_multiplier: parseFloat(String(m.current_subscription_credit_multiplier ?? "1")),
        };
      }
    }

    return {
      timestamp: new Date().toISOString(),
      supply_updated_at: data.current_subscription_supply_updated_at
        ? String(data.current_subscription_supply_updated_at)
        : null,
      window: data.window ? String(data.window) : null,
      window_secs: data.window_secs ? Number(data.window_secs) : null,
      stale: data.stale != null ? Boolean(data.stale) : null,
      models,
    };
  } catch (err) {
    console.error("Failed to fetch status:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchModelPricing(): Promise<Record<string, ModelPricing>> {
  if (!LILAC_API_KEY) return {};
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${LILAC_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return {};
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    const pricing: Record<string, ModelPricing> = {};
    const toPerM = (v: unknown) =>
      Math.round((typeof v === "string" ? parseFloat(v) : (v as number || 0)) * 1_000_000 * 100) / 100;
    for (const m of apiModels) {
      if (!TRACKED_MODELS.has(m.id)) continue;
      const p = m.pricing || {};
      pricing[m.id] = {
        input: toPerM(p.prompt),
        output: toPerM(p.completion),
        cache_read: toPerM(p.input_cache_read),
      };
    }
    return pricing;
  } catch {
    return {};
  }
}

// ─── Adaptive Polling ────────────────────────────────────────────────────────

let currentPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let fastPollUntil = 0;
let previousStates: Record<string, string> = {};
// Handle to the pending poll setTimeout so graceful shutdown can cancel it.
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function checkStateChange(snapshot: Snapshot): boolean {
  let changed = false;
  for (const [id, model] of Object.entries(snapshot.models)) {
    if (previousStates[id] !== undefined && previousStates[id] !== model.supply_state) {
      console.log(`  ↳ ${id}: ${previousStates[id]} → ${model.supply_state}`);
      changed = true;
    }
    previousStates[id] = model.supply_state;
  }
  return changed;
}

async function pollOnce(): Promise<void> {
  const snapshot = await fetchStatus();
  if (!snapshot) return;

  const stateChanged = checkStateChange(snapshot);

  // Deduplicate: skip if identical to last snapshot
  const last = getLastSnapshot();
  if (last) {
    const sameState = Object.entries(snapshot.models).every(
      ([id, m]) => last.models[id] && last.models[id].supply_state === m.supply_state
        && last.models[id].discount_percent === m.discount_percent
        && last.models[id].credit_multiplier === m.credit_multiplier,
    );
    if (sameState && Object.keys(snapshot.models).length === Object.keys(last.models).length) {
      // Still append — we want continuous time series for tps/ttfb/uptime too
    }
  }

  appendSnapshot(snapshot);
  const count = getSnapshotCount();
  const modelCount = Object.keys(snapshot.models).length;
  console.log(
    `[${snapshot.timestamp}] snapshot #${count} — ${modelCount} models`
    + (stateChanged ? " (state changed!)" : ""),
  );

  // Adapt polling rate
  if (stateChanged) {
    fastPollUntil = Date.now() + FAST_POLL_DECAY_MS;
  }
  if (Date.now() < fastPollUntil) {
    currentPollIntervalMs = FAST_POLL_INTERVAL_MS;
  } else {
    currentPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  }
}

function startPolling(): void {
  console.log(`Polling ${STATUS_URL} every ${currentPollIntervalMs / 1000}s for ${TRACKED_MODELS.size} models`);
  console.log(`Tracked: ${[...TRACKED_MODELS].join(", ")}`);

  // Initialize previous states from last snapshot
  const last = getLastSnapshot();
  if (last) {
    for (const [id, m] of Object.entries(last.models)) {
      previousStates[id] = m.supply_state;
    }
    console.log(`Resumed from snapshot #${getSnapshotCount()}`);
  }

  const loop = async () => {
    await pollOnce();
    pollTimer = setTimeout(loop, currentPollIntervalMs);
  };
  loop();
}

// ─── API Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(compression());
app.use(express.static(path.resolve(import.meta.dirname, "../dist")));

// GET /api/snapshots — historical snapshots
// Query params: from=ISO, to=ISO
app.get("/api/snapshots", (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const snapshots = readSnapshots(from, to);
  res.json(snapshots);
});

// GET /api/snapshots/latest — most recent snapshot
app.get("/api/snapshots/latest", (_req, res) => {
  const last = getLastSnapshot();
  if (!last) {
    res.json(null);
    return;
  }
  res.json(last);
});

// GET /api/snapshots/count — total snapshot count
app.get("/api/snapshots/count", (_req, res) => {
  res.json({ count: getSnapshotCount() });
});

// GET /api/pricing — current list prices from /v1/models
app.get("/api/pricing", async (_req, res) => {
  const pricing = await fetchModelPricing();
  res.json(pricing);
});

// GET /api/status — server health + polling status
app.get("/api/status", (_req, res) => {
  res.json({
    polling: true,
    interval_ms: currentPollIntervalMs,
    fast_mode: Date.now() < fastPollUntil,
    snapshot_count: getSnapshotCount(),
    tracked_models: [...TRACKED_MODELS],
    data_file: DATA_FILE,
  });
});

// Fallback: serve SPA for non-API routes
app.get("/{*path}", (_req, res) => {
  const indexPath = path.resolve(import.meta.dirname, "../dist/index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n  ◈ pi-lilac-tracker server running on http://localhost:${PORT}`);
  console.log(`  ◈ Data file: ${DATA_FILE}`);
  console.log(`  ◈ API: http://localhost:${PORT}/api/snapshots\n`);
  startPolling();
});

// Graceful shutdown: cancel the pending poll and close the HTTP server so the
// process exits promptly on ^C / SIGTERM, instead of lingering on the timer
// until tsx's supervisor force-kills it (the ~8s hang + "Previous process
// hasn't exited yet" warning).
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ◈ ${signal} received, shutting down...`);
  if (pollTimer) clearTimeout(pollTimer);
  server.close(() => process.exit(0));
  // If close() stalls (hung connection), don't hang forever.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
