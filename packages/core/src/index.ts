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
