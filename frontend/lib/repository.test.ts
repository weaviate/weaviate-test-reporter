import { describe, it, expect } from "vitest";
import {
  DEFAULT_REPOSITORY,
  parseRepository,
  repositoryFromBody,
  repositoryFromParams,
  runHref,
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

  it("limits the owner to 39 characters and the name to 100", () => {
    const longest = `${"a".repeat(39)}/${"b".repeat(100)}`;
    expect(parseRepository(longest)).toBe(longest);
    expect(parseRepository(`${"a".repeat(40)}/repo`)).toBeNull();
    expect(parseRepository(`owner/${"b".repeat(101)}`)).toBeNull();
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

describe("repositoryFromBody", () => {
  it("falls back to the default repository when the field is absent, null or blank", () => {
    for (const v of [undefined, null, "", "  "]) {
      expect(repositoryFromBody(v)).toBe(DEFAULT_REPOSITORY);
    }
  });

  it("returns the validated value, or null when it is malformed or not a string", () => {
    expect(repositoryFromBody(" weaviate/weaviate ")).toBe("weaviate/weaviate");
    for (const v of ["weaviate", "a/b/c", 42, {}, ["weaviate/weaviate"]]) {
      expect(repositoryFromBody(v)).toBeNull();
    }
  });
});

describe("runHref", () => {
  it("links the Test Explorer to one run, scoped to its repository", () => {
    expect(runHref("8c6672c1", DEFAULT_REPOSITORY)).toBe("/?run=8c6672c1");
    expect(runHref("8c6672c1", "weaviate/weaviate")).toBe(
      "/?run=8c6672c1&repo=weaviate%2Fweaviate",
    );
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
