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

/** One column of a waterfall, in *domain* space. */
export type WaterfallBarInput = {
  /** The running value the bar starts from. Ignored when `total`. */
  from: number;
  /** The running value it ends at. */
  to: number;
  /** A magnitude rather than a change: drawn from the axis, not floating. */
  total: boolean;
};

export type WaterfallBar = {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Which way the column went. A bar's height is its magnitude and says nothing
   * about sign, so this is what a colour (and a reader) has to go on.
   */
  direction: "total" | "up" | "down" | "flat";
  input: WaterfallBarInput;
};

export type WaterfallConnector = {
  x1: number;
  x2: number;
  y: number;
};

export type WaterfallGeometry = {
  bars: WaterfallBar[];
  /** The dotted rules carrying each running value across to the next column. */
  connectors: WaterfallConnector[];
  gridlines: Gridline[];
  /** Screen y of the plot's base, which the total bars stand on. */
  floor: number;
};

export type WaterfallInput = {
  bars: readonly WaterfallBarInput[];
  width: number;
  height: number;
  padding: Padding;
  /** Space between columns, taken out of the bars so the row still spans the plot. */
  gap?: number;
};

/**
 * A change of nothing is still a segment. Without a minimum the column would be
 * zero pixels tall and read as one the chart forgot rather than one that came
 * to nothing.
 */
const MIN_BAR_HEIGHT = 1;

/**
 * How much room to leave below the lowest value, as a share of the span.
 *
 * A balance bridge's values sit within a percent or two of each other — start
 * 10,000, end 10,500 — so a floor at the minimum would flatten the Start column
 * to nothing while the changes it is meant to explain took the whole box. The
 * headroom buys the totals a visible base without misleading about the scale,
 * which the gridlines label honestly either way.
 */
const FLOOR_HEADROOM = 0.15;

/**
 * SVG geometry for a waterfall: totals standing on the axis, changes floating
 * between the running values either side of them.
 *
 * Here rather than in the component for the reason `areaChartGeometry` is: the
 * hard parts are the scale that has to leave the totals a base and the sign that
 * survives being turned into a height, and both are arithmetic that can be
 * tested without a DOM.
 */
export function waterfallGeometry({
  bars,
  width,
  height,
  padding,
  gap = 0,
}: WaterfallInput): WaterfallGeometry {
  const left = padding.left;
  const right = width - padding.right;
  const top = padding.top;
  const bottom = height - padding.bottom;

  if (bars.length === 0) {
    return { bars: [], connectors: [], gridlines: [], floor: bottom };
  }

  // A total's `from` is the axis, not a value — including it would drag the
  // scale down to zero and flatten everything the bridge is about.
  const values = bars.flatMap((bar) => (bar.total ? [bar.to] : [bar.from, bar.to]));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const headroom = Math.max((hi - lo) * FLOOR_HEADROOM, Math.abs(hi) * 0.01, 1);
  const scale = niceScale(lo - headroom, hi, TICK_COUNT);

  const span = scale.max - scale.min;
  const barWidth = (right - left - gap * (bars.length - 1)) / bars.length;
  const y = (value: number) => round(bottom - ((value - scale.min) / span) * (bottom - top));

  const placed = bars.map((input, index) => {
    // A total stands on the floor; a change hangs between its own two values.
    const foot = input.total ? scale.min : input.from;
    const head = input.to;
    const yTop = y(Math.max(foot, head));
    const yBottom = y(Math.min(foot, head));

    return {
      x: round(left + index * (barWidth + gap)),
      y: yTop,
      width: round(barWidth),
      height: round(Math.max(yBottom - yTop, MIN_BAR_HEIGHT)),
      direction: input.total
        ? ("total" as const)
        : head > input.from
          ? ("up" as const)
          : head < input.from
            ? ("down" as const)
            : ("flat" as const),
      input,
    };
  });

  const connectors = placed.slice(0, -1).map((bar, index) => ({
    x1: round(bar.x + bar.width),
    x2: placed[index + 1].x,
    // At the running value the two columns share, which is what makes the row
    // read as one continuous balance rather than five unrelated bars.
    y: y(bar.input.to),
  }));

  const gridlines = scale.ticks.map((value) => ({ y: y(value), value }));

  return { bars: placed, connectors, gridlines, floor: bottom };
}

/** One wedge of a donut, in *screen* space. */
export type DonutSlice = {
  /** `d` for the annular sector, ready to fill. */
  path: string;
  /** Turns clockwise from twelve o'clock, in [0, 1] — a fraction, not radians. */
  startAngle: number;
  endAngle: number;
  /** This slice's share of the total, which is `endAngle − startAngle`. */
  share: number;
  value: number;
  /**
   * Which input this slice came from.
   *
   * Carried because empty values are dropped rather than drawn: without it, a
   * legend colouring by position would shift every entry after a zero.
   */
  index: number;
};

export type DonutGeometry = {
  slices: DonutSlice[];
  center: { x: number; y: number };
  radius: number;
  innerRadius: number;
};

export type DonutInput = {
  /** Parallel to the caller's own list; empty and negative values are skipped. */
  values: readonly number[];
  /** The box is square, so one dimension says it all. */
  size: number;
  /** The ring's width — the hole is `size / 2 − thickness` across. */
  thickness: number;
};

/**
 * SVG geometry for a donut, drawn clockwise from twelve o'clock.
 *
 * Here rather than in the component for the reason the other two geometries are:
 * the hard parts — the full-circle case that no single arc can close, and the
 * dropped empties that would otherwise slide a legend's colours along by one —
 * are arithmetic, and arithmetic is testable without a DOM.
 *
 * A share of the whole is the only thing a donut can honestly show, so there is
 * no scale and no axis here: every slice is its value over the total.
 */
export function donutGeometry({ values, size, thickness }: DonutInput): DonutGeometry {
  const radius = size / 2;
  const innerRadius = Math.max(radius - thickness, 0);
  const center = { x: radius, y: radius };

  // Negative values are dropped rather than reflected: a short position has no
  // meaningful slice of an allocation, and drawing it as though it did would
  // make the shares sum to something other than the account.
  const present = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0);
  const total = present.reduce((sum, entry) => sum + entry.value, 0);

  if (total === 0) {
    return { slices: [], center, radius, innerRadius };
  }

  let turned = 0;

  const slices = present.map(({ value, index }) => {
    const share = value / total;
    const startAngle = turned;
    // Accumulated rather than summed from scratch so the slices meet exactly,
    // leaving no hairline of background between two adjacent wedges.
    const endAngle = index === present[present.length - 1].index ? 1 : turned + share;

    turned = endAngle;

    return {
      path: annularSector(center, radius, innerRadius, startAngle, endAngle),
      startAngle: round(startAngle),
      endAngle: round(endAngle),
      share: round(share),
      value,
      index,
    };
  });

  return { slices, center, radius, innerRadius };
}

/**
 * The wedge between two turns, as a path.
 *
 * A full turn is split into two half arcs, because an arc whose start and end
 * points coincide is degenerate — every renderer draws exactly nothing for it,
 * which is the wrong answer for the common case of an account holding one thing.
 */
function annularSector(
  center: { x: number; y: number },
  radius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  if (endAngle - startAngle >= 1) {
    return `${ring(center, radius, 1)} ${ring(center, innerRadius, 0)}`;
  }

  const outerStart = onCircle(center, radius, startAngle);
  const outerEnd = onCircle(center, radius, endAngle);
  const innerEnd = onCircle(center, innerRadius, endAngle);
  const innerStart = onCircle(center, innerRadius, startAngle);
  const large = endAngle - startAngle > 0.5 ? 1 : 0;

  return (
    `M ${outerStart.x} ${outerStart.y} ` +
    `A ${radius} ${radius} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y} ` +
    `L ${innerEnd.x} ${innerEnd.y} ` +
    `A ${innerRadius} ${innerRadius} 0 ${large} 0 ${innerStart.x} ${innerStart.y} Z`
  );
}

/** A closed circle as two half arcs, wound the given way so the hole punches out. */
function ring(center: { x: number; y: number }, radius: number, sweep: 0 | 1): string {
  const top = onCircle(center, radius, 0);
  const bottom = onCircle(center, radius, 0.5);

  return (
    `M ${top.x} ${top.y} ` +
    `A ${radius} ${radius} 0 0 ${sweep} ${bottom.x} ${bottom.y} ` +
    `A ${radius} ${radius} 0 0 ${sweep} ${top.x} ${top.y} Z`
  );
}

/** Clockwise from twelve o'clock, which is where a reader starts. */
function onCircle(
  center: { x: number; y: number },
  radius: number,
  angle: number,
): { x: number; y: number } {
  const radians = angle * 2 * Math.PI - Math.PI / 2;

  return {
    x: round(center.x + radius * Math.cos(radians)),
    y: round(center.y + radius * Math.sin(radians)),
  };
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
