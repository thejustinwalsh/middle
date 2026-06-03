/**
 * Phase-2 file-watcher mechanics: stat-based mtime polling of `epics_dir` (no
 * `chokidar`, no extra dependency — the spec's deliberate choice). The poller
 * cron calls this on its existing 120s tick; a human editing an Epic file's
 * `<!-- middle:answer for=N -->` block to non-empty content is detected and fires
 * the resume signal exactly like a new GitHub comment does in github mode.
 *
 * Dedup is structural: only an `open` question with a non-empty answer is a
 * signal, and firing flips that question to `resolved` (via the renderer) — so a
 * later tick over the same (now-resolved) block never re-fires. The mtime gate is
 * the cheap pre-filter that skips unchanged files.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { reasonFromSignalName, type ResumeSignalPayload } from "../poller.ts";
import { findParkedWorkflowByRef, getWaitForSignal, markSignalFired } from "../workflow-record.ts";
import { readEpicFile, writeEpicFile } from "./epic-file-io.ts";

/** A newly-answered question detected on disk: which Epic, which question, the reply. */
export type FileAnswerSignal = { ref: string; questionId: number; body: string };

/** Epic slugs in `epicsDir` whose file `mtime > sinceMs` (the mtime poll). */
export function collectChangedSince(epicsDir: string, sinceMs: number): string[] {
  if (!existsSync(epicsDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(epicsDir)) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    if (statSync(join(epicsDir, name)).mtimeMs > sinceMs) out.push(name.slice(0, -".md".length));
  }
  return out;
}

/**
 * Scan `epicsDir` for Epic files changed since `sinceMs` and return one signal per
 * `open` question that now carries a non-empty answer. The parser already drops
 * the answer placeholder + empty/whitespace answers (an `answer` is set only when
 * non-empty), so a placeholder-only or empty edit yields nothing; the `open`
 * filter (paired with the caller's flip-to-`resolved`) ensures only the first
 * non-empty edit per question triggers.
 */
export function pollFileSignals(epicsDir: string, sinceMs: number): FileAnswerSignal[] {
  const out: FileAnswerSignal[] = [];
  for (const ref of collectChangedSince(epicsDir, sinceMs)) {
    const epic = readEpicFile(epicsDir, ref);
    if (!epic) continue;
    for (const entry of epic.conversation) {
      if (
        entry.kind === "question" &&
        entry.status === "open" &&
        entry.answer !== undefined &&
        entry.answer.body.trim() !== ""
      ) {
        out.push({ ref, questionId: entry.id, body: entry.answer.body });
      }
    }
  }
  return out;
}

/**
 * Flip a question's status to `resolved` in the Epic file (via the renderer — the
 * sole writer of strict markers). Idempotent: a no-op if the file/question is
 * gone or already resolved. This is the dedup write the watcher does right after
 * firing the resume, so the next tick doesn't re-fire the same answer.
 */
export function resolveQuestion(epicsDir: string, ref: string, questionId: number): void {
  const epic = readEpicFile(epicsDir, ref);
  if (!epic) return;
  let changed = false;
  const conversation = epic.conversation.map((entry) => {
    if (entry.kind === "question" && entry.id === questionId && entry.status === "open") {
      changed = true;
      return { ...entry, status: "resolved" as const };
    }
    return entry;
  });
  if (changed) writeEpicFile(epicsDir, ref, { ...epic, conversation });
}

/** Deps for one {@link runFileWatcherTick} pass. */
export type FileWatcherTickDeps = {
  db: Database;
  /** The file-mode repos to scan, each with its absolute Epic directory. */
  fileModeRepos: () => Array<{ repo: string; epicsDir: string }>;
  /** Deliver the resume signal to the engine (the daemon wires `engine.signal`). */
  fireSignal: (workflowId: string, payload: ResumeSignalPayload) => Promise<void>;
};

/**
 * One file-watcher pass over every file-mode repo (hung off the poller cron):
 * mtime-poll `epics_dir` for parked Epics whose answer block became non-empty
 * since `sinceMs`, fire each one's resume signal (`reason: "answered-question"`,
 * exactly like a new GitHub comment), mark the durable wait fired so the resume
 * poll doesn't double-fire, and flip the question to `resolved` so a later tick
 * never re-fires it. Per-repo scan failures are isolated. Returns the count fired.
 */
export async function runFileWatcherTick(
  deps: FileWatcherTickDeps,
  sinceMs: number,
): Promise<number> {
  let fired = 0;
  for (const { repo, epicsDir } of deps.fileModeRepos()) {
    let signals: FileAnswerSignal[];
    try {
      signals = pollFileSignals(epicsDir, sinceMs);
    } catch (error) {
      console.error(`[file-watcher] ${repo} scan failed: ${(error as Error).message}`);
      continue;
    }
    for (const sig of signals) {
      const workflowId = findParkedWorkflowByRef(deps.db, repo, sig.ref);
      if (workflowId === null) continue;
      // Only resume a workflow that is actually parked on a question (its armed
      // signal is the `answered` one) — an answer edit must not resume a workflow
      // parked for some other reason (e.g. review-changes), mirroring the github
      // poller's reason-keyed dispatch.
      const armed = getWaitForSignal(deps.db, workflowId);
      if (!armed || reasonFromSignalName(armed.signalName) !== "answered-question") continue;
      await deps.fireSignal(workflowId, {
        reason: "answered-question",
        reply: { commentId: sig.questionId, authorLogin: "human", body: sig.body },
      });
      markSignalFired(deps.db, workflowId);
      resolveQuestion(epicsDir, sig.ref, sig.questionId);
      fired += 1;
    }
  }
  return fired;
}
