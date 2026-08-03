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

export const consoleButtonClassName =
  "border-hairline bg-panel-2 text-ink hover:border-accent w-full rounded-md border px-3 py-2 text-[13px] disabled:opacity-50";
