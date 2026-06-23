import { describe, expect, test } from "bun:test";
import { defaultDispatchBrief } from "../src/workflows/implementation.ts";

describe("defaultDispatchBrief", () => {
  test("github mode brief does not contain 'file mode'", () => {
    const brief = defaultDispatchBrief("42", 3, false, "github");
    expect(brief).not.toContain("file mode");
  });

  test("file mode brief contains 'file mode'", () => {
    const brief = defaultDispatchBrief("42", 3, false, "file");
    expect(brief).toContain("file mode");
  });

  test("file mode brief names the .middle/skills references path", () => {
    const brief = defaultDispatchBrief("42", 3, false, "file");
    expect(brief).toContain(".middle/skills/implementing-github-issues/references/");
  });

  test("github mode brief names the .middle/skills references path", () => {
    const brief = defaultDispatchBrief("42", 3, false, "github");
    expect(brief).toContain(".middle/skills/implementing-github-issues/references/");
  });

  test("approved label changes the pause wording", () => {
    const approved = defaultDispatchBrief("42", 3, true, "github");
    expect(approved).toContain("authorized you to proceed");
    const notApproved = defaultDispatchBrief("42", 3, false, "github");
    expect(notApproved).toContain("Pause only if");
  });
});
