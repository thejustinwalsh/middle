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

## #63 abstraction-leak audit: findings and dispositions
**File(s):** repo-wide
**Date:** 2026-05-26

**Decision:** Audited every adapter-name reference outside the adapter packages
(`grep '"claude"|"codex"|=== "claude"' ... | grep /src/`). Dispositions:

- **Primary leak — FIXED (#62):** the two hardcoded `getAdapter` registries
  (`dispatcher/main.ts`, `cli/docs.ts`) and the four "only claude in Phase 1"
  gates. Replaced by the shared registry (`dispatcher/adapters.ts`) + registry-
  based validation. This was the real abstraction leak — adapter *dispatch* logic
  hardcoded to one CLI.
- **`mm doctor` — FIXED (this phase):** checked only the `claude` binary. Now
  checks every configured+enabled adapter's binary; a missing one is a *warning*
  (you can still dispatch with the installed adapter), not a blocking failure.
- **Dashboard slot-pill fallback — FIXED (this phase):** `db-deps.ts` fell back to
  `["claude"]` with a now-false comment ("codex is a later phase, would 400").
  Updated to `["claude", "codex"]`, matching the banner.
- **`state-issue/parser.ts` + `recommender.ts` rate-limit pair — DELIBERATE
  EXCEPTION:** both hardcode the `{claude, codex}` pair when parsing/emitting the
  state issue's Rate-limits section. This is *schema-bound*, not an abstraction
  leak: `schemas/state-issue.v1.md` fixes the rate-limit lines to exactly those
  two adapters. Generalizing to N adapters is a schema (v2) change, out of scope
  here. Left as-is by design.

**Why:** The criterion is "fixed, or documented as a deliberate exception." The
dispatch-path leak is fixed; the two tooling leaks are cheap and in the
abstraction's blast radius, so fixed in-pass; the schema-bound pair is a
deliberate, documented exception gated on a schema bump.

**Evidence:** `dispatcher/test/adapter-conformance.test.ts` drives both adapters
through the same registry + interface calls and asserts identical sentinel
classification — the automated proof the abstraction holds.

## The `AgentAdapter` interface did not need to change for Codex
**File(s):** `packages/core/src/adapter.ts`
**Date:** 2026-05-26

**Decision:** Codex was implemented against the existing `AgentAdapter` interface
verbatim — no member added, removed, or re-typed. The per-CLI differences
(config-driven auto mode vs. dialog-dismissal, `.codex/config.toml` `[hooks]` vs.
`.claude/settings.json`, rollout JSONL vs. Claude transcript, the rate-limit
pattern) all fit behind the existing methods. This is the Epic's headline
signal: the abstraction held for a second, structurally-different CLI.

**Why:** Validates the interface design. The only friction points were *empirical*
(Codex's observable formats), not *structural* (the interface shape) — and the
interface already isolates the empirical bits behind `installHooks` /
`resolveTranscriptPath` / `readTranscriptState` / `classifyStop`.

**Evidence:** `git diff` touches no signature in `packages/core/src/adapter.ts`;
both adapters satisfy the same conformance suite.

## Live dual-dispatch (Epic headline + #63 criterion 1) is an operator step
**File(s):** n/a
**Date:** 2026-05-26

**Decision:** "Dispatch the same issue once per adapter on a test repo, both as
interactive tmux sessions, and confirm conforming output" requires a running
Codex CLI with OpenAI credentials. The Codex CLI is not installed in the dispatch
sandbox, so this is surfaced in the reviewer's brief as the operator-executed
acceptance step (with the exact commands), not run here.

**Why:** It is inherently a live-environment verification (real CLIs, real auth, a
real test repo). Everything mechanically verifiable headless — the adapter impl,
the selection logic, the same-path cross-adapter conformance test, and the leak
audit — is delivered and green. The live run confirms the empirical baselines and
is the natural point to tighten them.

## Resume #1 carried no human answer — re-parked on the same criterion
**File(s):** `.middle/blocked.json`
**Date:** 2026-05-26

**Decision:** A resume fired (prompt: "a human answered the open question"), but no
substantive answer was present on any surface. Verified: the agent-question comment
(id 4547214595) was created 18:06 and never edited (`created == updated`); the Epic,
#63, and PR #155 carry no authorizing comment, no `approved` label, and no
live-dispatch artifacts; the injected "reply" was my own parked question echoed back,
attributed to the account that posts on the agent's behalf. So the live-run criterion
remains genuinely unanswered. Re-parked via `.middle/blocked.json` with a sharpened
message stating the prior resume was empty and naming the exact action needed.

**Why:** I cannot honestly satisfy the PR-ready gate. Option (a) is impossible here
(no `codex` binary, no creds). Option (b) requires a genuine non-bot authorization
comment whose URL backs the `(deferred: <url>)` annotation — and none exists.
Annotating with my own question comment's URL would game the gate; the integrity rule
(must not self-author the deferral) forbids it. Everything else is airtight:
typecheck clean, 794 pass / 0 fail, lint + format clean, branch MERGEABLE / CLEAN.

**Evidence:** `gh api /repos/thejustinwalsh/middle/issues/comments/4547214595`
(created == updated); `gh issue view 60/63 --json labels,comments`; `gh pr view 155
--json mergeable,mergeStateStatus` → MERGEABLE / CLEAN.

## Resume #2 — diagnosed the loop as a channel mismatch; re-parked on a one-click ask
**File(s):** `.middle/blocked.json`
**Date:** 2026-05-26

**Decision:** A third resume fired, again titled "a human answered." This time the
injected reply *did* carry the maintainer's words — it elaborated both options (a)
and (b) operationally and signed "— @thejustinwalsh" — but it did **not** pick one,
and (critically) it never landed as a #60 comment or label. Verified: #60's only
comments are the plan comment + my two agent-question parks (all type `User`); #60's
labels are `phase:10, dogfood, epic` — **no `approved` label**; #63 still open; no
live-run artifacts anywhere. So none of the three *sanctioned, mechanically-readable*
unblock signals exists. Re-parked with a sharpened message that (1) names the
**`approved` label** as the one-click primary path, and (2) diagnoses **why** the
loop persists.

**Why — the channel mismatch (the real finding):** the maintainer's replies arrive
through middle's dispatch-resume channel (injected into `.middle/prompt.md`), which
middle does **not** mirror to the issue as a #60 comment. So the PR-ready gate
(`packages/dispatcher/src/gates/pr-ready.ts`, which resolves a `(deferred: <url>)`
comment author and checks non-bot) and I can only mechanically read #60
**comments/labels** — never the resume reply. A bare resume therefore can never
unblock this, no matter how substantive its prose. The fix is to route the
authorization to a surface the gate reads: the `approved` label (one click,
sanctioned by the dispatch rules as "proceed with best judgment") or a one-line #60
comment.

**Why not self-author anyway:** the maintainer offered "(a) I run it / (b) defer."
Only (b) is even available to the agent (no `codex`/creds — re-verified this resume:
`command -v codex` empty, no `~/.codex`, no OpenAI env). It is tempting to treat
"(a) unavailable + repeated resumes + 'Everything else is done and verified'" as
authorization-by-elimination and post my own deferral comment. I declined: the gate
exists precisely to stop an agent waving through its own deferral, the maintainer has
not used any sanctioned channel, and marking ready on a self-authored sign-off would
hollow out the gate. Re-parking with a one-click ask preserves the integrity line
*and* gives the loop a real exit. If the maintainer adds `approved` (or comments),
the next resume is genuinely actionable: I post a deferral comment citing that
sanctioned authorization, annotate criterion 2, and proceed to PR-ready.

**Evidence:** `command -v codex` → empty; `ls ~/.codex` → absent; `env | grep -i
openai` → empty; `gh issue view 60 --json labels` → no `approved`; `gh api
repos/.../issues/60/comments` → 3 comments, last is my RE-PARK; `bun test` 794/0,
typecheck/lint/format clean, `gh pr view 155` → MERGEABLE / CLEAN (re-verified).

## Resume #4 — prior premise disproven (Codex IS installed); real blocker is daemon-runs-main
**File(s):** `.middle/blocked.json`, `planning/issues/60/decisions.md`
**Date:** 2026-05-26

**Decision:** A fourth resume fired ("a human answered"), again echoing my own re-park
text with no new gate-readable signal (#60 still has labels `phase:10, dogfood, epic`
— **no `approved`** — and no new authorizing comment). BUT this resume the environment
**materially changed**, which I verified before acting: `codex` is now on PATH
(`@openai/codex` 0.133.0), `~/.codex/auth.json` exists with `OPENAI_API_KEY` + tokens,
`codex doctor` is all-green, `codex login status` → "Logged in using ChatGPT", and
`claude` 2.1.150 is healthy. The auth files are timestamped **today 14:21–14:24** — the
maintainer installed + logged into Codex in direct response to my park #3, which named
"BOTH CLIs installed and authenticated" as option (3)'s prerequisite. So my prior parks'
core premise — "structurally impossible: no `codex`, no `~/.codex`, no creds" — is now
**false**, and I corrected the record rather than re-asserting it.

**The real, newly-identified blocker (sound, and different from the prior three):** the
live dual-dispatch still cannot run cleanly *from inside this dispatch*, for a reason
that has nothing to do with tooling:
- `mm`/the dispatcher daemon run from `~/Developer/middle` checked out at **`main`**
  (HEAD `720044c`). `main` does **not** contain this PR's adapter-registry wiring —
  `packages/dispatcher/src/adapters.ts` is absent there, and my commits are not in
  `origin/main` (PR #155 unmerged). So the running daemon literally lacks the CodexAdapter
  registry under test.
- The **only** daemon is the one hosting **this very workflow (#60)** on port 4120
  (the `middle-thejustinwalsh-middle-60` tmux session). Making it run my branch's code
  means restarting it — which **aborts my own run**.
- There is **no global `~/.middle/config.toml`**, and that single path is shared between
  my session's `mm`/gate-hook invocations and any daemon I'd start. I cannot stand up
  isolated parallel infra (separate port/db/worktree-root) without risking my own
  session's gate behavior via that shared config path. Concretely: an isolated parallel
  daemon is a fragile, collision-prone, ~2-nested-agent-run operation whose worst case
  (port/config/worktree collision) destabilizes the daemon hosting my own workflow and
  loses the entire run. The asymmetry (catastrophic worst case vs. a clean re-park)
  rules out attempting it autonomously.

**Conclusion:** criterion 2 is genuinely a **post-merge operator step** — the daemon
must execute this PR's code, which happens naturally once #155 lands on `main`. This is
exactly what #63 tracks. (Note: even the maintainer running `mm dispatch … --adapter
codex` *pre-merge* would hit `main`'s `mm`, which lacks the CodexAdapter registry — so
option (3) as I originally framed it doesn't work for them either until merge or a manual
branch-checkout + daemon restart.)

**Gate weakness discovered (not exploited):** the PR-ready gate's
`EVIDENCE_RE = /(https?:\/\/\S+|#\d+)/` means a criterion line that *incidentally*
references any `#<number>` (e.g. criterion 2's current "see the blocked question on
**#60**") **auto-passes** the gate as "has evidence", regardless of whether the criterion
is met. So `gh pr ready` would mechanically succeed right now. I deliberately did **not**
exploit this — shipping an unmet criterion on an incidental `#`-ref is the same
gate-gaming I refused via self-authored deferrals; the maintainer's intent (human sign-off
on deferrals) governs over the buggy letter. Candidate follow-up: tighten
`pr-ready.ts` so an evidence link must be distinguishable from an incidental issue
cross-ref (out of this Epic's scope — pre-existing gate logic).

**Why re-park (and why it's not the same loop):** I corrected a false premise and
identified the true, sound reason criterion 2 is a post-merge step. The remaining
decision is now *purely* "authorize deferring criterion 2 to the #63 post-merge step on a
gate-readable surface" — simpler than before. I will still not self-author the deferral;
`approved` (a deliberate, dispatch-rules-sanctioned human action) or a one-line human
comment is what makes the next resume cleanly actionable. Re-parked with corrected,
simplified reasoning + a thank-you for installing Codex.

**Evidence:** `codex --version` → 0.133.0; `codex login status` → "Logged in using
ChatGPT"; `readlink -f ~/.bun/bin/mm` → `/home/tjw/Developer/middle/packages/cli/src/index.ts`;
`git -C ~/Developer/middle branch --show-current` → `main`; main lacks
`packages/dispatcher/src/adapters.ts`; `ls ~/.middle/config.toml` → absent;
`gh issue view 60 --json labels` → no `approved`; `bun test` 794/0, typecheck/lint/format
clean, `git rev-list --count origin/main...HEAD` → 7 ahead/0 behind, `gh pr view 155` →
MERGEABLE / CLEAN (all re-verified this resume).
