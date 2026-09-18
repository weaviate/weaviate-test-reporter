import { describe, expect, it } from "vitest";
import { topFailingSuiteCard } from "./dashboard-kpis";

describe("topFailingSuiteCard", () => {
  it("returns the failing suite when test failures exist", () => {
    expect(
      topFailingSuiteCard({
        topFailingSuite: { suite: "suite.alpha", count: 3 },
        infraFailureRuns: 2,
      }),
    ).toEqual({
      value: "3",
      helper: "suite.alpha",
      tone: "bad",
    });
  });

  it("reports infra failures without calling the window a clean sweep", () => {
    expect(
      topFailingSuiteCard({
        topFailingSuite: null,
        infraFailureRuns: 2,
      }),
    ).toEqual({
      value: "0",
      helper:
        "No failed TestCases were reported; 2 TestRuns infra-failed before tests started.",
      tone: "neutral",
    });
  });

  it("keeps the clean-sweep message for windows with no failures at all", () => {
    expect(
      topFailingSuiteCard({
        topFailingSuite: null,
        infraFailureRuns: 0,
      }),
    ).toEqual({
      value: "0",
      helper: "No failures across recent runs — clean sweep.",
      tone: "good",
    });
  });
});
