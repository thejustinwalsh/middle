// @middle/core — shared types, schemas, adapter interface, config loader.
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
  MiddleConfig,
  LoadConfigOptions,
} from "./config.ts";
export { loadConfig } from "./config.ts";

export type { NormalizedEvent, HookPayload, HookEnvelope } from "./events.ts";
export { NORMALIZED_EVENTS, isNormalizedEvent } from "./events.ts";

export { HOOK_SH } from "./hook-script.ts";

export type {
  AgentAdapter,
  InstallHookOpts,
  LaunchOpts,
  TranscriptState,
  StopClassification,
  RateLimitDetection,
} from "./adapter.ts";

export { capturePane, sendText, sendKeys, pollPaneFor } from "./tmux-tui.ts";
export type { SendKeysOpts, PollPaneOpts } from "./tmux-tui.ts";
