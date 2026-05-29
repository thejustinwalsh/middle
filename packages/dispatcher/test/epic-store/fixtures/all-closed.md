<!-- middle:epic v1 -->
# CodexAdapter

<!-- middle:meta
slug: codex-adapter
adapter: claude
complexity_ceiling: 3
approved: false
labels: [phase:10, dogfood]
closed: true
-->

## Context

Phase 10 of the build spec. Implement a second AgentAdapter (Codex CLI) and
prove the abstraction holds across both adapters.

## Acceptance criteria

- [x] Codex agent dispatches end-to-end against a test issue
- [x] Per-CLI adapter selection respects label + default + rate-limit rules
- [x] A test exercises both adapters through the same workflow path

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [x] **1 — Implement the CodexAdapter** *(done in wf_oyy4c4m1 sha abc1234)*
  Full AgentAdapter: launch command, installHooks (.codex/config.toml),
  rollout-transcript reads, sentinel + rate-limit stop classification.
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=2 -->
- [x] **2 — Per-CLI adapter selection (implementer + recommender)** *(done in wf_oyy4c4m1 sha def5678)*
  selectAdapter rules: label override → default → rate-limit switch → skip.
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=3 -->
- [x] **3 — Verify the abstraction holds across both adapters** *(done in wf_g4mduxju sha 9012345)*
  Cross-adapter conformance test driving both through one workflow path.
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
