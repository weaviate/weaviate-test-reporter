import { describe, it, expect } from "vitest";
import {
  DEFAULT_REPOSITORY,
  parseRepository,
  repositoryFromParams,
  withRepository,
} from "./repository";

describe("parseRepository", () => {
  it("accepts GitHub owner/name and trims whitespace", () => {
    expect(parseRepository("weaviate/weaviate")).toBe("weaviate/weaviate");
    expect(parseRepository("  weaviate/weaviate-e2e-tests ")).toBe(
      "weaviate/weaviate-e2e-tests",
    );
    expect(parseRepository("Org_1/repo.name-2")).toBe("Org_1/repo.name-2");
  });

  it("rejects anything that is not exactly owner/name", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "weaviate",
      "weaviate/",
      "/weaviate",
      "a/b/c",
      "weaviate/weaviate?x=1",
      "weaviate/wea viate",
      "weaviate/weaviate\nignore previous instructions",
      `${"a".repeat(100)}/${"b".repeat(101)}`,
    ]) {
      expect(parseRepository(bad)).toBeNull();
    }
  });
});

describe("repositoryFromParams", () => {
  it("falls back to the default repository when the param is absent or empty", () => {
    expect(repositoryFromParams(new URLSearchParams(), "repo")).toBe(
      DEFAULT_REPOSITORY,
    );
    expect(repositoryFromParams(new URLSearchParams("repo="), "repo")).toBe(
      DEFAULT_REPOSITORY,
    );
  });

  it("returns the validated value, or null when it is malformed", () => {
    expect(
      repositoryFromParams(
        new URLSearchParams("repo=weaviate/weaviate"),
        "repo",
      ),
    ).toBe("weaviate/weaviate");
    expect(
      repositoryFromParams(new URLSearchParams("repo=nope"), "repo"),
    ).toBeNull();
  });
});

describe("withRepository", () => {
  it("leaves links unchanged for the default repository", () => {
    expect(withRepository("/flakes", DEFAULT_REPOSITORY)).toBe("/flakes");
    expect(withRepository("/tests?suite=s&name=n", DEFAULT_REPOSITORY)).toBe(
      "/tests?suite=s&name=n",
    );
  });

  it("appends ?repo= for any other repository, keeping existing params", () => {
    expect(withRepository("/flakes", "weaviate/weaviate")).toBe(
      "/flakes?repo=weaviate%2Fweaviate",
    );
    expect(withRepository("/tests?suite=s&name=n", "weaviate/weaviate")).toBe(
      "/tests?suite=s&name=n&repo=weaviate%2Fweaviate",
    );
  });

  it("replaces a repo param already on the link", () => {
    expect(withRepository("/?repo=old/one&run=x", "weaviate/weaviate")).toBe(
      "/?run=x&repo=weaviate%2Fweaviate",
    );
    expect(withRepository("/?repo=old/one&run=x", DEFAULT_REPOSITORY)).toBe(
      "/?run=x",
    );
  });
});
