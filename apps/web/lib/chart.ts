/**
 * SVG geometry for an area chart, with no opinion about what is being charted.
 *
 * Kept apart from the component that draws it because everything hard here is
 * arithmetic — the y scale rounding outward to readable gridlines, points spaced
 * by their x *value* so a missed poll reads as a gap, the flat-series case that
 * would otherwise divide by zero. That is all testable without a DOM, and the
 * component that consumes it is then only markup.
 *
 * No chart library: the one chart this app needs is an area with gridlines and
 * an emphasised endpoint, and the dependency would cost more than the arithmetic
 * below.
 */

/** A datum in *domain* space — x is usually a timestamp, y the value plotted. */
export type ChartDatum = {
  x: number;
  y: number;
};

/** A point in *screen* space, inside the box's plot area. */
export type ChartPoint = {
  x: number;
  y: number;
  datum: ChartDatum;
};

export type Gridline = {
  /** Screen y of the line. */
  y: number;
  /** The domain value it marks, for the axis label. */
  value: number;
};

export type AreaChartGeometry = {
  points: ChartPoint[];
  /** `d` for the stroked line. Empty when there is nothing to stroke. */
  line: string;
  /** `d` for the filled area, closed down to the plot floor. */
  area: string;
  gridlines: Gridline[];
  /** The last point — the one the chart emphasises. */
  endpoint: ChartPoint | null;
};

export type Padding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type AreaChartInput = {
  data: readonly ChartDatum[];
  width: number;
  height: number;
  padding: Padding;
};

/** Gridlines to aim for; the nice-number rounding may land on one either side. */
const TICK_COUNT = 4;

export function areaChartGeometry({
  data,
  width,
  height,
  padding,
}: AreaChartInput): AreaChartGeometry {
  const left = padding.left;
  const right = width - padding.right;
  const top = padding.top;
  const bottom = height - padding.bottom;

  if (data.length === 0) {
    return { points: [], line: "", area: "", gridlines: [], endpoint: null };
  }

  const scale = niceScale(
    Math.min(...data.map((datum) => datum.y)),
    Math.max(...data.map((datum) => datum.y)),
    TICK_COUNT,
  );

  const xMin = Math.min(...data.map((datum) => datum.x));
  const xMax = Math.max(...data.map((datum) => datum.x));
  const xSpan = xMax - xMin;

  const points = data.map((datum) => ({
    // A single reading — or several taken at the same instant — has no span to
    // spread over, so it sits at the end of the plot, where the latest value goes.
    x: round(xSpan === 0 ? right : left + ((datum.x - xMin) / xSpan) * (right - left)),
    y: round(bottom - ((datum.y - scale.min) / (scale.max - scale.min)) * (bottom - top)),
    datum,
  }));

  const gridlines = scale.ticks.map((value) => ({
    y: round(bottom - ((value - scale.min) / (scale.max - scale.min)) * (bottom - top)),
    value,
  }));

  // One point is a dot, not a trend; stroking or filling it would draw a
  // zero-length path that some renderers turn into a stray cap.
  const line =
    points.length < 2 ? "" : points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const area =
    line === ""
      ? ""
      : `${line} L ${points[points.length - 1].x} ${round(bottom)} L ${points[0].x} ${round(bottom)} Z`;

  return { points, line, area, gridlines, endpoint: points[points.length - 1] };
}

/**
 * A y scale whose bounds land on round numbers, so the gridline labels read as
 * money rather than as whatever the data happened to reach.
 */
function niceScale(
  dataMin: number,
  dataMax: number,
  tickCount: number,
): { min: number; max: number; ticks: number[] } {
  let min = dataMin;
  let max = dataMax;

  // A balance that has not moved still needs a band to sit in — otherwise the
  // scale has zero height and every point divides by zero.
  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.02, 1);

    min -= pad;
    max += pad;
  }

  const step = niceStep((max - min) / Math.max(tickCount - 1, 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];

  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    ticks.push(round(value));
  }

  return { min: niceMin, max: niceMax, ticks };
}

/** The 1/2/5/10 progression, which is what makes a tick value readable at a glance. */
function niceStep(rawStep: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

  return factor * magnitude;
}

/** Path strings carry no more precision than a screen can show. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
