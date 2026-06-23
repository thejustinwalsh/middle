#!/usr/bin/env bun
// Keep all skill mirrors byte-identical to the canonical packages/skills/.
//
// Mirrors synced:
//   1. packages/cli/src/bootstrap-assets/skills/  — the copy mm init stamps into
//      target repos; must be byte-identical (pre-commit hook enforces).
//   2. .claude/skills/  — Claude Code reads these in the middle repo itself.
//   3. .codex/skills/   — Codex reads these in the middle repo itself.
//
// Mirrors 2 and 3 are seeded by `mm init` but are NOT kept in sync by the
// pre-commit hook. `bun run sync-skills` (or this script directly) re-syncs all
// three. `--check` reports drift and exits non-zero without writing (the hook
// targets bootstrap-assets only, but `--check` covers all three here).
//
// excalidraw-diagram lives only in the .claude mirror (not a canonical skill —
// it's a host-local Claude Code tool). Both .claude and .codex syncs pass
// excludeNames so a sync pass never deletes it.
import { join } from "node:path";
import {
  BOOTSTRAP_SKILLS_DIR,
  CANONICAL_SKILLS_DIR,
  syncSkills,
} from "../packages/cli/src/bootstrap/skills-sync.ts";

const check = process.argv.includes("--check");
const repoRoot = join(import.meta.dir, "..");

// Names that live only in the .claude/.codex mirrors and must never be deleted
// by a sync pass even though they have no canonical counterpart.
const LOCAL_ONLY = new Set(["excalidraw-diagram"]);

// --- 1. bootstrap-assets mirror -------------------------------------------

const bootstrapResult = syncSkills({
  canonicalDir: CANONICAL_SKILLS_DIR,
  mirrorDir: BOOTSTRAP_SKILLS_DIR,
  check,
});

// --- 2. .claude/skills/ mirror --------------------------------------------

const claudeResult = syncSkills({
  canonicalDir: CANONICAL_SKILLS_DIR,
  mirrorDir: join(repoRoot, ".claude", "skills"),
  check,
  excludeNames: LOCAL_ONLY,
});

// --- 3. .codex/skills/ mirror ---------------------------------------------

const codexResult = syncSkills({
  canonicalDir: CANONICAL_SKILLS_DIR,
  mirrorDir: join(repoRoot, ".codex", "skills"),
  check,
  excludeNames: LOCAL_ONLY,
});

// --------------------------------------------------------------------------

const allInSync = bootstrapResult.inSync && claudeResult.inSync && codexResult.inSync;

if (check) {
  let ok = true;
  if (!bootstrapResult.inSync) {
    ok = false;
    console.error("skills: DRIFT between packages/skills/ and bootstrap-assets/skills/:");
    for (const rel of bootstrapResult.changed) console.error(`  - ${rel}`);
  }
  if (!claudeResult.inSync) {
    ok = false;
    console.error("skills: DRIFT between packages/skills/ and .claude/skills/:");
    for (const rel of claudeResult.changed) console.error(`  - ${rel}`);
  }
  if (!codexResult.inSync) {
    ok = false;
    console.error("skills: DRIFT between packages/skills/ and .codex/skills/:");
    for (const rel of codexResult.changed) console.error(`  - ${rel}`);
  }
  if (ok) {
    console.log("skills: all mirrors are in sync with packages/skills/");
    process.exit(0);
  }
  console.error("\nrun `bun run sync-skills` and commit the result.");
  process.exit(1);
}

if (allInSync) {
  console.log("skills: all mirrors already in sync — nothing to do.");
} else {
  if (!bootstrapResult.inSync) {
    console.log("skills: re-synced bootstrap-assets mirror:");
    for (const rel of bootstrapResult.changed) console.log(`  - ${rel}`);
  }
  if (!claudeResult.inSync) {
    console.log("skills: re-synced .claude/skills/ mirror:");
    for (const rel of claudeResult.changed) console.log(`  - ${rel}`);
  }
  if (!codexResult.inSync) {
    console.log("skills: re-synced .codex/skills/ mirror:");
    for (const rel of codexResult.changed) console.log(`  - ${rel}`);
  }
}
