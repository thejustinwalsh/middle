import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitDocs,
  docsPrBody,
  makeGhPersistDocs,
  pushDocsBranch,
  type CommitResult,
  type DocsPersistInput,
} from "../src/docs-persist.ts";

let repo: string;
let bares: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "middle-docspersist-")));
  await git(repo, ["init", "-q"]);
  // A committer identity local to the fixture — commitDocs uses the repo's
  // configured identity (no overrides), mirroring a real checkout.
  await git(repo, ["config", "user.email", "docs-bot@example.invalid"]);
  await git(repo, ["config", "user.name", "docs-bot"]);
  // `.middle/` is gitignored in real repos — assert commitDocs honors that.
  writeFileSync(join(repo, ".gitignore"), ".middle/\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const b of bares) rmSync(b, { recursive: true, force: true });
  bares = [];
});

/** Give `repo` a local bare `origin` so the push path can run without GitHub. */
async function withBareRemote(): Promise<string> {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "middle-docsremote-")));
  bares.push(bare);
  await git(bare, ["init", "--bare", "-q"]);
  await git(repo, ["remote", "add", "origin", bare]);
  return bare;
}

function writeDoc(rel: string, body = "# doc\n"): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("commitDocs", () => {
  test("stages and commits authored docs; returns the sha + sorted file list", async () => {
    writeDoc("docs/index.md");
    writeDoc("docs/guides/getting-started.md");

    const result = await commitDocs({ repo: "owner/name", worktreePath: repo });
    expect(result).not.toBeNull();
    expect(result!.files).toEqual(["docs/guides/getting-started.md", "docs/index.md"]);
    // The sha is the new HEAD, and HEAD's tree carries the docs.
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(result!.sha);
    const tracked = await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(tracked.split("\n")).toContain("docs/index.md");
  });

  test("returns null on a clean worktree — no empty commit", async () => {
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    const result = await commitDocs({ repo: "owner/name", worktreePath: repo });
    expect(result).toBeNull();
    // HEAD did not move — nothing was committed.
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
  });

  test("excludes middle's .middle/ scratch even when the repo does not gitignore it", async () => {
    // Neutralize the fixture's .gitignore so .middle/ is NOT ignored — the
    // explicit `:(exclude).middle` pathspec, not gitignore, must keep it out.
    writeFileSync(join(repo, ".gitignore"), "");
    writeDoc(".middle/prompt.md", "scratch");
    writeDoc(".middle/hooks/hook.sh", "#!/bin/sh\n");
    writeDoc("docs/index.md");
    const result = await commitDocs({ repo: "owner/name", worktreePath: repo });
    expect(result!.files).not.toContain(".middle/prompt.md");
    expect(result!.files).not.toContain(".middle/hooks/hook.sh");
    expect(result!.files).toContain("docs/index.md");
    // The neutralized .gitignore is a real working-tree change, so it is committed
    // alongside the docs — but nothing under .middle/ is.
    expect(result!.files.some((f) => f.startsWith(".middle/"))).toBe(false);
  });

  test("honors a custom commit message", async () => {
    writeDoc("docs/index.md");
    await commitDocs({ repo: "owner/name", worktreePath: repo, message: "docs: bespoke subject" });
    expect(await git(repo, ["log", "-1", "--pretty=%s"])).toBe("docs: bespoke subject");
  });
});

describe("makeGhPersistDocs", () => {
  test("commits, then invokes the push seam with the commit it produced", async () => {
    writeDoc("docs/index.md");
    const pushed: Array<DocsPersistInput & { commit: CommitResult }> = [];
    const persist = makeGhPersistDocs(async (o) => {
      pushed.push(o);
    });

    const input: DocsPersistInput = {
      repo: "owner/name",
      worktreePath: repo,
      branch: "middle-docs",
    };
    await persist(input);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.repo).toBe("owner/name");
    expect(pushed[0]!.branch).toBe("middle-docs");
    expect(pushed[0]!.commit.files).toEqual(["docs/index.md"]);
    expect(pushed[0]!.commit.sha).toBe(await git(repo, ["rev-parse", "HEAD"]));
  });

  test("clean worktree: the push seam is never invoked (no empty PR)", async () => {
    let pushes = 0;
    const persist = makeGhPersistDocs(async () => {
      pushes += 1;
    });
    await persist({ repo: "owner/name", worktreePath: repo, branch: "middle-docs" });
    expect(pushes).toBe(0);
  });
});

describe("pushDocsBranch", () => {
  test("first run creates the branch on origin at the authored commit", async () => {
    const bare = await withBareRemote();
    writeDoc("docs/index.md");
    const c = await commitDocs({ repo: "owner/name", worktreePath: repo });
    await pushDocsBranch({ worktreePath: repo, branch: "middle-docs" });
    expect(await git(bare, ["rev-parse", "middle-docs"])).toBe(c!.sha);
  });

  test("re-run force-pushes a divergent commit (rebuilt branch is non-fast-forward)", async () => {
    const bare = await withBareRemote();
    // Run 1: author v1, commit, push → remote middle-docs = c1.
    writeDoc("docs/index.md", "v1\n");
    const c1 = await commitDocs({ repo: "owner/name", worktreePath: repo });
    await pushDocsBranch({ worktreePath: repo, branch: "middle-docs" });
    expect(await git(bare, ["rev-parse", "middle-docs"])).toBe(c1!.sha);

    // Run 2 mirrors the runner rebuilding the branch from the default HEAD: reset
    // to the pre-docs commit and author different content. The new commit shares
    // c1's parent, so it is NOT a descendant of c1 → a plain push would be rejected.
    await git(repo, ["reset", "--hard", "HEAD~1"]);
    writeDoc("docs/index.md", "v2 — different\n");
    const c2 = await commitDocs({ repo: "owner/name", worktreePath: repo });
    await pushDocsBranch({ worktreePath: repo, branch: "middle-docs" });

    const remote = await git(bare, ["rev-parse", "middle-docs"]);
    expect(remote).toBe(c2!.sha);
    expect(remote).not.toBe(c1!.sha);
  });

  test("surfaces a push failure rather than swallowing it (no origin configured)", async () => {
    writeDoc("docs/index.md");
    await commitDocs({ repo: "owner/name", worktreePath: repo });
    await expect(pushDocsBranch({ worktreePath: repo, branch: "middle-docs" })).rejects.toThrow(
      /git push middle-docs failed/,
    );
  });
});

describe("docsPrBody", () => {
  test("lists the committed files, the commit sha, and the draft notice", () => {
    const body = docsPrBody("owner/name", { sha: "abc123", files: ["docs/index.md", "docs/x.md"] });
    expect(body).toContain("owner/name");
    expect(body).toContain("abc123");
    expect(body).toContain("- `docs/index.md`");
    expect(body).toContain("- `docs/x.md`");
    expect(body).toContain("does not auto-merge");
  });
});
