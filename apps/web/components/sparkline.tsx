"use client";

import { useId } from "react";

import { areaChartGeometry, type ChartDatum } from "@/lib/chart";

/**
 * A trend at the size of a word — context beside a figure, not a chart.
 *
 * Shares `areaChartGeometry` with the full-size `AreaChart` so the two cannot
 * scale a series differently; what it drops is everything that needs room to be
 * legible: gridlines, axis labels, the value ticks.
 *
 * The text alternative is a sentence rather than the `AreaChart`'s hidden table.
 * A sparkline's job is shape, its endpoint is already printed beside it as a
 * figure, and a screen reader working through thirty rows of dates to rediscover
 * that number would be worse served than by being told what the line does.
 */

const WIDTH = 132;
const HEIGHT = 34;
/** Enough for the endpoint marker not to clip against the box. */
const PADDING = { top: 4, right: 5, bottom: 4, left: 4 };

export type SparklineProps = {
  data: readonly ChartDatum[];
  /** What the line shows, read out in place of it. */
  label: string;
};

export function Sparkline({ data, label }: SparklineProps) {
  const fillId = useId();
  const { line, area, endpoint } = areaChartGeometry({
    data,
    width: WIDTH,
    height: HEIGHT,
    padding: PADDING,
  });

  // One point is a dot, not a trend — `areaChartGeometry` declines to stroke it,
  // and an empty box beside the figures says less than nothing.
  if (line === "") return null;

  return (
    <span className="inline-flex items-center">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="text-accent" stopColor="currentColor" stopOpacity="0.24" />
            <stop offset="100%" className="text-accent" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${fillId})`} />
        <path
          d={line}
          fill="none"
          className="stroke-accent"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {endpoint ? (
          <circle cx={endpoint.x} cy={endpoint.y} r={2.5} className="fill-accent" />
        ) : null}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
