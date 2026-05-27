# `mm` root script + `mm doctor` bun-PATH check & fix

**Date:** 2026-05-27
**Status:** approved (design)

## Problem

`bun link` in `packages/cli` correctly creates a global `mm` symlink at
`~/.bun/bin/mm`, but the binary is "not found". The root cause is that Bun's
global bin dir (`bun pm bin -g` → `~/.bun/bin`) is not on `$PATH`. The official
`curl … | bash` installer writes the PATH export into the user's shell rc; the
**Homebrew** install does not (it only puts the `bun` executable itself on PATH
via `/opt/homebrew/bin`). So Homebrew-installed users get a silent gap: `bun`
works, `bun link` reports success, but globally-linked binaries are invisible.

Relying on `bun link` for a dev `mm` is therefore fragile and
install-method-dependent.

## Goals

1. Give contributors a way to run `mm` that needs **no** PATH or `bun link`
   setup at all.
2. Make `mm doctor` **detect** the missing-PATH condition and **offer to fix**
   it by writing the export into the right shell rc file.

Non-goals (YAGNI): interactive prompts, `~/.bash_profile` handling, probing
`which mm` directly, or supporting shells beyond zsh/bash.

## Design

### 1. `mm` root script

Add to the root `package.json` `scripts`:

```jsonc
"mm": "bun packages/cli/src/index.ts"
```

`bun run mm <args>` forwards args to the CLI, so `bun run mm doctor --fix`
works from a fresh checkout with no global install. This is the reproducible,
install-method-independent path; the global `bun link` `mm` is a convenience on
top, not a prerequisite.

### 2. `bun-path` check module

New module `packages/cli/src/checks/bun-path.ts`. Pure functions are the
testable core; effects live in thin wrappers.

| Function | Kind | Behavior |
|---|---|---|
| `getBunGlobalBinDir()` | effectful | Run `bun pm bin -g`; on non-zero/empty, fall back to `${HOME}/.bun/bin`. Returns an absolute path. |
| `isDirOnPath(dir, pathEnv)` | pure | Split `pathEnv` on `:`, normalize (drop trailing slash), case-sensitive compare. `true` iff `dir` is present. |
| `resolveShellRc(shell, home)` | pure | `shell` ending in `zsh` → `{ shell: "zsh", rcPath: ${home}/.zshrc }`; ending in `bash` → `{ shell: "bash", rcPath: ${home}/.bashrc }`; otherwise `{ unknown: true }`. |
| `bunPathSnippet(binDir, home)` | pure | If `binDir === ${home}/.bun/bin`, emit the canonical bun installer block (`export BUN_INSTALL="$HOME/.bun"` / `export PATH="$BUN_INSTALL/bin:$PATH"`). Otherwise emit a literal `export PATH="<binDir>:$PATH"`. Block is prefixed with a `# bun` comment line. |
| `rcAlreadyConfigured(rcContents, binDir)` | pure | `true` if the rc already references `binDir`, `$BUN_INSTALL/bin`, or `${home}/.bun/bin` on a PATH export — used for idempotency. |
| `applyPathFix({ rcPath, snippet })` | effectful | Read the rc (empty if absent); if `rcAlreadyConfigured`, return `{ changed: false }`; else append `\n<snippet>\n` and return `{ changed: true }`. |

### 3. `mm doctor` wiring

- `doctor.ts` gains `checkBunPath()` returning a `Check`:
  - bin dir on PATH → `pass`, detail = the dir.
  - not on PATH → **`warn`** (not `fail`: `mm` is still runnable via
    `bun run mm`), detail = `"<dir> not on PATH — globally-linked binaries like
    \`mm\` are invisible; run \`mm doctor --fix\`"`.
- `runDoctor` signature becomes `runDoctor({ fix }: { fix?: boolean } = {})`.
  When `fix` is set **and** the bun-path check warned:
  - Resolve the rc from `process.env.SHELL`.
    - Known shell → `applyPathFix`; print
      `"added to <rcPath> — run \`source <rcPath>\` or open a new shell"`
      (or `"already configured"` when `changed: false`).
    - Unknown shell → print both the zsh and bash target paths + the snippet
      and a manual instruction; write nothing.
  - When `--fix` is passed but nothing is broken → print `"nothing to fix"`.
- `index.ts`: add `.option("--fix", "write the bun PATH export to your shell rc")`
  to the `doctor` command and thread it into `runDoctor`.

Exit codes are unchanged in spirit: the bun-path issue is a warning, so it never
flips doctor to exit 1 on its own.

## Testing

Unit tests (`packages/cli/test/bun-path.test.ts`) on the pure functions:

- `isDirOnPath`: present, absent, trailing-slash on either side, empty PATH.
- `resolveShellRc`: `/bin/zsh`, `/usr/bin/bash`, `/bin/sh`/unset → unknown.
- `bunPathSnippet`: `$HOME`-relative form when dir matches; literal form when it
  doesn't.
- `rcAlreadyConfigured`: detects each of the three reference forms; false on an
  unrelated rc.
- `applyPathFix`: against a `tmp` file — appends once, is idempotent on a second
  call, creates content when the file is absent.

No test reads the real `$SHELL` or mutates a real rc file. `getBunGlobalBinDir`'s
shell-out is exercised only indirectly (its fallback is pure and covered).

## Files touched

- `package.json` (root) — add `mm` script.
- `packages/cli/src/checks/bun-path.ts` — new.
- `packages/cli/src/commands/doctor.ts` — add `checkBunPath`, `--fix` handling.
- `packages/cli/src/index.ts` — add `--fix` option, update module-index doc if
  the surface description warrants it.
- `packages/cli/test/bun-path.test.ts` — new.
