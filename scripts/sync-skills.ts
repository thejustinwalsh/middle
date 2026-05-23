#!/usr/bin/env bun
// Keep packages/cli/src/bootstrap-assets/skills/ byte-identical to the canonical
// packages/skills/. `--check` reports drift and exits non-zero without writing
// (used by the pre-commit hook and mirrored by `mm doctor`); no flag re-syncs.
import {
  BOOTSTRAP_SKILLS_DIR,
  CANONICAL_SKILLS_DIR,
  syncSkills,
} from "../packages/cli/src/bootstrap/skills-sync.ts";

const check = process.argv.includes("--check");
const result = syncSkills({
  canonicalDir: CANONICAL_SKILLS_DIR,
  mirrorDir: BOOTSTRAP_SKILLS_DIR,
  check,
});

if (check) {
  if (result.inSync) {
    console.log("skills: bootstrap-assets mirror is in sync with packages/skills/");
    process.exit(0);
  }
  console.error("skills: DRIFT between packages/skills/ and bootstrap-assets/skills/:");
  for (const rel of result.changed) console.error(`  - ${rel}`);
  console.error("\nrun `bun run sync-skills` and commit the result.");
  process.exit(1);
}

if (result.inSync) {
  console.log("skills: already in sync — nothing to do.");
} else {
  console.log("skills: re-synced bootstrap-assets mirror:");
  for (const rel of result.changed) console.log(`  - ${rel}`);
}
