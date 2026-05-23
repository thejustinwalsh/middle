import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Claude hook events mapped to the normalized taxonomy, in settings.json order.
 * Mirrors the dispatch-time map in `@middle/adapter-claude`'s `installHooks`;
 * the two are intentionally the same shape (bootstrap writes a static config,
 * dispatch re-writes it per-worktree with the same events). Source of truth:
 * build spec → "Normalized event taxonomy".
 */
const CLAUDE_EVENT_MAP: ReadonlyArray<[claudeEvent: string, normalized: string]> = [
  ["SessionStart", "session.started"],
  ["UserPromptSubmit", "turn.started"],
  ["PreToolUse", "tool.pre"],
  ["PostToolUse", "tool.post"],
  ["Notification", "agent.notification"],
  ["Stop", "agent.stopped"],
  ["SubagentStop", "agent.stopped"],
  ["SessionEnd", "session.ended"],
];

type HookGroup = { hooks: Array<{ type: "command"; command: string }> };
type SettingsShape = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/** The hook command string for one event — an absolute, double-quoted path. */
function hookCommand(scriptPath: string, normalized: string): string {
  return `"${scriptPath}" ${normalized}`;
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as SettingsShape) : {};
  } catch {
    return {};
  }
}

/**
 * Write `<repo>/.claude/settings.json` with a hook entry per taxonomy event,
 * each invoking `"<abs>/hook.sh" <normalized>`. Preserves any pre-existing keys
 * (and non-middle hook entries) in the file. Absolute path so Claude resolves
 * the hook regardless of the agent's cwd; double-quoted for paths with spaces.
 */
export async function writeClaudeHookSettings(repo: string, scriptPath: string): Promise<void> {
  const path = join(repo, ".claude", "settings.json");
  const settings = readSettings(path);
  const hooks = settings.hooks ?? {};
  for (const [claudeEvent, normalized] of CLAUDE_EVENT_MAP) {
    const others = (hooks[claudeEvent] ?? []).filter(
      (g) => !g.hooks.some((h) => h.command.includes(scriptPath)),
    );
    hooks[claudeEvent] = [
      ...others,
      { hooks: [{ type: "command", command: hookCommand(scriptPath, normalized) }] },
    ];
  }
  settings.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Remove only middle's hook entries (those referencing `scriptPath`) from
 * `.claude/settings.json`, leaving any other entries/keys intact. Drops the
 * `hooks` key if it empties, and deletes the file if nothing else remains.
 */
export async function stripClaudeHookSettings(repo: string, scriptPath: string): Promise<boolean> {
  const path = join(repo, ".claude", "settings.json");
  if (!existsSync(path)) return false;
  const settings = readSettings(path);
  const hooks = settings.hooks;
  if (!hooks) return false;

  for (const [claudeEvent] of CLAUDE_EVENT_MAP) {
    const groups = hooks[claudeEvent];
    if (!groups) continue;
    const remaining = groups.filter((g) => !g.hooks.some((h) => h.command.includes(scriptPath)));
    if (remaining.length === 0) delete hooks[claudeEvent];
    else hooks[claudeEvent] = remaining;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  if (Object.keys(settings).length === 0) {
    await rm(path, { force: true });
  } else {
    await Bun.write(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return true;
}

// Sentinel-delimited block for the Codex TOML config. Codex's hook-config schema
// is a Phase-10 concern; until then we write a clearly-bounded block so uninit
// can strip it precisely without parsing/round-tripping arbitrary TOML.
const CODEX_BEGIN = "# >>> middle hooks (managed) >>>";
const CODEX_END = "# <<< middle hooks (managed) <<<";

function codexHookBlock(scriptPath: string): string {
  const lines = CLAUDE_EVENT_MAP.map(
    ([, normalized]) => `# ${normalized} -> "${scriptPath}" ${normalized}`,
  );
  return [
    CODEX_BEGIN,
    "[hooks]",
    `command = "${scriptPath}"`,
    "# events forwarded (normalized taxonomy):",
    ...lines,
    CODEX_END,
    "",
  ].join("\n");
}

/** Append (or replace) middle's `[hooks]` block in `<repo>/.codex/config.toml`. */
export async function writeCodexHookConfig(repo: string, scriptPath: string): Promise<void> {
  const path = join(repo, ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stripped = stripCodexBlock(existing);
  const sep = stripped === "" || stripped.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${stripped}${sep}${codexHookBlock(scriptPath)}`);
}

function stripCodexBlock(content: string): string {
  if (!content.includes(CODEX_BEGIN)) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === CODEX_BEGIN) {
      inside = true;
      continue;
    }
    if (line === CODEX_END) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** Remove middle's `[hooks]` block from `.codex/config.toml`; delete if empty. */
export async function stripCodexHookConfig(repo: string): Promise<boolean> {
  const path = join(repo, ".codex", "config.toml");
  if (!existsSync(path)) return false;
  const stripped = stripCodexBlock(readFileSync(path, "utf8")).trim();
  if (stripped === "") await rm(path, { force: true });
  else await Bun.write(path, `${stripped}\n`);
  return true;
}
