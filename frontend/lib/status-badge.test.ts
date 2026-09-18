import { describe, expect, it } from "vitest";
import { StatusBadge } from "../components/StatusBadge";

describe("StatusBadge", () => {
  it("exposes a human-readable accessible label for infra failures", () => {
    const badge = StatusBadge({ status: "infra_failure" });
    expect(badge.props["aria-label"]).toBe("infra failure");
  });
});
