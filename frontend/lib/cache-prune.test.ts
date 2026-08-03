import { describe, it, expect } from "vitest";
import { staleCacheFiles, CACHE_MAX_AGE_MS } from "./cache-prune";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("staleCacheFiles", () => {
  const now = 1_800_000_000_000;

  it("selects only files older than the max age", () => {
    const out = staleCacheFiles(
      [
        { name: "today", mtimeMs: now - 1000 },
        { name: "yesterday", mtimeMs: now - DAY_MS },
        { name: "ancient", mtimeMs: now - 7 * DAY_MS },
      ],
      now,
    );
    expect(out).toEqual(["ancient"]);
  });

  it("keeps a file exactly at the boundary (strict >)", () => {
    const out = staleCacheFiles(
      [{ name: "edge", mtimeMs: now - CACHE_MAX_AGE_MS }],
      now,
    );
    expect(out).toEqual([]);
  });

  it("honors a custom max age", () => {
    const out = staleCacheFiles(
      [{ name: "old", mtimeMs: now - 2000 }],
      now,
      1000,
    );
    expect(out).toEqual(["old"]);
  });

  it("returns [] for no files", () => {
    expect(staleCacheFiles([], now)).toEqual([]);
  });
});
