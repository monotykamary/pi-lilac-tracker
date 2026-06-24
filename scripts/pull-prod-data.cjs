/**
 * Pull production snapshots into the local dev data file.
 *
 * Dev runs aren't 24/7, so local data/snapshots.jsonl goes stale. Production
 * (Railway) polls continuously and serves the full series at /api/snapshots.
 * This fetches that series and updates the local dev file — without ever
 * writing anywhere git tracks, so upstream stays clean.
 *
 * Usage:
 *   node scripts/pull-prod-data.cjs            # incremental: append only rows newer than local's newest
 *   node scripts/pull-prod-data.cjs --reset    # replace local with the full prod series
 *   node scripts/pull-prod-data.cjs --force    # allow writing to a git-tracked path (use with care)
 *
 * Env:
 *   PROD_URL   production base URL (default: https://pi-lilac-tracker.up.railway.app)
 *   DATA_FILE  local target JSONL (default: ./data/snapshots.jsonl)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROD_URL = (process.env.PROD_URL || "https://pi-lilac-tracker.up.railway.app").replace(/\/$/, "");
const TARGET = path.resolve(process.env.DATA_FILE || "./data/snapshots.jsonl");
const RESET = process.argv.includes("--reset");
const FORCE = process.argv.includes("--force");

const REPO_ROOT = path.resolve(__dirname, "..");

// "yes" if git ignores the path, "no" if git tracks it, "unknown" if git is unavailable.
function gitIgnoreStatus(file) {
  try {
    execFileSync("git", ["check-ignore", "--quiet", file], { cwd: REPO_ROOT, stdio: "ignore" });
    return "yes";
  } catch (err) {
    return err && err.code === "ENOENT" ? "unknown" : "no";
  }
}

function tsOf(s) {
  if (!s || typeof s.timestamp !== "string") return -Infinity;
  const t = Date.parse(s.timestamp);
  return Number.isNaN(t) ? -Infinity : t;
}

function readLocal() {
  if (!fs.existsSync(TARGET)) return { count: 0, maxTs: -Infinity };
  const lines = fs.readFileSync(TARGET, "utf8").split("\n").filter(Boolean);
  let maxTs = -Infinity;
  for (const line of lines) {
    try {
      const t = tsOf(JSON.parse(line));
      if (t > maxTs) maxTs = t;
    } catch {
      // skip malformed lines
    }
  }
  return { count: lines.length, maxTs };
}

async function fetchProd() {
  const url = `${PROD_URL}/api/snapshots`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error(`expected an array, got ${typeof arr}`);
  return arr;
}

function ensureDir() {
  const dir = path.dirname(TARGET);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteAll(rows) {
  ensureDir();
  const tmp = `${TARGET}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, TARGET);
}

function appendRows(rows) {
  ensureDir();
  fs.appendFileSync(TARGET, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function main() {
  console.log(`prod:  ${PROD_URL}`);
  console.log(`local: ${TARGET}`);
  console.log(`mode:  ${RESET ? "reset (replace local with prod series)" : "incremental (append newer only)"}`);

  // Upstream-pollution guard: never write to a path this repo tracks.
  const inRepo = TARGET === REPO_ROOT || TARGET.startsWith(REPO_ROOT + path.sep);
  if (inRepo && !FORCE) {
    const st = gitIgnoreStatus(TARGET);
    const safeByPath = TARGET.startsWith(path.join(REPO_ROOT, "data") + path.sep);
    if (st === "no" || (st === "unknown" && !safeByPath)) {
      console.error(`\nRefusing to write to a git-tracked path: ${TARGET}`);
      console.error("data/ is gitignored for exactly this reason — keep dev data there.");
      console.error("Set DATA_FILE=./data/snapshots.jsonl, or pass --force if you truly mean it.");
      process.exit(1);
    }
  }

  const local = readLocal();
  console.log(
    `local before: ${local.count} rows` +
    (local.maxTs > -Infinity ? `, newest ${new Date(local.maxTs).toISOString()}` : " (empty)"),
  );

  const prod = await fetchProd();
  if (prod.length === 0) {
    console.error("prod returned 0 rows — leaving local untouched.");
    process.exit(1);
  }
  const prodMax = prod.reduce((m, s) => Math.max(m, tsOf(s)), -Infinity);
  console.log(`prod:         ${prod.length} rows, newest ${new Date(prodMax).toISOString()}`);

  if (RESET) {
    atomicWriteAll(prod);
    console.log(`local after:  ${prod.length} rows, newest ${new Date(prodMax).toISOString()}`);
    console.log("done (reset).");
    return;
  }

  const seen = new Set();
  const newer = [];
  for (const s of prod) {
    const t = tsOf(s);
    if (t <= local.maxTs) continue;
    if (seen.has(s.timestamp)) continue;
    seen.add(s.timestamp);
    newer.push(s);
  }

  if (newer.length === 0) {
    console.log("already up to date — nothing newer on prod.");
    return;
  }

  appendRows(newer);
  console.log(`appended ${newer.length} rows (through ${new Date(prodMax).toISOString()}).`);
  console.log(`local after:  ${local.count + newer.length} rows, newest ${new Date(prodMax).toISOString()}`);
  console.log("done.");
}

main().catch((err) => {
  console.error("pull failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
