import { describe, it, expect } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { TrendCharts } from "../components/TrendCharts";

type PropsNode = ReactElement<Record<string, unknown>>;

function isPropsNode(node: ReactNode): node is PropsNode {
  return isValidElement(node);
}

function flatten(node: ReactNode): PropsNode[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isPropsNode(node)) return [];
  return [node, ...flatten(node.props.children as ReactNode)];
}

describe("TrendCharts no-data marker", () => {
  it("keeps the no-data bar visible with a minPointSize", () => {
    const tree = TrendCharts({
      data: [
        {
          day: "2026-09-14",
          runs: 0,
          passingRuns: 0,
          tests: 0,
          testsPassed: 0,
          failures: 0,
          infraFailures: 0,
          testsSkipped: 0,
          passRate: null,
          avgDurationMs: null,
        },
      ],
    });
    const noDataBar = flatten(tree).find(
      (node) =>
        node.props.dataKey === "noData" &&
        node.props.fill === "var(--wv-fog-muted)",
    );
    expect(noDataBar).toBeTruthy();
    expect(noDataBar?.props.minPointSize).toBe(6);
  });
});
