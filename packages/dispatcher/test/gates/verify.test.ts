import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckboxReconcileDeps,
  reconcileCheckboxes,
} from "../../src/gates/checkbox-revert.ts";
import { evidenceMarker, type EvidenceGateway } from "../../src/gates/gate-evidence.ts";
import { makeRunPhaseGates } from "../../src/gates/verify.ts";
import { parseVerifyConfig } from "../../src/gates/verify-config.ts";

/** A scratch worktree the gates run in. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "middle-verify-e2e-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** In-memory PR + comment store backing both the reconciler and evidence seams. */
function world(prBody: string) {
  const state = { body: prBody, previous: {} as Record<number, boolean> };
  const comments: Array<{ id: number; body: string }> = [];
  let nextId = 1;

  const github: EvidenceGateway = {
    async listIssueComments() {
      return comments.map((c) => ({
        authorLogin: "agent",
        body: c.body,
        url: `https://x/pull/99#issuecomment-${c.id}`,
      }));
    },
    async postComment(_repo, _issue, body) {
      comments.push({ id: nextId++, body });
    },
    async editComment(_repo, id, body) {
      const c = comments.find((x) => x.id === id);
      if (c) c.body = body;
    },
  };

  return { state, comments, github };
}

describe("verification gates wired into checkbox-revert (end to end)", () => {
  // verify.toml: a gate that passes for phase 100, one that fails for phase 101.
  const config = parseVerifyConfig(
    [
      "[[gate]]",
      'name = "pass-gate"',
      'command = "echo green"',
      "phases = [100]",
      "",
      "[[gate]]",
      'name = "fail-gate"',
      'command = "echo boom >&2; exit 1"',
      "phases = [101]",
    ].join("\n"),
  );

  const PR_BODY = [
    "## Summary",
    "Closes #37",
    "",
    "## Status",
    "- [x] #100 — a phase whose gates pass",
    "- [x] #101 — a phase whose gates fail",
    "",
  ].join("\n");

  function buildDeps(s: { dir: string }) {
    const w = world(PR_BODY);
    const runGates = makeRunPhaseGates({
      repo: "o/r",
      prNumber: 99,
      worktreePath: s.dir,
      config,
      github: w.github,
    });
    const deps: CheckboxReconcileDeps = {
      async getPrBody() {
        return w.state.body;
      },
      async setPrBody(body) {
        w.state.body = body;
      },
      async postComment(body) {
        await w.github.postComment("o/r", "99", body);
      },
      runGates,
      async getPreviousState() {
        return w.state.previous;
      },
      async setPreviousState(p) {
        w.state.previous = p;
      },
    };
    return { w, deps };
  }

  test("a failing phase's box is reverted; a passing phase's box stays checked", async () => {
    const s = scratch();
    try {
      const { w, deps } = buildDeps(s);
      const result = await reconcileCheckboxes(deps);

      // The failing phase was reverted, the passing one was not.
      expect(result.reverted).toEqual([101]);
      expect(w.state.body).toContain("- [x] #100 — a phase whose gates pass");
      expect(w.state.body).toContain("- [ ] #101 — a phase whose gates fail");
    } finally {
      s.cleanup();
    }
  });

  test("evidence is posted for both phases and a revert notice names the failed gate", async () => {
    const s = scratch();
    try {
      const { w, deps } = buildDeps(s);
      await reconcileCheckboxes(deps);

      const bodies = w.comments.map((c) => c.body);
      const pass = bodies.find((b) => b.includes(evidenceMarker(100)));
      const fail = bodies.find((b) => b.includes(evidenceMarker(101)));
      expect(pass).toBeDefined();
      expect(fail).toBeDefined();
      expect(pass!).toMatch(/passed/i);
      expect(fail!).toMatch(/failed/i);
      expect(fail!).toContain("boom"); // captured gate output in <details>

      // The reconciler's terse revert notice names the failed gate + the sub-issue.
      const revert = bodies.find((b) => b.includes("reverted") && b.includes("fail-gate"));
      expect(revert).toBeDefined();
      expect(revert!).toContain("#101");
    } finally {
      s.cleanup();
    }
  });

  // The seam is what the reconciler loop awaits per transition: any throw it
  // lets escape aborts reconcileCheckboxes mid-loop — skipping later phases'
  // reverts and the state persist. So no failure inside it may throw; each must
  // surface as a loud non-ok verdict the reconciler can revert + comment on.
  describe("seam never throws into the reconcile loop", () => {
    /** A github whose evidence path (listIssueComments) always fails. */
    function ghThatFailsEvidence(): EvidenceGateway {
      return {
        async listIssueComments() {
          throw new Error("GitHub API down");
        },
        async postComment() {},
        async editComment() {},
      };
    }

    test("an evidence-upsert failure yields ok:false (not a throw), preserving a real gate failure", async () => {
      const s = scratch();
      try {
        const runGates = makeRunPhaseGates({
          repo: "o/r",
          prNumber: 99,
          worktreePath: s.dir,
          config,
          github: ghThatFailsEvidence(),
        });
        // Phase 100 gates pass but evidence can't post → ok:false, evidence-comment.
        await expect(runGates(100)).resolves.toEqual({ ok: false, failedGate: "evidence-comment" });
        // Phase 101 gates fail *and* evidence can't post → the real gate name wins.
        await expect(runGates(101)).resolves.toEqual({ ok: false, failedGate: "fail-gate" });
      } finally {
        s.cleanup();
      }
    });

    test("a gate-runner failure (worktree gone) yields ok:false instead of throwing", async () => {
      const w = world(PR_BODY);
      // A worktree path that doesn't exist makes Bun.spawn throw on cwd.
      const runGates = makeRunPhaseGates({
        repo: "o/r",
        prNumber: 99,
        worktreePath: join(tmpdir(), "middle-verify-absent", "nope"),
        config,
        github: w.github,
      });
      await expect(runGates(100)).resolves.toEqual({ ok: false, failedGate: "gate-runner" });
    });

    test("reconcileCheckboxes still processes every transition + persists state when evidence fails", async () => {
      const s = scratch();
      try {
        const w = world(PR_BODY);
        const runGates = makeRunPhaseGates({
          repo: "o/r",
          prNumber: 99,
          worktreePath: s.dir,
          config,
          github: ghThatFailsEvidence(),
        });
        const deps: CheckboxReconcileDeps = {
          async getPrBody() {
            return w.state.body;
          },
          async setPrBody(b) {
            w.state.body = b;
          },
          async postComment(b) {
            await w.github.postComment("o/r", "99", b);
          },
          runGates,
          async getPreviousState() {
            return w.state.previous;
          },
          async setPreviousState(p) {
            w.state.previous = p;
          },
        };

        const result = await reconcileCheckboxes(deps);

        // Both transitions were processed despite evidence failing on the first —
        // proof the loop didn't abort. (Both revert: 100 because evidence failed,
        // 101 because its gate failed.)
        expect(result.reverted).toEqual([100, 101]);
        // State was persisted for the next pass (the reverted boxes are unchecked).
        expect(w.state.previous).toEqual({ 100: false, 101: false });
      } finally {
        s.cleanup();
      }
    });
  });

  test("re-running after a fix keeps the box checked and updates evidence in place", async () => {
    const s = scratch();
    try {
      // Both phases now pass; both boxes start checked, previously unchecked.
      const allPass = parseVerifyConfig(
        ["[[gate]]", 'name = "ok"', 'command = "echo ok"'].join("\n"),
      );
      const w = world(PR_BODY);
      const runGates = makeRunPhaseGates({
        repo: "o/r",
        prNumber: 99,
        worktreePath: s.dir,
        config: allPass,
        github: w.github,
      });
      const deps: CheckboxReconcileDeps = {
        async getPrBody() {
          return w.state.body;
        },
        async setPrBody(b) {
          w.state.body = b;
        },
        async postComment(b) {
          await w.github.postComment("o/r", "99", b);
        },
        runGates,
        async getPreviousState() {
          return w.state.previous;
        },
        async setPreviousState(p) {
          w.state.previous = p;
        },
      };

      await reconcileCheckboxes(deps); // first pass
      const afterFirst = w.comments.length;
      // A second reconcile with no new transitions does not re-run gates (state recorded).
      await reconcileCheckboxes(deps);

      expect(w.state.body).toContain("- [x] #100");
      expect(w.state.body).toContain("- [x] #101");
      // No revert notices, and the second pass added no new evidence comments.
      expect(w.comments.some((c) => c.body.includes("reverted"))).toBe(false);
      expect(w.comments.length).toBe(afterFirst);
    } finally {
      s.cleanup();
    }
  });
});
