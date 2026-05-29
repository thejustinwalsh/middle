<!-- middle:epic v1 -->
# CodexAdapter

<!-- middle:meta
slug: codex-adapter
adapter: claude
complexity_ceiling: 3
approved: false
labels: [phase:10, dogfood]
-->

## Context

Phase 10 of the build spec. Implement a second AgentAdapter (Codex CLI) and
prove the abstraction holds across both adapters.

## Acceptance criteria

- [ ] Codex agent dispatches end-to-end against a test issue
- [ ] Per-CLI adapter selection respects label + default + rate-limit rules
- [ ] A test exercises both adapters through the same workflow path

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — Implement the CodexAdapter**
  Full AgentAdapter: launch command, installHooks (.codex/config.toml),
  rollout-transcript reads, sentinel + rate-limit stop classification.
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=2 -->
- [ ] **2 — Per-CLI adapter selection (implementer + recommender)**
  selectAdapter rules: label override → default → rate-limit switch → skip.
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=3 -->
- [ ] **3 — Verify the abstraction holds across both adapters**
  Cross-adapter conformance test driving both through one workflow path.
<!-- /middle:sub-issue -->

<!-- middle:conversation -->

<!-- middle:dispatch-event ts=2026-05-29T04:28:40.000Z kind=dispatched -->
Dispatched workflow `wf_oyy4c4m1` on branch `middle-epic-codex-adapter`, draft PR #155.
<!-- /middle:dispatch-event -->

<!-- middle:question id=1 status=open ts=2026-05-29T04:53:30.000Z kind=question -->
Should I defer the live dual-dispatch criterion (criterion 2) to a post-merge
operator step, or run it now via a fresh test repo?

<!-- middle:answer for=1 -->
<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->
<!-- /middle:answer -->
<!-- /middle:question -->

<!-- /middle:conversation -->
