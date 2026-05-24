/**
 * Gate runner (Phase 6, build-spec item #31).
 *
 * Executes each declared {@link Gate} inside the workstream's worktree, captures
 * its exit code / stdout / stderr, and bounds it with a per-gate timeout. Gates
 * run in declared order; the runner reports per-gate pass/fail plus an aggregate.
 */
import type { Gate } from "./verify-config.ts";

/** The outcome of running one gate. */
export type GateResult = {
  name: string;
  command: string;
  /** Process exit code; null when the gate was killed (e.g. timed out). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the gate exceeded its timeout and was killed. */
  timedOut: boolean;
  /** A gate passes only on a clean exit-0 (a timeout is a failure). */
  passed: boolean;
  durationMs: number;
};

/** The aggregate of running a phase's gates in order. */
export type GateRunReport = {
  results: GateResult[];
  /** True only when every gate passed. */
  ok: boolean;
  /** The first failing gate's name, for the checkbox-revert comment. */
  failedGate?: string;
};

export type RunOpts = {
  /** The worktree directory the gate command runs in. */
  cwd: string;
};

// On a timeout we SIGKILL the shell, but a still-running grandchild can keep the
// output pipe's write end open, so the stream never EOFs. Bound stream
// collection so a runaway child can never hang the runner; on a clean exit the
// streams have already EOF'd, so this resolves at once with the full output.
// (Trade-off: a timed-out gate's grandchild is left to exit on its own — rare,
// and reaped by init. We don't process-group-kill, to stay portable across the
// Linux/macOS hosts middle runs on and to keep compound-command semantics.)
const STREAM_DRAIN_GRACE_MS = 500;

function raceWithGrace(p: Promise<string>): Promise<string> {
  return Promise.race([
    p,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), STREAM_DRAIN_GRACE_MS)),
  ]);
}

/** Run a single gate to completion (or timeout), capturing its output. */
export async function runGate(gate: Gate, opts: RunOpts): Promise<GateResult> {
  const started = Date.now();
  const proc = Bun.spawn(["sh", "-c", gate.command], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, gate.timeoutSeconds * 1000);

  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const [stdout, stderr] = await Promise.all([raceWithGrace(stdoutP), raceWithGrace(stderrP)]);

  // A signal-kill surfaces as a non-zero / null exit; normalize a timed-out
  // gate's exitCode to null so callers don't read a misleading code.
  const passed = !timedOut && exitCode === 0;
  return {
    name: gate.name,
    command: gate.command,
    exitCode: timedOut ? null : exitCode,
    stdout,
    stderr,
    timedOut,
    passed,
    durationMs: Date.now() - started,
  };
}

/** Run a phase's gates in declared order; report per-gate results + aggregate. */
export async function runGates(gates: Gate[], opts: RunOpts): Promise<GateRunReport> {
  const results: GateResult[] = [];
  let failedGate: string | undefined;
  for (const gate of gates) {
    const result = await runGate(gate, opts);
    results.push(result);
    if (!result.passed && failedGate === undefined) failedGate = result.name;
  }
  const report: GateRunReport = { results, ok: failedGate === undefined };
  if (failedGate !== undefined) report.failedGate = failedGate;
  return report;
}
