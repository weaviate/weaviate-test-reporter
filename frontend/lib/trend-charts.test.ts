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
  it("renders the no-data bar with a fixed-height marker shape", () => {
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
    const shape = noDataBar?.props.shape as ReactNode;
    expect(isPropsNode(shape)).toBe(true);
    const marker = isPropsNode(shape)
      ? (shape.type as (props: Record<string, unknown>) => ReactNode)({
          x: 10,
          y: 120,
          width: 8,
          height: 0.25,
          fill: "var(--wv-fog-muted)",
          fillOpacity: 0.35,
        })
      : null;
    const markerNode = marker as ReactNode;
    expect(isPropsNode(markerNode)).toBe(true);
    if (!isPropsNode(markerNode)) throw new Error("expected marker shape");
    expect(markerNode.props.height).toBe(6);

    // A window of only no-data days scales the noData value of 1 to the full
    // chart height — the marker must stay 6px, anchored at the baseline.
    const tall = isPropsNode(shape)
      ? (shape.type as (props: Record<string, unknown>) => ReactNode)({
          x: 10,
          y: 4,
          width: 8,
          height: 150,
          fill: "var(--wv-fog-muted)",
          fillOpacity: 0.35,
        })
      : null;
    const tallNode = tall as ReactNode;
    if (!isPropsNode(tallNode)) throw new Error("expected marker shape");
    expect(tallNode.props.height).toBe(6);
    expect(tallNode.props.y).toBe(148); // baseline (4 + 150) minus the 6px marker
  });
});
