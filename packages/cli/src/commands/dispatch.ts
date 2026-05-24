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

/** The minimal slice of a stream reader the follower uses (avoids the BYOB-overload type). */
type FrameReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};

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
    const data = JSON.parse(dataLine.slice("data:".length).trim()) as {
      id?: unknown;
      state?: unknown;
    };
    if (typeof data.id === "string" && typeof data.state === "string") {
      return { id: data.id, state: data.state };
    }
  } catch {
    // ignore a malformed frame
  }
  return null;
}

/**
 * Drain an already-open `/control/events` stream, filtered to `workflowId`,
 * printing each transition and returning the exit code once the workflow settles
 * or parks. `ac` is the shared abort controller — on SIGINT the caller aborts it,
 * which surfaces here as a clean detach (exit 0), leaving the daemon's work alone.
 *
 * The stream MUST already be subscribed before the dispatch was POSTed (see
 * `runDispatch`): a fast-failing workflow can emit its terminal frame on the
 * next tick, and init-replay omits terminal states, so a subscribe-after-POST
 * would miss it and block forever on the heartbeat-kept-alive stream.
 */
async function followWorkflow(
  reader: FrameReader,
  workflowId: string,
  ac: AbortController,
): Promise<number> {
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
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
  }
}

/**
 * `mm dispatch <repo> <epic>` — dispatch an Epic (or standalone issue) through
 * the daemon's control plane. Validates inputs, ensures the daemon is up
 * (auto-starting it if not), subscribes to `/control/events`, `POST`s
 * `/control/dispatch`, then follows the stream until the workflow settles or
 * parks. Returns a process exit code: 0 when the workflow completes or parks for
 * review, 1 otherwise.
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

  // One abort controller spans both the dispatch POST and the event stream, so a
  // SIGINT during either detaches cleanly without killing the daemon's work.
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.on("SIGINT", onSigint);
  let reader: FrameReader | undefined;
  try {
    // Subscribe to the event stream BEFORE dispatching. A fast-failing workflow
    // can emit its terminal frame on the next tick, and init-replay omits
    // terminal states — subscribing after the POST would race and miss it.
    let events: Response;
    try {
      events = await fetch(`${base}/control/events`, { signal: ac.signal });
    } catch (error) {
      if (ac.signal.aborted) return 0;
      console.error(`mm dispatch: could not reach dispatcher — ${(error as Error).message}`);
      return 1;
    }
    if (!events.ok || !events.body) {
      console.error(`mm dispatch: could not open the event stream (status ${events.status})`);
      return 1;
    }
    reader = events.body.getReader();

    // Dispatch on the daemon's engine.
    let workflowId: string;
    try {
      const res = await fetch(`${base}/control/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: repoSlug,
          repoPath: resolve(repoPath),
          epicNumber,
          adapter: adapterName,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(
          `mm dispatch: dispatch rejected (${res.status})${detail ? ` — ${detail}` : ""}`,
        );
        return 1;
      }
      const body = (await res.json()) as { workflowId?: unknown };
      if (typeof body.workflowId !== "string") {
        console.error(`mm dispatch: dispatcher returned no workflow id`);
        return 1;
      }
      workflowId = body.workflowId;
    } catch (error) {
      if (ac.signal.aborted) return 0;
      console.error(`mm dispatch: could not reach dispatcher — ${(error as Error).message}`);
      return 1;
    }

    console.log(`mm dispatch: ${repoSlug} epic #${epicNumber} → workflow ${workflowId}`);
    return await followWorkflow(reader, workflowId, ac);
  } finally {
    process.off("SIGINT", onSigint);
    // Release the connection — we've decided; the daemon owns the work past here.
    await reader?.cancel().catch(() => {});
  }
}
