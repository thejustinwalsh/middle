# @middle/state-issue — local conventions

Root `CLAUDE.md` states the contract (schema is authoritative; byte-identical round-trip is a hard invariant). This file is the local mechanics that keep that invariant from breaking — facts not visible from any single source file.

- **`ParsedState` deliberately drops some lines.** The parser does not capture the owners line or the open/close markers; they live as fixed constants in `constants.ts` (`OWNERS_LINE`, `OPEN_MARKER`, `CLOSE_MARKER`). Round-trip byte-identity holds *only because* the renderer re-emits those constants verbatim. If you add a non-captured metadata line, it must be a constant the renderer always writes — never something derived from `ParsedState`.
- **Section identity is positional and fixed.** `SECTION_NAMES` is the seven sections in required order; the parser keys off these exact headings. Renaming or reordering a section is a schema change — bump `schemas/state-issue.v1.md` first, then conform parser + renderer.
- **Dispatcher-tick comments are parser-transparent.** The dispatcher inserts `<!-- dispatcher-tick: … -->` lines between sections; the parser ignores them (`DISPATCHER_TICK_RE`) so they don't perturb the round-trip. Preserve that: anything the dispatcher injects between sections must be ignored on the parse side.
- **The owners line encodes who may edit what** (`recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage`). The renderer's section-level edits exist so two writers never clobber each other — keep edits scoped to the sections a writer owns.
