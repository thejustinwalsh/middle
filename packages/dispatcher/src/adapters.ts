/**
 * The adapter registry — the single map from adapter name to its `AgentAdapter`
 * implementation. Every dispatch path (implementation, recommender, docs,
 * watchdog, control routes) resolves its adapter object through `getAdapter`,
 * and the control plane validates a requested name through `isKnownAdapter`, so
 * adding a CLI is one entry here rather than a hardcode per call site.
 */
import { claudeAdapter } from "@middle/adapter-claude";
import { codexAdapter } from "@middle/adapter-codex";
import { copilotAdapter } from "@middle/adapter-copilot";
import type { AgentAdapter } from "@middle/core";

// `Map` (not a plain object) so lookups never resolve inherited keys: an
// attacker-controlled name like `toString` or `constructor` would otherwise hit
// `Object.prototype` and bypass `getAdapter`'s `undefined` guard, returning a
// non-`AgentAdapter` value to callers that validate names by side-effecting
// `getAdapter`.
const REGISTRY = new Map<string, AgentAdapter>([
  ["claude", claudeAdapter],
  ["codex", codexAdapter],
  ["copilot", copilotAdapter],
]);

/** The names of every implemented adapter. */
export function knownAdapters(): string[] {
  return [...REGISTRY.keys()];
}

/** Whether `name` resolves to an implemented adapter. */
export function isKnownAdapter(name: string): boolean {
  return REGISTRY.has(name);
}

/**
 * Resolve an adapter object by name. Throws `unknown adapter: <name>` (listing
 * the known set) when the name isn't implemented — callers that prefer a
 * non-throwing check guard with {@link isKnownAdapter} first.
 */
export function getAdapter(name: string): AgentAdapter {
  const adapter = REGISTRY.get(name);
  if (adapter === undefined) {
    throw new Error(`unknown adapter: ${name} (known: ${knownAdapters().join(", ")})`);
  }
  return adapter;
}
