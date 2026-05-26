# Verification Gates — `verify.toml` Schema v1

Per-repo declaration of the **verification gates** the dispatcher runs after an
agent ticks a phase's PR Status checkbox. The dispatcher loads this file from the
workstream's worktree at `<worktree>/.middle/verify.toml` — the same per-repo
operational location as `.middle/config.toml` (installed locally; not committed
into the target repo).

This file is the **source of truth** for the schema. `verify-config.ts`
(`loadVerifyConfig`, `gatesForPhase`, validation) conforms to it — not the other
way around.

## Top-level structure

A TOML file with **at least one** `[[gate]]` array-of-tables entry. A file with
no gates, a missing file, or any malformed entry **fails loudly** with a clear
message — the dispatcher never silently runs zero gates.

```toml
# .middle/verify.toml

[[gate]]
name = "typecheck"
command = "bun run typecheck"

[[gate]]
name = "test"
command = "bun test"
timeout_seconds = 600

[[gate]]
name = "acceptance"
command = "bun run scripts/acceptance.ts"
phases = [40, 41]

[[gate]]
name = "smoke"
command = "bun run test:smoke"
category = "integration"
```

## `[[gate]]` fields

| Key | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Gate identifier. Non-empty, trimmed, **unique** across all gates. Shown in evidence and in the checkbox-revert comment. |
| `command` | string | yes | Shell command run in the worktree (via `sh -c`). Non-empty. A non-zero exit, or a timeout, fails the gate. |
| `timeout_seconds` | number | no | Per-gate wall-clock bound. Positive. Defaults to **300** (5 min). A gate exceeding it is killed and recorded as failed (timed out). |
| `phases` | array of int | no | Sub-issue numbers this gate is scoped to. When present, the gate runs **only** for those phases. When absent, the gate runs for **every** phase. Each entry is a positive integer. |
| `category` | string | no | `"unit"` (default) or `"integration"`. An `integration` gate exercises the **running product** — it boots/serves/invokes the real path, distinct from unit gates. The integration-verified definition of done (Epic #143) uses this to recognise that a repo declares an integration gate; `integrationGates(config)` returns them. |

Unknown keys on a `[[gate]]` are rejected (to catch typos like `comand`). A `category` other than `unit`/`integration` is rejected.

## Gate categories

`category = "integration"` marks a gate as exercising the real product (the daemon
boots and is hit over HTTP; the CLI runs end-to-end), as opposed to a `unit` gate that
tests a function in isolation. It is the verify-side companion to the PR-ready gate's
integration-evidence check: a feature phase is expected to add an integration test that
runs the real path, not stop at green unit tests.

## Per-phase addressing

The checkbox-revert reconciler runs "phase N's gates" where N is the sub-issue
whose checkbox transitioned `[ ] → [x]`. `gatesForPhase(config, N)` returns, in
declared order, every gate whose `phases` is absent **or** contains `N`. A repo
that wants the same gates for every phase simply omits `phases` everywhere.

## Validation (fails loudly)

`loadVerifyConfig(path)` throws a `VerifyConfigError` with a message naming the
problem when:

- the file is missing or unreadable;
- the TOML is syntactically invalid;
- there is no `[[gate]]` entry;
- a gate is missing `name` or `command`, or either is empty/blank;
- two gates share a `name`;
- `timeout_seconds` is present but not a positive number;
- `phases` is present but not an array of positive integers;
- a gate carries an unknown key.
