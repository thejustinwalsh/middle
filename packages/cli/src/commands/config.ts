import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ConfigOptions = {
  /** Override the per-repo config path (defaults to `<repoPath>/.middle/config.toml`). */
  configFile?: string;
};

/**
 * The keys `mm config` can set, with where they live and how the value is
 * validated/normalized. v1 ships only `auto_dispatch`; the table is the
 * extension point for further keys.
 */
const SETTABLE: Record<string, { section: string; normalize: (raw: string) => string | null }> = {
  auto_dispatch: {
    section: "recommender",
    normalize: (raw) => (raw === "true" || raw === "false" ? raw : null),
  },
};

/**
 * Set `key = value` within `[section]`, preserving the rest of the file
 * byte-for-byte (comments, ordering, unrelated keys). Replaces the key in place
 * if present in that section, inserts it just under the section header if the
 * section exists, or appends a fresh section. The match is scoped to the target
 * section so an identically-named key in another section is never touched.
 */
function setTomlKey(source: string, section: string, key: string, value: string): string {
  const lines = source.split("\n");
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  // Escape the key — `SETTABLE` is the extension point, and a future key with
  // regex metacharacters must match literally, not as a pattern.
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^(\\s*)${escapedKey}\\s*=`);
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = headerRe.exec(lines[i]!);
    if (m && m[1] === section) {
      sectionStart = i;
      break;
    }
  }
  const assignment = `${key} = ${value}`;
  if (sectionStart === -1) {
    // No such section — append it. Keep exactly one blank line of separation.
    const trimmed = source.replace(/\n+$/, "");
    return `${trimmed}\n\n[${section}]\n${assignment}\n`;
  }
  // Scan the section body (until the next header or EOF) for the key.
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (headerRe.test(lines[i]!)) break; // next section — key absent in this one
    if (keyRe.test(lines[i]!)) {
      lines[i] = lines[i]!.replace(keyRe, `$1${key} =`).replace(/=.*/, `= ${value}`);
      return lines.join("\n");
    }
  }
  // Section exists but lacks the key — insert right after the header.
  lines.splice(sectionStart + 1, 0, assignment);
  return lines.join("\n");
}

/**
 * `mm config <repo> <key> <value>` — set a per-repo config value in
 * `<repo>/.middle/config.toml`, preserving the file's comments and layout. v1
 * supports `auto_dispatch <true|false>` (the `[recommender]` toggle the
 * auto-dispatch loop reads). Returns a process exit code: 0 on success, 1 on error.
 */
export function runConfig(
  repoPath: string,
  key: string,
  value: string,
  opts: ConfigOptions = {},
): number {
  const spec = SETTABLE[key];
  if (!spec) {
    const known = Object.keys(SETTABLE).join(", ");
    console.error(`mm config: unknown key "${key}" (settable keys: ${known})`);
    return 1;
  }
  const normalized = spec.normalize(value);
  if (normalized === null) {
    console.error(`mm config: invalid value "${value}" for ${key}`);
    return 1;
  }
  const configFile = opts.configFile ?? join(repoPath, ".middle", "config.toml");
  if (!existsSync(configFile)) {
    console.error(`mm config: no config at ${configFile} (run \`mm init\` first)`);
    return 1;
  }
  try {
    const updated = setTomlKey(readFileSync(configFile, "utf8"), spec.section, key, normalized);
    writeFileSync(configFile, updated);
    console.log(`mm config: set ${spec.section}.${key} = ${normalized}`);
    return 0;
  } catch (error) {
    console.error(`mm config: ${(error as Error).message}`);
    return 1;
  }
}
