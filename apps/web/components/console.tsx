/** Shared pieces of the Console identity, used by the shell, the login page, and modules. */

export function Wordmark() {
  return (
    <p className="text-muted font-mono text-[13px] tracking-[0.08em]">
      <b className="text-ink font-semibold">ben</b>/os
    </p>
  );
}

/**
 * The uppercase micro-label that heads a section. `as` picks the heading level
 * so the identity doesn't force a document outline on its callers.
 */
export function MicroLabel({
  children,
  as: Tag = "h2",
  className = "",
}: {
  children: React.ReactNode;
  as?: "h1" | "h2" | "h3" | "h4";
  className?: string;
}) {
  return (
    <Tag className={`text-muted text-[11px] tracking-[0.08em] uppercase ${className}`.trim()}>
      {children}
    </Tag>
  );
}

/**
 * The Console's segmented control: one row of buttons, exactly one pressed.
 *
 * Shared because the overview now carries two of them — the chart's range and
 * the flow period — and two hand-rolled copies would drift in look and, worse,
 * in what `aria-pressed` is on. The `label` is what tells a screen reader (and a
 * test) which of the two is being reached for, so it is required.
 */
export function SegmentedToggle<Option extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly Option[];
  selected: Option;
  onChange: (next: Option) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="border-hairline bg-panel-2 flex overflow-hidden rounded-md border"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === selected}
          onClick={() => onChange(option)}
          className={`border-hairline px-3 py-1.5 text-[12px] tracking-[0.04em] not-first:border-l ${
            option === selected ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export const consoleButtonClassName =
  "border-hairline bg-panel-2 text-ink hover:border-accent w-full rounded-md border px-3 py-2 text-[13px] disabled:opacity-50";
