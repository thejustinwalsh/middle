# Adapters

An adapter is the interface every coding-agent CLI sits behind. middle dispatches every agent as an interactive `tmux` session — there is no headless mode — so the adapter abstracts the per-CLI launch command, the text to send into the session, how to enter auto mode, and how to read and classify the on-disk transcript. This is a reference for that contract. The source of truth is `packages/core/src/adapter.ts`.

## The `AgentAdapter` interface

```ts
export interface AgentAdapter {
  readonly name: string; // 'claude' | 'codex' | ...

  /** Write hook config + any per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the INTERACTIVE launch command. tmux runs this; it takes no prompt. */
  buildLaunchCommand(opts: LaunchOpts): { argv: string[]; env: Record<string, string> };

  /** The literal text to send-keys into the session to start or continue the agent. */
  buildPromptText(opts: BuildPromptOpts): string;

  /** Put the ready session into auto mode — a launch flag or post-ready keystrokes. */
  enterAutoMode(opts: { sessionName: string }): Promise<void>;

  /** The normalized event that signals the CLI is ready for input. */
  readonly readyEvent: NormalizedEvent;

  /** Locate the on-disk session transcript from the ready/session hook payload. */
  resolveTranscriptPath(payload: HookPayload): string;

  /** Read activity, state, and context/token usage from the transcript. */
  readTranscriptState(transcriptPath: string): TranscriptState;

  /** Classify the agent's state at a Stop hook. */
  classifyStop(opts: {
    payload: HookPayload;
    transcriptPath: string;
    sentinelPresent: boolean;
    worktree: string;
  }): StopClassification;

  /** Optional: detect a rate-limit message in a Stop-hook payload or transcript. */
  detectRateLimit?(opts: { payload: HookPayload; transcriptPath: string }): RateLimitDetection | null;
}
```

## Methods

| Member | Contract |
|---|---|
| `name` | The adapter's identifier (`'claude'`), matched against `default_adapter` and the per-Epic adapter choice. |
| `installHooks` | Writes the hook config and any per-CLI setup into the worktree before launch. |
| `buildLaunchCommand` | Returns the `argv` + `env` for the **interactive** CLI. `tmux` runs it; it takes no prompt. |
| `buildPromptText` | Returns the literal text to `send-keys` into the session to start or continue the agent. |
| `enterAutoMode` | Puts a ready session into auto mode — a launch flag or post-ready keystrokes. |
| `readyEvent` | The normalized hook event that means the CLI is ready for input. |
| `resolveTranscriptPath` | Locates the on-disk transcript from the ready/session hook payload. |
| `readTranscriptState` | Reads activity, turn count, and token usage from the transcript. |
| `classifyStop` | Classifies a `Stop` hook into one of the `StopClassification` outcomes. |
| `detectRateLimit` | Optional. Detects a rate-limit message and returns when the limit resets. |

## Prompt kinds

`buildPromptText` takes a discriminated union on `kind`, so the `kind`/`epicNumber` coupling is enforced at compile time:

```ts
export type BuildPromptOpts =
  | { promptFile: string; kind: "initial" | "resume" | "answer"; epicNumber: number }
  | { promptFile: string; kind: "recommender" | "docs"; epicNumber?: never };
```

The dispatched-issue kinds (`initial`, `resume`, `answer`) carry an `epicNumber`. The repo-level kinds (`recommender`, `docs`) run against no Epic and must omit it — the union makes `kind: "initial"` without an Epic a compile error rather than a malformed `implement #undefined` prompt.

## Stop classification

`classifyStop` resolves the agent's state at each turn boundary. `worktree` is the workstream root where `.middle/` lives — sentinel files resolve from there, never from `payload.cwd`, which may be a subdirectory the agent has `cd`'d into.

```ts
export type StopClassification =
  | { kind: "done" } // agent marked the PR ready
  | { kind: "asked-question"; sentinelPath: string; sentinel: BlockedSentinel | null }
  | { kind: "rate-limited"; resetAt: string /* ISO */ }
  | { kind: "bare-stop" } // stopped, no sentinel, not done
  | { kind: "failed"; reason: string };
```

The `asked-question` sentinel is `.middle/blocked.json`, parsed tolerantly — a missing or malformed file yields `null` rather than failing the Stop:

```ts
export type BlockedSentinel = {
  question: string;
  context?: string;
  kind?: "question" | "complexity"; // "complexity" marks a complexity pause; absent = plain question
};
```

See [skill-enforcement.md](skill-enforcement.md) for how the dispatcher acts on each classification.

## Adapter selection

The dispatcher resolves an adapter by name through a registry in `packages/dispatcher/src/main.ts`. A repo's default comes from `global.default_adapter`; an Epic can be dispatched against a specific adapter.

## Shipped adapters

- **`@middle/adapter-claude`** — shipped. It implements the full interface for Claude Code: `installHooks` writes `.claude/settings.json`, `readyEvent` is the `SessionStart` hook, `classifyStop` reads the `.middle/` sentinels, and `detectRateLimit` matches Claude's usage-limit message.
- **`@middle/adapter-codex`** — a stub on the roadmap. Its bootstrap hook config is written by `mm init`, but the `AgentAdapter` implementation is not yet complete; the dispatcher's registry currently accepts only `claude`.
