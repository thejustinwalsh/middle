import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitDocs,
  makeGhPersistDocs,
  type CommitResult,
  type DocsPersistInput,
} from "../src/docs-persist.ts";

let repo: string;

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
});

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

  test("does not commit gitignored scratch (.middle/)", async () => {
    writeDoc(".middle/prompt.md", "scratch");
    writeDoc("docs/index.md");
    const result = await commitDocs({ repo: "owner/name", worktreePath: repo });
    expect(result!.files).toEqual(["docs/index.md"]);
    expect(result!.files).not.toContain(".middle/prompt.md");
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
