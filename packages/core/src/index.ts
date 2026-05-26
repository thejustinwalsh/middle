/**
 * @packageDocumentation
 * @module @middle/core
 *
 * Shared types, schemas, the adapter interface, and the config loader — the
 * foundation every other middle package imports from.
 *
 * Public surface:
 * - `loadConfig` — merge the config layers into a typed `MiddleConfig`
 * - `AgentAdapter` — the interface each agent adapter implements
 * - normalized hook events: `NormalizedEvent`, `HookEnvelope`, `isNormalizedEvent`
 * - `HOOK_SH`, `PR_READY_GATE_SH` — the hook shell-script payloads
 * - tmux-TUI helpers: `capturePane`, `sendText`, `sendKeys`, `pollPaneFor`
 * - integration rubric: `auditIssueBody`, `isIntegrationCriterion`, `parseAcceptanceCriteria`
 *
 * Where things live:
 * - `config.ts` — config schema + `loadConfig`
 * - `adapter.ts` — `AgentAdapter` + option/result types
 * - `events.ts` — the normalized hook-event vocabulary
 * - `hook-script.ts` — the hook shell scripts adapters install
 * - `tmux-tui.ts` — low-level tmux pane capture / key sending
 * - `integration-rubric.ts` — the shared "integration criterion" predicate (Epic #143)
 *
 * Gotchas:
 * - `loadConfig` merges four layers, lowest→highest precedence: documented
 *   defaults < global file < committed `policy.toml` < local `config.toml`
 *   (issue #103). Policy is derived as the sibling of the `repoPath` callers pass.
 *
 * claude-md: false
 */
export type {
  RepoConfig,
  AdapterConfig,
  GlobalSettings,
  DashboardSettings,
  RepoSettings,
  LimitsSettings,
  RecommenderSettings,
  StateIssueSettings,
  BootstrapSettings,
  DocsSettings,
  MiddleConfig,
  LoadConfigOptions,
} from "./config.ts";
export { loadConfig } from "./config.ts";

export type { NormalizedEvent, HookPayload, HookEnvelope } from "./events.ts";
export { NORMALIZED_EVENTS, isNormalizedEvent } from "./events.ts";

export { HOOK_SH, PR_READY_GATE_SH } from "./hook-script.ts";

export type {
  AgentAdapter,
  BuildPromptOpts,
  InstallHookOpts,
  LaunchOpts,
  TranscriptState,
  StopClassification,
  BlockedSentinel,
  RateLimitDetection,
} from "./adapter.ts";

export { capturePane, sendText, sendKeys, pollPaneFor } from "./tmux-tui.ts";
export type { SendKeysOpts, PollPaneOpts } from "./tmux-tui.ts";

export {
  auditIssueBody,
  isIntegrationCriterion,
  isFeatureIssue,
  parseAcceptanceCriteria,
  detectExemption,
  NON_FEATURE_LABELS,
} from "./integration-rubric.ts";
export type { RubricFinding } from "./integration-rubric.ts";
