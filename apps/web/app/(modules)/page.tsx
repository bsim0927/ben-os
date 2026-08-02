/**
 * The console's own landing page. Deliberately thin: the sidebar already says
 * what modules exist and which are built, and repeating it here would give the
 * same fact two places to drift.
 */
export default function ConsoleHome() {
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <h1 className="text-ink text-[15px] font-medium">ben-os</h1>
      <p className="text-muted text-[13px]">
        Personal admin console. Modules become available in the sidebar as they are built; none are
        connected to data yet.
      </p>
    </div>
  );
}
