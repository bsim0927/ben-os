import { MicroLabel } from "@/components/console";

/**
 * The console's own landing page. Deliberately thin: the sidebar already says
 * what modules exist and which are built, and repeating it here would give the
 * same fact two places to drift.
 */
export default function ConsoleHome() {
  return (
    <div className="flex max-w-3xl flex-col gap-9">
      <section>
        <h1 className="text-ink text-[15px] font-medium">ben-os</h1>
        <p className="text-muted mt-1 text-[13px]">
          Personal admin console. Modules become available in the sidebar as they are built.
        </p>
      </section>

      <section>
        <MicroLabel className="mb-3">Status</MicroLabel>
        <p className="border-hairline text-muted border-t pt-3 text-[13px]">
          Nothing is connected to data yet — the first source arrives with Financials.
        </p>
      </section>
    </div>
  );
}
