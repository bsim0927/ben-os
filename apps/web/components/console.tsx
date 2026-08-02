/** Shared pieces of the Console identity, used by both the shell and the login page. */

export function Wordmark() {
  return (
    <p className="text-muted font-mono text-[13px] tracking-[0.08em]">
      <b className="text-ink font-semibold">ben</b>/os
    </p>
  );
}

export const consoleButtonClassName =
  "border-hairline bg-panel-2 text-ink hover:border-accent w-full rounded-md border px-3 py-2 text-[13px] disabled:opacity-50";
