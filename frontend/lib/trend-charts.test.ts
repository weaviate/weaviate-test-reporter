import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const trendChartsPath = path.join(
  process.cwd(),
  "components",
  "TrendCharts.tsx",
);

describe("TrendCharts no-data marker", () => {
  it("keeps the no-data bar visible with a minPointSize", () => {
    const source = readFileSync(trendChartsPath, "utf8");
    expect(source).toMatch(
      /dataKey="noData"[\s\S]*minPointSize=\{NO_DATA_MARKER_MIN_POINT_SIZE\}/,
    );
  });
});
