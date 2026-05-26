# Decisions — Issue #60 (CodexAdapter)

## Codex's observable behaviors are implemented as the spec's "start generous" baseline
**File(s):** `packages/adapters/codex/src/*`
**Date:** 2026-05-26

**Decision:** The Codex CLI is not installed in the dispatch sandbox (no `codex`
binary, no `~/.codex`, no OpenAI credentials). The adapter is implemented from the
build spec's "CodexAdapter specifics" + "Normalized event taxonomy" tables, with
every empirically-observed bit (hook event names, transcript location/format,
rate-limit message, force-include syntax, auto-mode mechanism) coded as the spec's
documented starting point and marked as a tightening point.

**Why:** The spec explicitly defers these to the Codex phase ("observed during the
Codex phase", "filled in during Phase 10", rate-limit regex "to be tightened as
patterns are observed"). The `AgentAdapter` interface is designed precisely so these
swappable bits live behind it. Blocking the whole Epic on an un-installable CLI would
strand the adapter impl + selection logic, which are fully specified and testable.

**Evidence:** Build spec lines 790–815 (CodexAdapter specifics + event taxonomy);
ClaudeAdapter as the structural template.

## Codex hook event → normalized event mapping
**File(s):** `packages/adapters/codex/src/hooks.ts`
**Date:** 2026-05-26

**Decision:** Mirror Claude's `CLAUDE_EVENT_MAP` with Codex's event names from the
taxonomy table's "Trigger (Codex)" column:
`startup→session.started`, `turn-start→turn.started`, `command→tool.pre`,
`command-success→tool.post`, `command-failure→tool.failed`, `turn-end→agent.stopped`,
`shutdown→session.ended`. No `agent.notification` / `agent.subagent-stopped` (Codex
has no equivalent per the table). Written into `<worktree>/.codex/config.toml` as a
`[hooks]` array-of-tables (`[[hooks.<event>]]` with a `command` key) so multiple
hooks can share one event (the heartbeat + the PR-ready gate on `command`).

**Why:** Direct read of the spec's taxonomy table. Array-of-tables is the simplest
TOML shape that supports >1 hook per event, which the `command` (pre) event needs.

**Evidence:** Build spec lines 803–814 (taxonomy), 790–795 (CodexAdapter specifics).

## classifyStop sentinel logic is adapter-agnostic (only the rate-limit regex differs)
**File(s):** `packages/adapters/codex/src/classify.ts`
**Date:** 2026-05-26

**Decision:** Codex's `classifyStop` resolves the `.middle/{blocked,done,failed}.json`
sentinels identically to Claude — that logic is not Codex-specific. Only the
rate-limit regex changes: `/rate.?limit|429|too many requests/i` (spec's generous
starting pattern). Noted as a #63 candidate to extract the shared sentinel logic into
`@middle/core`.

**Why:** The sentinel files are written by the universal skill, not the CLI, so their
resolution is the same for every adapter. Duplicating it now keeps #61 self-contained;
#63 is where cross-adapter shared logic gets factored.

**Evidence:** Build spec line 795 (Codex rate-limit pattern); Claude `classify.ts`.
