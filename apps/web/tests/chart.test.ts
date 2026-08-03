import { describe, expect, it } from "vitest";

import { areaChartGeometry, type ChartDatum } from "@/lib/chart";

const box = {
  width: 100,
  height: 100,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** Evenly spaced so a point's x is readable straight off the index. */
function data(...values: number[]): ChartDatum[] {
  return values.map((value, index) => ({ x: index, y: value }));
}

describe("areaChartGeometry", () => {
  it("spreads points across the plot's full width", () => {
    const { points } = areaChartGeometry({ data: data(0, 0, 0), ...box });

    expect(points.map((point) => point.x)).toEqual([0, 50, 100]);
  });

  it("puts a bigger value higher up the box, since SVG y grows downward", () => {
    const { points } = areaChartGeometry({ data: data(0, 100), ...box });

    expect(points[0].y).toBeGreaterThan(points[1].y);
  });

  it("insets the plot by the padding it was given", () => {
    const { points } = areaChartGeometry({
      data: data(0, 0),
      width: 100,
      height: 100,
      padding: { top: 10, right: 20, bottom: 30, left: 40 },
    });

    expect(points[0].x).toBe(40);
    expect(points[1].x).toBe(80);
  });

  it("spaces points by their x value, not their position in the list", () => {
    // Polls are not evenly spaced — a missed day is a wider gap, and pretending
    // otherwise would draw a chart whose x-axis means nothing.
    const { points } = areaChartGeometry({
      data: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 10, y: 1 },
      ],
      ...box,
    });

    expect(points.map((point) => point.x)).toEqual([0, 10, 100]);
  });

  it("draws the line through every point", () => {
    const { line } = areaChartGeometry({ data: data(0, 100), ...box });

    expect(line).toBe("M 0 100 L 100 0");
  });

  it("closes the area down to the plot's floor so the fill has a base", () => {
    const { area } = areaChartGeometry({ data: data(50, 50), ...box });

    expect(area.startsWith("M 0 ")).toBe(true);
    expect(area.endsWith("L 100 100 L 0 100 Z")).toBe(true);
  });

  it("marks the last point as the endpoint to emphasise", () => {
    const { endpoint, points } = areaChartGeometry({ data: data(1, 2, 3), ...box });

    expect(endpoint).toEqual(points[2]);
  });

  it("rounds the y scale outward to readable gridline values", () => {
    const { gridlines } = areaChartGeometry({ data: data(1_020, 1_480), ...box });

    expect(gridlines.map((line) => line.value)).toEqual([1_000, 1_200, 1_400, 1_600]);
  });

  it("keeps every point inside the plot the gridlines describe", () => {
    const { points } = areaChartGeometry({ data: data(1_020, 1_480), ...box });

    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
    }
  });

  it("gives a dead-flat series a band to sit in rather than dividing by zero", () => {
    const { points, gridlines } = areaChartGeometry({ data: data(500, 500), ...box });

    for (const point of points) {
      expect(Number.isFinite(point.y)).toBe(true);
    }

    expect(gridlines.length).toBeGreaterThan(1);
  });

  it("puts a lone point at the end of the plot, where the endpoint belongs", () => {
    const { points, line, area } = areaChartGeometry({ data: data(42), ...box });

    expect(points).toHaveLength(1);
    expect(points[0].x).toBe(100);
    // One reading is not a trend: there is a dot, and nothing to stroke or fill.
    expect(line).toBe("");
    expect(area).toBe("");
  });

  it("has nothing to draw with no data at all", () => {
    const geometry = areaChartGeometry({ data: [], ...box });

    expect(geometry.points).toEqual([]);
    expect(geometry.endpoint).toBeNull();
    expect(geometry.line).toBe("");
  });
});
