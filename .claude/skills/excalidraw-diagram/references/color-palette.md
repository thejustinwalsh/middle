# Color Palette & Brand Style — middle

**This is the single source of truth for all colors and brand-specific styles.** `middle` is a developer tool with an Office-Space "middle management" wink. Diagrams are **light-canvas, ink-stroked, role-colored**: clean white background, dark hand-drawn strokes, and a small set of semantic accent colors that map to the three actors in the org chart. They embed inside a light Slidev deck, so the canvas is white — never dark.

The palette assigns one accent to each **actor/role**, so color does taxonomy work: the eye learns "amber = middle, green = you, blue = agents" once and reads the rest of the deck for free.

---

## Canvas

| Property | Value |
|----------|-------|
| Canvas background (`appState.viewBackgroundColor`) | `#ffffff` (white) |
| `appState.exportBackground` | `true` (bake the white so the figure is self-contained) |

Always set `viewBackgroundColor: "#ffffff"`. The diagram is a light surface that sits on the deck's light slides.

---

## Role Accents (Semantic — pick by actor, not by looks)

Pair a saturated stroke with its pale tinted fill. Each actor in middle's org chart owns one color.

| Role | Stroke / text | Soft fill (container) | Used for |
|------|---------------|------------------------|----------|
| **you** (human / executive) | `#2f9e44` (emerald) | `#ebfbee` | the human: scope calls, review, the merge |
| **middle** (the manager) | `#e8590c` (amber) | `#fff4e6` | the dispatcher / manager node, the headline flow |
| **agents** (the workers) | `#1971c2` (blue) | `#e7f5ff` | coding agents, worktrees, tmux sessions |
| **gate / decision** | `#f08c00` (gold) | `#fff9db` | verification gates, decision diamonds |
| **artifact** (Epic / PR / issue) | `#5f3dc4` (violet) | `#f3f0ff` | GitHub artifacts: Epic, sub-issues, the PR |
| **danger / escalate** | `#e03131` (red) | `#fff5f5` | blocked / escalate-to-human, the hot path |

**Rule**: saturated stroke + matching pale fill. Use a different role color per logical group so color separates the actors at a glance. Don't route everything through one hue.

---

## Neutrals & Containers

| Element | Value |
|---------|-------|
| Group / subgraph container fill | `#f8f9fa` (near-white elevated) |
| Group container stroke | `#adb5bd` (or a role stroke to tag the group) |
| Neutral node fill | `#f1f3f5` |
| Neutral node stroke | `#495057` |

---

## Text Colors (Hierarchy)

| Level | Color | Use For |
|-------|-------|---------|
| Title / heading | `#212529` (near-black ink) | Diagram titles, major free labels |
| Body in shapes | `#212529` (near-black ink) | Text inside pale-filled shapes |
| Detail / annotation | `#868e96` (muted slate) | Edge labels, captions, metadata |
| Role-tagged label | the role's stroke color | A label naming a specific actor |

Every fill is pale, so text is always dark ink (`#212529`) or a saturated role color — never white.

---

## Evidence Artifacts (commands, file paths, JSON)

| Artifact | Background | Text Color |
|----------|-----------|------------|
| Command / code snippet | `#212529` | near-white `#f1f3f5`, accents below |
| JSON / data example | `#212529` | `#69db7c` (green) for values |
| File-path / state cells | role-soft fill + role stroke | `#212529` |

Syntax accents on dark snippet blocks: keywords `#ffa94d`, strings `#69db7c`, comments `#868e96`.

---

## Arrows & Structural Lines

| Element | Color |
|---------|-------|
| Flow arrows | the source actor's stroke (so flow is color-coded by actor) |
| Cross-actor / neutral arrows | `#868e96` (muted slate) |
| Dividers, structural lines | `#ced4da` |
| Marker dots | role stroke fill + same stroke |

---

## Roughness

middle's diagrams use **`roughness: 1` (hand-drawn)** — the Excalidraw sketch look is intentional brand, matching the deck's informal, "memo on a whiteboard" voice. This overrides the skill's default of `0`.

---

## Don't

- Don't use a dark/near-black canvas — middle's deck is light; a dark figure would clash.
- Don't route everything through one accent (e.g. all-amber). Assign one color per actor so color does taxonomy.
- Don't use neon or pure-saturated fills — fills are always the pale tint, strokes carry the saturation.
