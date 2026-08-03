import { describe, expect, it } from "vitest";

import {
  formatAmount,
  formatCompactAmount,
  formatDay,
  formatPercent,
  formatSignedAmount,
  formatTimestamp,
} from "@/lib/financials/format";

describe("formatAmount", () => {
  it("renders an ISO currency with its symbol", () => {
    expect(formatAmount(1_500.5, "USD")).toBe("$1,500.50");
  });

  it("falls back to a plain number for a currency Intl would throw on", () => {
    // SimpleFIN allows a URL as a currency (rewards points), and a thrown
    // formatter would take the whole page down.
    expect(formatAmount(12_000, "https://mycurrency.test/points")).toBe("12,000.00");
  });

  it("renders without a symbol when no currency is known", () => {
    expect(formatAmount(12_000)).toBe("12,000.00");
  });

  it("always shows cents, so a column of balances lines up", () => {
    expect(formatAmount(12, "USD")).toBe("$12.00");
  });

  it("says nothing rather than NaN when the value isn't a number", () => {
    expect(formatAmount(Number.NaN, "USD")).toBe("—");
  });
});

describe("formatSignedAmount", () => {
  it("marks a rise with a plus", () => {
    expect(formatSignedAmount(2_340, "USD")).toBe("+$2,340.00");
  });

  it("marks a fall with a real minus sign, not a hyphen", () => {
    expect(formatSignedAmount(-2_340, "USD")).toBe("−$2,340.00");
  });

  it("puts the sign outside the currency symbol, where it reads as a change", () => {
    expect(formatSignedAmount(-500)).toBe("−500.00");
  });

  it("treats no movement as a non-negative change", () => {
    expect(formatSignedAmount(0, "USD")).toBe("+$0.00");
  });
});

describe("formatCompactAmount", () => {
  it("abbreviates a gridline value", () => {
    expect(formatCompactAmount(105_500, "USD")).toBe("$105.5K");
  });

  it("drops the fraction when the value is round — an axis of $100.0K reads as noise", () => {
    expect(formatCompactAmount(100_000, "USD")).toBe("$100K");
    expect(formatCompactAmount(0, "USD")).toBe("$0");
  });

  it("leaves small values alone", () => {
    expect(formatCompactAmount(999, "USD")).toBe("$999");
  });

  it("falls back to a plain number for a currency Intl would throw on", () => {
    expect(formatCompactAmount(12_000, "https://mycurrency.test/points")).toBe("12K");
  });

  it("says nothing rather than NaN when the value isn't a number", () => {
    expect(formatCompactAmount(Number.NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("renders a ratio to one decimal", () => {
    expect(formatPercent(0.019)).toBe("1.9%");
  });

  it("keeps the sign of a fall", () => {
    expect(formatPercent(-0.25)).toBe("-25.0%");
  });
});

describe("formatTimestamp", () => {
  it("renders to the minute, in UTC", () => {
    expect(formatTimestamp("2026-08-01T12:00:00Z")).toBe("2026-08-01 12:00");
  });

  it("does not reinterpret the sync's UTC timestamps in another zone", () => {
    expect(formatTimestamp("2026-08-01T23:30:00+02:00")).toBe("2026-08-01 21:30");
  });

  it("says nothing for an absent or unparseable timestamp", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("not a date")).toBe("—");
  });
});

describe("formatDay", () => {
  it("renders a UTC day unambiguously, without guessing a locale's date order", () => {
    expect(formatDay("2026-08-01")).toBe("1 Aug 2026");
  });

  it("hands back anything it cannot parse rather than inventing a date", () => {
    expect(formatDay("not a day")).toBe("not a day");
  });
});
