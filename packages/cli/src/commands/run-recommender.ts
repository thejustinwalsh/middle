import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "@middle/core";
import { runStart, type StartOptions } from "./start.ts";

export type RunRecommenderOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Override the daemon spawn (defaults to {@link runStart}). Returns its exit code. */
  startDaemon?: (opts: StartOptions) => number;
  /** Readiness-poll budget after a spawn before giving up (default 10000ms). */
  healthTimeoutMs?: number;
  /** Probe the daemon's `/health` (injectable for tests; defaults to a real fetch). */
  probeHealth?: (base: string) => Promise<boolean>;
  /** POST the recommender trigger (injectable for tests; defaults to a real fetch). */
  trigger?: (base: string, repoPath: string) => Promise<{ status: number; body: string }>;
};

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

/** Probe `GET /health`; true only on `{ ok: true }`. Connection errors are "down", not a throw. */
async function probeHealthDefault(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Poll `/health` (via `probe`) until ready or the deadline. */
async function waitForHealth(
  base: string,
  timeoutMs: number,
  probe: (base: string) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe(base)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

/** POST `/trigger/recommender` with the repo's checkout path; relay status + body. */
async function triggerDefault(
  base: string,
  repoPath: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/trigger/recommender`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoPath }),
  });
  return { status: res.status, body: (await res.text().catch(() => "")).trim() };
}

/**
 * `mm run-recommender <repo>` — trigger a recommender run **through the daemon**,
 * exactly like `mm dispatch`: a thin client that auto-starts the dispatcher if
 * it's down, then POSTs `/trigger/recommender`. The run executes on the daemon's
 * long-lived engine (not a standalone second engine that collides with the
 * daemon's port). The daemon validates the repo (state issue, schema, adapter)
 * and resolves per-repo settings; this command relays its verdict. Returns a
 * process exit code: 0 when the run is accepted (202), 1 otherwise.
 */
export async function runRecommender(
  repoPath: string,
  opts: RunRecommenderOptions = {},
): Promise<number> {
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm run-recommender: "${repoPath}" is not a git repository`);
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ globalPath: opts.configPath });
  } catch (error) {
    console.error(`mm run-recommender: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const base = `http://127.0.0.1:${config.global.dispatcherPort}`;

  // Ensure the daemon is up — auto-start it if not, same as `mm dispatch`.
  const probe = opts.probeHealth ?? probeHealthDefault;
  if (!(await probe(base))) {
    (opts.startDaemon ?? runStart)({});
    const ready = await waitForHealth(
      base,
      opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      probe,
    );
    if (!ready) {
      console.error(`mm run-recommender: dispatcher did not become ready on ${base}`);
      return 1;
    }
  }

  let result: { status: number; body: string };
  try {
    result = await (opts.trigger ?? triggerDefault)(base, resolve(repoPath));
  } catch (error) {
    console.error(
      `mm run-recommender: could not reach the dispatcher — ${(error as Error).message}`,
    );
    return 1;
  }

  if (result.status !== 202) {
    console.error(
      `mm run-recommender: dispatch rejected (${result.status})${result.body ? ` — ${result.body}` : ""}`,
    );
    return 1;
  }

  console.log(
    `mm run-recommender: ${resolve(repoPath)} → recommender run started on ${base} — watch it with \`mm status\` or the dashboard`,
  );
  return 0;
}
