import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EpicRef, epicFileHref } from "../src/app/components/EpicRef.tsx";
import { Inspector } from "../src/app/components/Inspector.tsx";
import { RunnerRow } from "../src/app/components/RunnerRow.tsx";
import type { RunnerPanel, RunnerSummary } from "../src/wire.ts";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("EpicRef", () => {
  test("github mode renders plain `#N` text, no anchor (AC4: no behavior change)", () => {
    const out = render(<EpicRef epicNumber={42} epicRef={null} />);
    expect(out).toBe("#42");
    expect(out).not.toContain("<a");
  });

  test("github mode renders `#N` even if a backfilled epic_ref is also present", () => {
    // epic_number wins: a github-mode row may carry epic_ref = String(epic_number).
    const out = render(<EpicRef epicNumber={42} epicRef="42" />);
    expect(out).toBe("#42");
    expect(out).not.toContain("file://");
  });

  test("file mode renders the slug as a file:// link to the Epic file, no GitHub link", () => {
    const out = render(<EpicRef epicNumber={null} epicRef="rollout-epic-store" />);
    expect(out).toContain('href="file://planning/epics/rollout-epic-store.md"');
    expect(out).toContain(">rollout-epic-store<");
    expect(out).not.toContain("github.com");
    expect(out).not.toContain("#");
  });

  test("no-Epic (both null) renders the caller's fallback", () => {
    expect(render(<EpicRef epicNumber={null} epicRef={null} />)).toBe("—");
    expect(render(<EpicRef epicNumber={null} epicRef={null} fallback="#—" />)).toBe("#—");
  });

  test("a blank epicRef (empty / whitespace) falls through to the fallback, not an empty link", () => {
    expect(render(<EpicRef epicNumber={null} epicRef="" fallback="#—" />)).toBe("#—");
    expect(render(<EpicRef epicNumber={null} epicRef="   " fallback="#—" />)).toBe("#—");
  });

  test("a slug with surrounding whitespace is trimmed in both label and href", () => {
    const out = render(<EpicRef epicNumber={null} epicRef="  the-slug  " />);
    expect(out).toContain('href="file://planning/epics/the-slug.md"');
    expect(out).toContain(">the-slug<");
  });

  test("a slug with URL-unsafe / traversal chars is encoded into one safe path segment", () => {
    expect(epicFileHref("a/../b")).toBe("file://planning/epics/a%2F..%2Fb.md");
    expect(epicFileHref('x"><script>')).toBe("file://planning/epics/x%22%3E%3Cscript%3E.md");
    // A normal kebab-case slug encodes to itself (hyphens are unreserved).
    expect(epicFileHref("rollout-epic-store")).toBe("file://planning/epics/rollout-epic-store.md");
  });
});

const runner = (over: Partial<RunnerSummary> = {}): RunnerSummary => ({
  session: "s1",
  workflowId: "w1",
  epic: null,
  epicRef: null,
  adapter: "claude",
  progress: "running",
  state: "running",
  controlledBy: "middle",
  lastHeartbeat: null,
  attachCommands: { watch: "tmux attach -r -t s1", control: "tmux attach -t s1" },
  ...over,
});

describe("RunnerRow Epic rendering", () => {
  test("file-mode runner shows the slug file:// link", () => {
    const out = render(<RunnerRow runner={runner({ epic: null, epicRef: "the-slug" })} />);
    expect(out).toContain('href="file://planning/epics/the-slug.md"');
    expect(out).toContain(">the-slug<");
  });

  test("github-mode runner is unchanged (`#7`, no link)", () => {
    const out = render(<RunnerRow runner={runner({ epic: 7, epicRef: null })} />);
    expect(out).toContain("#7");
    expect(out).not.toContain("file://");
  });

  test("no-Epic runner keeps the `#—` fallback", () => {
    const out = render(<RunnerRow runner={runner({ epic: null, epicRef: null })} />);
    expect(out).toContain("#—");
  });
});

const panel = (over: Partial<RunnerPanel> = {}): RunnerPanel => ({
  session: "s1",
  workflowId: "w1",
  repo: "o/r",
  epic: null,
  epicRef: null,
  adapter: "claude",
  state: "running",
  controlledBy: "middle",
  alive: true,
  lastHeartbeat: null,
  contextTokens: null,
  transcriptPath: null,
  worktreePath: null,
  prNumber: null,
  prBranch: null,
  currentSubIssue: null,
  attachCommands: { watch: "tmux attach -r -t s1", control: "tmux attach -t s1" },
  ...over,
});

describe("Inspector Epic rendering", () => {
  test("file-mode panel shows the slug file:// link in the header", () => {
    const out = render(<Inspector panel={panel({ epicRef: "the-slug" })} events={[]} />);
    expect(out).toContain('href="file://planning/epics/the-slug.md"');
    expect(out).toContain(">the-slug<");
  });

  test("github-mode panel is unchanged (`#7`, no link)", () => {
    const out = render(<Inspector panel={panel({ epic: 7 })} events={[]} />);
    expect(out).toContain("#7");
    expect(out).not.toContain("file://");
  });
});
