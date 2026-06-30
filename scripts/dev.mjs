/**
 * Dev launcher for pi-lilac-tracker.
 *
 * Wraps the usual `concurrently "npm run dev:server" "npm run dev:web"` so that
 * `pnpm run dev` can run without the API key living in .env: if LILAC_API_KEY
 * isn't already in the environment, it is resolved from the localterm secret
 * `lilac_api_key` (read from the macOS Keychain via the localterm CLI) and
 * injected into the child processes' environment. The key then survives tsx
 * watch reloads because it lives in the parent env.
 *
 * Resolution order:
 *   1. process.env.LILAC_API_KEY (shell env / exported in the user's shell)
 *   2. localterm secret `lilac_api_key` (only when the daemon is reachable)
 *
 * The server's own dotenv import uses override:false, so it will not clobber a
 * value we inject here; a real value in .env still works as a final fallback if
 * neither source is available. Production (pnpm start / build) is untouched and
 * keeps reading the key from the environment directly.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_NAME = "lilac_api_key";
const ENV_VAR = "LILAC_API_KEY";
const DEFAULT_PORT = 3417;
const HEALTH_TIMEOUT_MS = 1500;

const DEV_COMMANDS = '"npm run dev:server" "npm run dev:web"';

function log(msg) {
  console.log(`  ◈ ${msg}`);
}

function localtermPort() {
  const portFile = join(homedir(), ".localterm", "server.port");
  try {
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, "utf8").trim(), 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
  } catch {
    // ignore — fall back to default
  }
  return DEFAULT_PORT;
}

async function localtermReachable() {
  const base = `http://127.0.0.1:${localtermPort()}/api`;
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return json?.ok === true;
  } catch {
    return false;
  }
}

function getLocaltermSecret(name) {
  return new Promise((resolve) => {
    const child = spawn("localterm", ["secret", "get", name], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        if (stderr.trim()) log(`localterm secret get failed: ${stderr.trim()}`);
        resolve(null);
        return;
      }
      const value = stdout.trim();
      resolve(value || null);
    });
  });
}

async function resolveApiKey() {
  const existing = process.env[ENV_VAR];
  if (existing && existing.trim()) {
    log(`${ENV_VAR} already set in environment — using it`);
    return;
  }
  log(`${ENV_VAR} not set in env, checking localterm...`);
  if (!(await localtermReachable())) {
    log("localterm daemon not reachable — falling back to .env / server defaults");
    return;
  }
  const value = await getLocaltermSecret(SECRET_NAME);
  if (!value) {
    log(`could not read localterm secret "${SECRET_NAME}" — falling back to .env`);
    return;
  }
  process.env[ENV_VAR] = value;
  log(`resolved ${ENV_VAR} from localterm secret "${SECRET_NAME}"`);
}

async function main() {
  await resolveApiKey();
  log("starting dev processes (server + web)...\n");

  // Forward any extra args (e.g. `pnpm run dev -- --foo`) to concurrently.
  const extraArgs = process.argv.slice(2).join(" ");
  const command = `concurrently ${DEV_COMMANDS}${extraArgs ? ` ${extraArgs}` : ""}`;

  const child = spawn(command, {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });

  child.on("error", (err) => {
    console.error(`  ◈ failed to start concurrently: ${err.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

main();
