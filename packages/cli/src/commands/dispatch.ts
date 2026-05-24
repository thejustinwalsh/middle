import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "@middle/core";
import { type StartOptions, runStart } from "./start.ts";

export type DispatchOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Override the daemon spawn (defaults to {@link runStart}). Returns its exit code. */
  startDaemon?: (opts: StartOptions) => number;
  /** Readiness-poll budget after a spawn before giving up (default 10000ms). */
  healthTimeoutMs?: number;
};

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

/**
 * Terminal/park states the client exits on, with the exit code each maps to.
 * `completed` and the review-park `waiting-human` are success (0); everything
 * else that settles is a failure (1). States not listed (`running`, `waiting`,
 * `launching`, `compensating`, …) are in-progress and keep the client streaming.
 */
const EXIT_BY_STATE: Record<string, number> = {
  completed: 0,
  "waiting-human": 0,
  failed: 1,
  compensated: 1,
  cancelled: 1,
  "rate-limited": 1,
};

/** Derive an `owner/name` slug from the repo's `origin` remote, falling back to its directory name. */
async function deriveRepoSlug(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const url = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) === 0 && url) {
    const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1]!;
  }
  return basename(repoPath);
}

/** Probe `GET /health`; true only on `{ ok: true }`. Connection errors are "down", not a throw. */
async function probeHealth(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Poll `/health` until ready or the deadline. */
async function waitForHealth(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeHealth(base)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  }
}

/** Parse a `workflow` SSE frame's data payload, or null if it isn't one. */
function parseWorkflowFrame(frame: string): { id: string; state: string } | null {
  if (!/(^|\n)event: workflow(\n|$)/.test(frame)) return null;
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  try {
    const data = JSON.parse(dataLine.slice("data:".length).trim()) as { id?: unknown; state?: unknown };
    if (typeof data.id === "string" && typeof data.state === "string") {
      return { id: data.id, state: data.state };
    }
  } catch {
    // ignore a malformed frame
  }
  return null;
}

/**
 * Follow `/control/events`, filtered to `workflowId`, printing each transition.
 * Returns the exit code once the workflow settles or parks; SIGINT aborts the
 * stream and exits 0 **without** touching the daemon's work.
 */
async function streamUntilSettled(base: string, workflowId: string): Promise<number> {
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.on("SIGINT", onSigint);
  let reader: ReturnType<NonNullable<Response["body"]>["getReader"]> | undefined;
  try {
    const res = await fetch(`${base}/control/events`, { signal: ac.signal });
    if (!res.ok || !res.body) {
      console.error(`mm dispatch: could not open the event stream (status ${res.status})`);
      return 1;
    }
    const r = res.body.getReader();
    reader = r;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        const evt = parseWorkflowFrame(frame);
        if (!evt || evt.id !== workflowId) continue;
        console.log(`mm dispatch: ${workflowId} → ${evt.state}`);
        const code = EXIT_BY_STATE[evt.state];
        if (code !== undefined) return code;
      }
    }
    console.error(`mm dispatch: event stream ended before workflow ${workflowId} settled`);
    return 1;
  } catch (error) {
    if (ac.signal.aborted) {
      // SIGINT: the daemon keeps the work; we just stop following it.
      console.log(`mm dispatch: detached — ${workflowId} continues on the daemon`);
      return 0;
    }
    console.error(`mm dispatch: lost the event stream — ${(error as Error).message}`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    // Release the connection — we've decided; the daemon owns the work past here.
    await reader?.cancel().catch(() => {});
  }
}

/**
 * `mm dispatch <repo> <epic>` — dispatch an Epic (or standalone issue) through
 * the daemon's control plane. Validates inputs, ensures the daemon is up
 * (auto-starting it if not), `POST`s `/control/dispatch`, then streams
 * `/control/events` until the workflow settles or parks. Returns a process exit
 * code: 0 when the workflow completes or parks for review, 1 otherwise.
 */
export async function runDispatch(
  repoPath: string,
  epicArg: string,
  opts: DispatchOptions = {},
): Promise<number> {
  const epicNumber = Number(epicArg);
  if (!Number.isInteger(epicNumber) || epicNumber < 1) {
    console.error(`mm dispatch: invalid epic number "${epicArg}"`);
    return 1;
  }
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm dispatch: "${repoPath}" is not a git repository`);
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ globalPath: opts.configPath });
  } catch (error) {
    console.error(`mm dispatch: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const adapterName = config.global.defaultAdapter;
  if (adapterName !== "claude") {
    console.error(
      `mm dispatch: only the 'claude' adapter is available in Phase 1 (config asks for "${adapterName}")`,
    );
    return 1;
  }

  const repoSlug = await deriveRepoSlug(repoPath);
  const base = `http://127.0.0.1:${config.global.dispatcherPort}`;

  // Ensure the daemon is up. If /health is down, spawn it and poll until ready.
  // A "already running" return from the spawn is NOT fatal — the health poll is
  // the authority (it absorbs the two-clients race).
  if (!(await probeHealth(base))) {
    const startDaemon = opts.startDaemon ?? runStart;
    startDaemon({});
    const ready = await waitForHealth(base, opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    if (!ready) {
      console.error(`mm dispatch: dispatcher did not become ready on ${base}`);
      return 1;
    }
  }

  // Dispatch on the daemon's engine.
  let workflowId: string;
  try {
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: repoSlug, repoPath: resolve(repoPath), epicNumber, adapter: adapterName }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`mm dispatch: dispatch rejected (${res.status})${detail ? ` — ${detail}` : ""}`);
      return 1;
    }
    const body = (await res.json()) as { workflowId?: unknown };
    if (typeof body.workflowId !== "string") {
      console.error(`mm dispatch: dispatcher returned no workflow id`);
      return 1;
    }
    workflowId = body.workflowId;
  } catch (error) {
    console.error(`mm dispatch: could not reach dispatcher — ${(error as Error).message}`);
    return 1;
  }

  console.log(`mm dispatch: ${repoSlug} epic #${epicNumber} → workflow ${workflowId}`);
  return streamUntilSettled(base, workflowId);
}
