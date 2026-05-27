# `mm` root script + `mm doctor` bun-PATH check & fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let contributors run `mm` with zero PATH setup (`bun run mm …`), and make `mm doctor` detect + optionally fix the missing Bun global-bin-dir on `$PATH`.

**Architecture:** A new pure-function module `packages/cli/src/checks/bun-path.ts` does all PATH/shell-rc reasoning (testable, no real env or rc mutation in tests); `doctor.ts` adds a warn-level `checkBunPath()` and a `--fix` action that writes the export to the active shell's rc; `index.ts` exposes `--fix`; the root `package.json` gains an `mm` script.

**Tech Stack:** Bun (≥1.3.12), TypeScript, `bun:test`, commander. Import specifiers use `.ts` extensions (intentional — see root CLAUDE.md).

---

## File Structure

- **Create** `packages/cli/src/checks/bun-path.ts` — PATH detection, shell-rc resolution, snippet generation, idempotent rc write. Pure functions + two thin effectful wrappers.
- **Create** `packages/cli/test/bun-path.test.ts` — unit tests for the pure functions and `applyPathFix` against a tmp file.
- **Modify** `packages/cli/src/commands/doctor.ts` — add `checkBunPath()`; change `runDoctor` to accept `{ fix?: boolean }` and run the fix when warned.
- **Modify** `packages/cli/src/index.ts` — add `.option("--fix", …)` to `doctor`, thread into `runDoctor`.
- **Modify** root `package.json` — add `"mm"` script.

---

## Task 1: `mm` root script

**Files:**
- Modify: `package.json` (root) — `scripts` block

- [ ] **Step 1: Add the script**

In root `package.json`, add to `"scripts"` (alphabetical-ish, after `"lint"`):

```jsonc
    "mm": "bun packages/cli/src/index.ts",
```

- [ ] **Step 2: Verify it forwards args**

Run: `bun run mm version`
Expected: prints `0.0.0` (the CLI `version` command).

Run: `bun run mm doctor`
Expected: the existing `middle — system check` report renders (no `--fix` yet).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(cli): add root \`mm\` script so \`bun run mm\` works without bun link"
```

---

## Task 2: `bun-path.ts` — pure detection functions (TDD)

**Files:**
- Create: `packages/cli/src/checks/bun-path.ts`
- Test: `packages/cli/test/bun-path.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/bun-path.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  bunPathSnippet,
  isDirOnPath,
  rcAlreadyConfigured,
  resolveShellRc,
} from "../src/checks/bun-path.ts";

describe("isDirOnPath", () => {
  test("true when present", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "/usr/bin:/home/u/.bun/bin:/bin")).toBe(true);
  });
  test("false when absent", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "/usr/bin:/bin")).toBe(false);
  });
  test("tolerates trailing slashes on either side", () => {
    expect(isDirOnPath("/home/u/.bun/bin/", "/usr/bin:/home/u/.bun/bin")).toBe(true);
    expect(isDirOnPath("/home/u/.bun/bin", "/home/u/.bun/bin/:/bin")).toBe(true);
  });
  test("false on empty PATH", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "")).toBe(false);
  });
});

describe("resolveShellRc", () => {
  test("zsh", () => {
    expect(resolveShellRc("/bin/zsh", "/home/u")).toEqual({
      shell: "zsh",
      rcPath: "/home/u/.zshrc",
    });
  });
  test("bash", () => {
    expect(resolveShellRc("/usr/bin/bash", "/home/u")).toEqual({
      shell: "bash",
      rcPath: "/home/u/.bashrc",
    });
  });
  test("unknown shell", () => {
    expect(resolveShellRc("/bin/sh", "/home/u")).toEqual({ unknown: true });
    expect(resolveShellRc(undefined, "/home/u")).toEqual({ unknown: true });
  });
});

describe("bunPathSnippet", () => {
  test("HOME-relative form when dir is the canonical ~/.bun/bin", () => {
    const snippet = bunPathSnippet("/home/u/.bun/bin", "/home/u");
    expect(snippet).toContain('export BUN_INSTALL="$HOME/.bun"');
    expect(snippet).toContain('export PATH="$BUN_INSTALL/bin:$PATH"');
    expect(snippet.startsWith("# bun")).toBe(true);
  });
  test("literal form when dir is non-canonical", () => {
    const snippet = bunPathSnippet("/opt/bun/bin", "/home/u");
    expect(snippet).toContain('export PATH="/opt/bun/bin:$PATH"');
    expect(snippet).not.toContain("BUN_INSTALL");
  });
});

describe("rcAlreadyConfigured", () => {
  test("detects literal bin dir", () => {
    expect(rcAlreadyConfigured('export PATH="/home/u/.bun/bin:$PATH"', "/home/u/.bun/bin")).toBe(
      true,
    );
  });
  test("detects BUN_INSTALL form", () => {
    expect(rcAlreadyConfigured('export PATH="$BUN_INSTALL/bin:$PATH"', "/home/u/.bun/bin")).toBe(
      true,
    );
  });
  test("false on unrelated rc", () => {
    expect(rcAlreadyConfigured("export PATH=/usr/bin:$PATH\n", "/home/u/.bun/bin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/test/bun-path.test.ts`
Expected: FAIL — `Cannot find module "../src/checks/bun-path.ts"` (file not created yet).

- [ ] **Step 3: Implement the module**

Create `packages/cli/src/checks/bun-path.ts`:

```ts
/**
 * PATH/shell-rc reasoning for the `mm doctor` bun-path check.
 *
 * The root cause this module addresses: Bun's global bin dir
 * (`bun pm bin -g` → `~/.bun/bin`, where `bun link` drops the `mm` symlink) is
 * not on `$PATH` under a Homebrew Bun install. The pure functions below let
 * `doctor.ts` detect that and write the canonical export into the right rc file.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Strip a single trailing slash so `/x/` and `/x` compare equal. */
function normalizeDir(dir: string): string {
  return dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir;
}

/** True iff `dir` appears (trailing-slash-insensitively) in a `:`-joined PATH. */
export function isDirOnPath(dir: string, pathEnv: string): boolean {
  const target = normalizeDir(dir);
  return pathEnv
    .split(":")
    .filter((entry) => entry.length > 0)
    .some((entry) => normalizeDir(entry) === target);
}

/**
 * Bun's global bin dir — `bun pm bin -g` if it succeeds, else `~/.bun/bin`.
 * The fallback matches Bun's default and is what Homebrew installs leave behind.
 */
export async function getBunGlobalBinDir(): Promise<string> {
  const fallback = join(homedir(), ".bun", "bin");
  const bun = Bun.which("bun");
  if (!bun) return fallback;
  try {
    const proc = Bun.spawn(["bun", "pm", "bin", "-g"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && out.length > 0) return out;
  } catch {
    // fall through to the default
  }
  return fallback;
}

/** Where to add the PATH export, resolved from `$SHELL`. */
export type ShellRc = { shell: "zsh" | "bash"; rcPath: string } | { unknown: true };

/** zsh → `~/.zshrc`, bash → `~/.bashrc`, anything else → `{ unknown: true }`. */
export function resolveShellRc(shell: string | undefined, home: string): ShellRc {
  if (!shell) return { unknown: true };
  if (shell.endsWith("zsh")) return { shell: "zsh", rcPath: join(home, ".zshrc") };
  if (shell.endsWith("bash")) return { shell: "bash", rcPath: join(home, ".bashrc") };
  return { unknown: true };
}

/**
 * The shell block to append. Emits the canonical Bun-installer form when
 * `binDir` is the default `~/.bun/bin`, else a literal single-line PATH export.
 */
export function bunPathSnippet(binDir: string, home: string): string {
  const canonical = join(home, ".bun", "bin");
  if (normalizeDir(binDir) === normalizeDir(canonical)) {
    return '# bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"';
  }
  return `# bun\nexport PATH="${binDir}:$PATH"`;
}

/** True if the rc already wires `binDir` onto PATH (idempotency guard). */
export function rcAlreadyConfigured(rcContents: string, binDir: string): boolean {
  return rcContents.includes(binDir) || rcContents.includes("$BUN_INSTALL/bin");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/test/bun-path.test.ts`
Expected: PASS — all `isDirOnPath`/`resolveShellRc`/`bunPathSnippet`/`rcAlreadyConfigured` cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/checks/bun-path.ts packages/cli/test/bun-path.test.ts
git commit -m "feat(cli): bun-path detection helpers for doctor"
```

---

## Task 3: `applyPathFix` — idempotent rc write (TDD)

**Files:**
- Modify: `packages/cli/src/checks/bun-path.ts`
- Modify: `packages/cli/test/bun-path.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/bun-path.test.ts` (add imports `applyPathFix` to the top import block, and these node imports):

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyPathFix } from "../src/checks/bun-path.ts";

describe("applyPathFix", () => {
  const snippet = '# bun\nexport PATH="/x/.bun/bin:$PATH"';

  test("appends once and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunpath-"));
    const rcPath = join(dir, ".zshrc");
    try {
      writeFileSync(rcPath, "export PATH=/usr/bin:$PATH\n");

      const first = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(first).toEqual({ changed: true });
      expect(readFileSync(rcPath, "utf8")).toContain("/x/.bun/bin");

      const second = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(second).toEqual({ changed: false });
      // the snippet appears exactly once
      const matches = readFileSync(rcPath, "utf8").split("/x/.bun/bin").length - 1;
      expect(matches).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates content when the rc file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunpath-"));
    const rcPath = join(dir, ".bashrc"); // not created
    try {
      const result = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(result).toEqual({ changed: true });
      expect(readFileSync(rcPath, "utf8")).toContain("/x/.bun/bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/test/bun-path.test.ts`
Expected: FAIL — `applyPathFix` is not exported.

- [ ] **Step 3: Implement `applyPathFix`**

Append to `packages/cli/src/checks/bun-path.ts` (add `existsSync, readFileSync, appendFileSync` to a `node:fs` import at the top):

```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Append `snippet` to the rc at `rcPath` unless `binDir` is already wired on
 * PATH there. Reads the file (treats a missing file as empty), so the write is
 * idempotent across repeated `mm doctor --fix` runs.
 */
export function applyPathFix(args: {
  rcPath: string;
  snippet: string;
  binDir: string;
}): { changed: boolean } {
  const existing = existsSync(args.rcPath) ? readFileSync(args.rcPath, "utf8") : "";
  if (rcAlreadyConfigured(existing, args.binDir)) return { changed: false };
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(args.rcPath, `${prefix}\n${args.snippet}\n`);
  return { changed: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/cli/test/bun-path.test.ts`
Expected: PASS — all `applyPathFix` cases green, alongside the Task 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/checks/bun-path.ts packages/cli/test/bun-path.test.ts
git commit -m "feat(cli): idempotent applyPathFix for shell rc"
```

---

## Task 4: Wire `checkBunPath` + `--fix` into `mm doctor`

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add the import + check to `doctor.ts`**

At the top of `packages/cli/src/commands/doctor.ts`, add to the imports:

```ts
import { homedir } from "node:os";
import {
  applyPathFix,
  bunPathSnippet,
  getBunGlobalBinDir,
  isDirOnPath,
  resolveShellRc,
} from "../checks/bun-path.ts";
```

Add this check function (after `checkBinary`, before `checkGhAuth`):

```ts
/**
 * Flag when Bun's global bin dir (where `bun link` drops the `mm` symlink) is
 * not on `$PATH`. A **warning**, not a fail: `mm` is still runnable via
 * `bun run mm`. The motivating case is a Homebrew Bun install, which never adds
 * `~/.bun/bin` to the shell rc the way the `curl | bash` installer does.
 */
async function checkBunPath(): Promise<Check> {
  const binDir = await getBunGlobalBinDir();
  if (isDirOnPath(binDir, process.env.PATH ?? "")) {
    return { name: "bun PATH", status: "pass", detail: `${binDir} on PATH` };
  }
  return {
    name: "bun PATH",
    status: "warn",
    detail: `${binDir} not on PATH — globally-linked binaries like \`mm\` are invisible; run \`mm doctor --fix\``,
  };
}
```

- [ ] **Step 2: Thread `--fix` through `runDoctor`**

Change the `runDoctor` signature and add the bun-path check to the array:

```ts
export async function runDoctor({ fix }: { fix?: boolean } = {}): Promise<number> {
  const checks: Check[] = [
    await checkBinary("bun", ["bun", "--version"]),
    await checkBunPath(),
    await checkTmux(),
    await checkBinary("claude", ["claude", "--version"]),
    await checkBinary("git", ["git", "--version"]),
    await checkBinary("gh", ["gh", "--version"]),
    await checkGhAuth(),
    checkSkillsDrift(),
    checkModuleIndexFrontmatter(),
    checkTsdocCoverageWarn(),
  ];
```

Then, immediately **after** the `for` loop that prints the checks and its trailing
`console.log("")`, add the fix handling:

```ts
  if (fix) {
    await runBunPathFix();
  }
```

And add the helper at the bottom of the file (before or after `runDoctor`):

```ts
/**
 * `mm doctor --fix` action: if Bun's global bin dir is off `$PATH`, append the
 * PATH export to the active shell's rc (`$SHELL` → `~/.zshrc` / `~/.bashrc`).
 * Prints manual instructions when the shell is unrecognized; a no-op otherwise.
 */
async function runBunPathFix(): Promise<void> {
  const binDir = await getBunGlobalBinDir();
  if (isDirOnPath(binDir, process.env.PATH ?? "")) {
    console.log("--fix: bun PATH already correct — nothing to fix.");
    return;
  }
  const home = homedir();
  const snippet = bunPathSnippet(binDir, home);
  const rc = resolveShellRc(process.env.SHELL, home);
  if ("unknown" in rc) {
    console.log(
      `--fix: couldn't detect your shell from $SHELL. Add this to your shell rc (~/.zshrc or ~/.bashrc):\n\n${snippet}\n`,
    );
    return;
  }
  const { changed } = applyPathFix({ rcPath: rc.rcPath, snippet, binDir });
  if (changed) {
    console.log(`--fix: added bun PATH export to ${rc.rcPath} — run \`source ${rc.rcPath}\` or open a new shell.`);
  } else {
    console.log(`--fix: ${rc.rcPath} already configured — open a new shell to pick it up.`);
  }
}
```

- [ ] **Step 3: Add the `--fix` option in `index.ts`**

In `packages/cli/src/index.ts`, change the `doctor` command block to:

```ts
program
  .command("doctor")
  .description("Check tmux/claude/git/gh preconditions for `mm dispatch`")
  .option("--fix", "write the bun PATH export to your shell rc (~/.zshrc / ~/.bashrc)")
  .action(async (options: { fix?: boolean }) => process.exit(await runDoctor({ fix: options.fix })));
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (read-only run)**

Run: `bun run mm doctor`
Expected: a `bun PATH` row appears in the report (pass if `~/.bun/bin` is on PATH, warn otherwise). No files mutated.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/src/index.ts
git commit -m "feat(cli): doctor checks bun global bin dir on PATH; \`--fix\` writes shell rc"
```

---

## Task 5: Verify gates (lint, format, full test, doctor self-row)

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: PASS, including `bun-path.test.ts` and the existing `doctor.test.ts`.

- [ ] **Step 2: Typecheck, lint, format**

Run: `bun run typecheck && bun run lint && bun run format`
Expected: typecheck clean; oxlint auto-fixes anything fixable and exits 0; oxfmt formats. Re-run `bun test` if format changed anything.

- [ ] **Step 3: Confirm `index.ts` module-index frontmatter still passes**

The `doctor` surface description in `index.ts` already lists `doctor` — no
frontmatter change is required (the `--fix` flag is a sub-option, not a new
public command). Confirm:

Run: `bun test packages/cli/test/module-index.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit any format-only changes**

```bash
git add -A
git commit -m "chore(cli): formatter pass for bun-path work" || echo "nothing to commit"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** root `mm` script → Task 1; `getBunGlobalBinDir`/`isDirOnPath`/`resolveShellRc`/`bunPathSnippet`/`rcAlreadyConfigured` → Task 2; `applyPathFix` → Task 3; `checkBunPath` + `--fix` wiring + `index.ts` option → Task 4; tests for every pure fn + tmp-file `applyPathFix` → Tasks 2–3; gates → Task 5. All spec sections mapped.
- **Placeholders:** none — every code step shows complete code.
- **Type consistency:** `ShellRc`, `applyPathFix({ rcPath, snippet, binDir })`, `runDoctor({ fix })`, and the `Check`/`CheckStatus` types match across tasks and the existing `doctor.ts`.
