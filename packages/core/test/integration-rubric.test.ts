import { describe, expect, test } from "bun:test";
import {
  auditIssueBody,
  detectExemption,
  isIntegrationCriterion,
  parseAcceptanceCriteria,
} from "../src/integration-rubric.ts";

describe("parseAcceptanceCriteria", () => {
  test("collects list items under the first acceptance heading, stops at next heading", () => {
    const body = [
      "## Context",
      "- not a criterion",
      "## Acceptance criteria",
      "- [ ] first thing",
      "- [x] second thing",
      "* third thing",
      "## Out of scope",
      "- nope",
    ].join("\n");
    expect(parseAcceptanceCriteria(body)).toEqual(["first thing", "second thing", "third thing"]);
  });

  test("returns [] when there is no acceptance section", () => {
    expect(parseAcceptanceCriteria("## Context\n- a\n## Out of scope\n- b")).toEqual([]);
  });
});

describe("isIntegrationCriterion", () => {
  test("the spec's worked example is an integration criterion", () => {
    expect(
      isIntegrationCriterion(
        "`mm start` serves the dashboard at `/`; a smoke test boots the daemon and GETs `/`, asserting the SPA shell",
      ),
    ).toBe(true);
  });

  test("'unit tests pass' alone is not an integration criterion", () => {
    expect(isIntegrationCriterion("Unit tests pass")).toBe(false);
    expect(isIntegrationCriterion("Good unit-test coverage of the parser")).toBe(false);
  });

  test("wiring without a real-path test fails (behavior, not test)", () => {
    expect(isIntegrationCriterion("mm init creates a state issue and writes config.toml")).toBe(
      false,
    );
  });

  test("a real-path test without wiring fails", () => {
    expect(isIntegrationCriterion("an integration test fuzzes the parser 10k times")).toBe(false);
  });

  test("prose 'get' does not trip the uppercase HTTP-verb signal", () => {
    expect(isIntegrationCriterion("get good coverage; an integration test runs")).toBe(false);
  });

  test("served + e2e qualifies", () => {
    expect(
      isIntegrationCriterion("the route is served by the daemon; an e2e test exercises it"),
    ).toBe(true);
  });
});

describe("detectExemption", () => {
  test("reads an inline annotation and a comment form", () => {
    expect(detectExemption("foo (integration-exempt: https://x/y#c1) bar")).toBe("https://x/y#c1");
    expect(detectExemption("<!-- integration-exempt: hardware-only path -->")).toBe(
      "hardware-only path",
    );
    expect(detectExemption("nothing here")).toBeNull();
  });
});

describe("auditIssueBody", () => {
  const wellFormed = [
    "## Acceptance criteria",
    "- [ ] `parseFoo` returns a Foo for valid input",
    "- [ ] `mm foo` serves the result; an integration test boots the daemon and GETs `/foo`",
  ].join("\n");

  const weak = [
    "## Acceptance criteria",
    "- [ ] the parser works correctly",
    "- [ ] unit tests pass",
  ].join("\n");

  test("passes a body with an integration criterion", () => {
    const r = auditIssueBody(wellFormed, { title: "Foo feature" });
    expect(r.pass).toBe(true);
    expect(r.integrationCriteria).toHaveLength(1);
    expect(r.suggestion).toBeUndefined();
  });

  test("flags a weak body and suggests a concrete rewrite naming the feature", () => {
    const r = auditIssueBody(weak, { title: "Foo feature" });
    expect(r.pass).toBe(false);
    expect(r.integrationCriteria).toHaveLength(0);
    expect(r.suggestion).toContain("Foo feature");
    expect(r.suggestion).toContain("smoke test");
  });

  test("flags a body with no acceptance section, suggestion says so", () => {
    const r = auditIssueBody("## Context\nsome prose", {});
    expect(r.pass).toBe(false);
    expect(r.suggestion).toContain("No acceptance criteria found");
  });

  test("a declared exemption passes and surfaces the reason", () => {
    const r = auditIssueBody(
      "## Acceptance criteria\n- [ ] unit tests pass\n\n<!-- integration-exempt: pure type-level package, no runtime path -->",
      {},
    );
    expect(r.pass).toBe(true);
    expect(r.exempt).toBe(true);
    expect(r.exemptReason).toContain("pure type-level");
  });
});
