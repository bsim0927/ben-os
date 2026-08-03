import { describe, expect, it } from "vitest";

import {
  areaChartGeometry,
  donutGeometry,
  waterfallGeometry,
  type ChartDatum,
  type WaterfallBarInput,
} from "@/lib/chart";

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

describe("waterfallGeometry", () => {
  /** Six columns across 120px of plot leaves each one a round 20 wide. */
  const wide = {
    width: 120,
    height: 100,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    gap: 0,
  };

  /** A bridge that starts at 100, gains 40, loses 20, and ends at 120. */
  const bridge: WaterfallBarInput[] = [
    { from: 0, to: 100, total: true },
    { from: 100, to: 140, total: false },
    { from: 140, to: 120, total: false },
    { from: 0, to: 120, total: true },
  ];

  it("gives every input a bar, evenly spaced across the plot", () => {
    const { bars } = waterfallGeometry({ bars: bridge, ...wide, width: 80 });

    expect(bars).toHaveLength(4);
    expect(bars.map((bar) => bar.x)).toEqual([0, 20, 40, 60]);
    expect(bars.every((bar) => bar.width === 20)).toBe(true);
  });

  it("takes the gap out of the bars rather than out of the plot", () => {
    const { bars } = waterfallGeometry({ bars: bridge, ...wide, width: 80, gap: 4 });

    expect(bars.map((bar) => bar.width)).toEqual([17, 17, 17, 17]);
    expect(bars[3].x + bars[3].width).toBe(80);
  });

  it("anchors a total bar to the plot floor, so it reads as a balance", () => {
    const { bars, floor } = waterfallGeometry({ bars: bridge, ...wide });

    expect(bars[0].y + bars[0].height).toBe(floor);
    expect(bars[3].y + bars[3].height).toBe(floor);
  });

  it("floats a change bar between the balances either side of it", () => {
    const { bars } = waterfallGeometry({ bars: bridge, ...wide });

    // The rise from 100 sits on top of where the start bar ends.
    expect(bars[1].y + bars[1].height).toBe(bars[0].y);
    // And the fall that follows starts where the rise left off.
    expect(bars[2].y).toBe(bars[1].y);
  });

  it("draws a rise and a fall of the same size at the same height", () => {
    const { bars } = waterfallGeometry({
      bars: [
        { from: 100, to: 140, total: false },
        { from: 140, to: 100, total: false },
      ],
      ...wide,
    });

    expect(bars[0].height).toBe(bars[1].height);
  });

  it("says which way each change went, since the height alone cannot", () => {
    const { bars } = waterfallGeometry({ bars: bridge, ...wide });

    expect(bars.map((bar) => bar.direction)).toEqual(["total", "up", "down", "total"]);
  });

  it("leaves a hairline where a segment came to nothing, rather than no bar at all", () => {
    // A period with no fees is a fact about the period; a segment that vanished
    // would read as one the bridge forgot to draw.
    const { bars } = waterfallGeometry({
      bars: [{ from: 100, to: 100, total: false }, ...bridge],
      ...wide,
    });

    expect(bars[0].height).toBeGreaterThan(0);
  });

  it("joins each bar's head to the foot of the next", () => {
    const { bars, connectors } = waterfallGeometry({ bars: bridge, ...wide });

    expect(connectors).toHaveLength(3);
    expect(connectors[0]).toMatchObject({ x1: bars[0].x + bars[0].width, x2: bars[1].x });
    // The connector sits at the running balance the two bars share.
    expect(connectors[0].y).toBe(bars[0].y);
    expect(connectors[1].y).toBe(bars[1].y);
  });

  it("leaves room below the lowest balance so a total bar is never a sliver", () => {
    // Every value in a brokerage bridge is within a few percent of the others,
    // so a floor at the minimum would flatten Start and End to nothing.
    const { bars, floor } = waterfallGeometry({
      bars: [
        { from: 0, to: 10_000, total: true },
        { from: 10_000, to: 10_500, total: false },
        { from: 0, to: 10_500, total: true },
      ],
      ...wide,
    });

    expect(bars[0].height).toBeGreaterThan(floor * 0.1);
  });

  it("labels the axis with round numbers", () => {
    const { gridlines } = waterfallGeometry({
      bars: [
        { from: 0, to: 1_020, total: true },
        { from: 0, to: 1_480, total: true },
      ],
      ...wide,
    });

    expect(gridlines.map((line) => line.value)).toContain(1_400);
    expect(gridlines.every((line) => line.value % 100 === 0)).toBe(true);
  });

  it("keeps every bar inside the box it was given", () => {
    const { bars } = waterfallGeometry({
      bars: bridge,
      width: 120,
      height: 100,
      padding: { top: 10, right: 5, bottom: 20, left: 15 },
      gap: 2,
    });

    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(15);
      expect(bar.x + bar.width).toBeLessThanOrEqual(115);
      expect(bar.y).toBeGreaterThanOrEqual(10);
      expect(bar.y + bar.height).toBeLessThanOrEqual(80);
    }
  });

  it("has nothing to draw with no bars at all", () => {
    const geometry = waterfallGeometry({ bars: [], ...wide });

    expect(geometry.bars).toEqual([]);
    expect(geometry.connectors).toEqual([]);
    expect(geometry.gridlines).toEqual([]);
  });
});

describe("donutGeometry", () => {
  const ring = { size: 100, thickness: 20 };

  it("gives each slice its share of the whole", () => {
    const { slices } = donutGeometry({ values: [1, 3], ...ring });

    expect(slices.map((slice) => slice.share)).toEqual([0.25, 0.75]);
  });

  it("runs the slices end to end around the full circle, in the order given", () => {
    const { slices } = donutGeometry({ values: [1, 1, 2], ...ring });

    expect(slices.map((slice) => slice.startAngle)).toEqual([0, 0.25, 0.5]);
    expect(slices.map((slice) => slice.endAngle)).toEqual([0.25, 0.5, 1]);
  });

  it("keeps the index of the value each slice came from, so a legend can line up with it", () => {
    // Zero-valued entries are dropped, which would otherwise shift every colour
    // after them by one.
    const { slices } = donutGeometry({ values: [3, 0, 1], ...ring });

    expect(slices.map((slice) => slice.index)).toEqual([0, 2]);
  });

  it("leaves out a slice with nothing in it, rather than drawing a zero-width wedge", () => {
    const { slices } = donutGeometry({ values: [1, 0, -5], ...ring });

    expect(slices).toHaveLength(1);
    expect(slices[0].share).toBe(1);
  });

  it("draws a single holding as a closed ring rather than a wedge that ends where it began", () => {
    // An arc of exactly 360° has the same start and end point, which every SVG
    // renderer draws as nothing at all.
    const [slice] = donutGeometry({ values: [42], ...ring }).slices;

    expect(slice.share).toBe(1);
    // Two arcs, because one cannot close a full circle.
    expect(slice.path.match(/A/g)).toHaveLength(4);
  });

  it("has nothing to draw when every value is empty", () => {
    expect(donutGeometry({ values: [0, 0], ...ring }).slices).toEqual([]);
    expect(donutGeometry({ values: [], ...ring }).slices).toEqual([]);
  });

  it("keeps the ring inside the box it was given", () => {
    const { radius, innerRadius, center } = donutGeometry({ values: [1, 1], ...ring });

    expect(center).toEqual({ x: 50, y: 50 });
    expect(radius).toBe(50);
    expect(innerRadius).toBe(30);
  });
});
