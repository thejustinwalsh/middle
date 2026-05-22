import { describe, expect, spyOn, test } from "bun:test";
import { runDoctor } from "../src/commands/doctor.ts";

// runDoctor shells out to bun/tmux/claude/git/gh — these all exist on the
// machine middle is built for, so the happy path is verifiable. We don't fake
// out missing binaries here (that's interactive operator territory); the unit
// behavior of the version checks is covered by the tmux helpers' unit tests.

describe("runDoctor — happy path", () => {
  test("returns 0 and prints a check per tool when the toolchain is healthy", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = await runDoctor();
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("middle — system check");
    for (const name of ["bun", "tmux", "claude", "git", "gh", "gh auth"]) {
      expect(output).toContain(name);
    }
  });
});
