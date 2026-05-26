/**
 * The adapter registry — the single map from adapter name to its `AgentAdapter`
 * implementation. Every dispatch path (implementation, recommender, docs,
 * watchdog, control routes) resolves its adapter object through `getAdapter`,
 * and the control plane validates a requested name through `isKnownAdapter`, so
 * adding a CLI is one entry here rather than a hardcode per call site.
 */
import { claudeAdapter } from "@middle/adapter-claude";
import { codexAdapter } from "@middle/adapter-codex";
import type { AgentAdapter } from "@middle/core";

const REGISTRY: Readonly<Record<string, AgentAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** The names of every implemented adapter. */
export function knownAdapters(): string[] {
  return Object.keys(REGISTRY);
}

/** Whether `name` resolves to an implemented adapter. */
export function isKnownAdapter(name: string): boolean {
  return Object.hasOwn(REGISTRY, name);
}

/**
 * Resolve an adapter object by name. Throws `unknown adapter: <name>` (listing
 * the known set) when the name isn't implemented — callers that prefer a
 * non-throwing check guard with {@link isKnownAdapter} first.
 */
export function getAdapter(name: string): AgentAdapter {
  const adapter = REGISTRY[name];
  if (adapter === undefined) {
    throw new Error(`unknown adapter: ${name} (known: ${knownAdapters().join(", ")})`);
  }
  return adapter;
}
