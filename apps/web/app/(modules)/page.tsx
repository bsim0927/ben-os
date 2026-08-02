import { modules } from "@/lib/modules";

/** The console's own landing page — what exists, and what doesn't yet. */
export default function ConsoleHome() {
  return (
    <div className="flex max-w-3xl flex-col gap-9">
      <section>
        <h1 className="text-ink text-[15px] font-medium">ben-os</h1>
        <p className="text-muted mt-1 text-[13px]">
          Personal admin console. One account, one module at a time.
        </p>
      </section>

      <section>
        <h2 className="text-muted mb-3 text-[11px] tracking-[0.08em] uppercase">Modules</h2>
        <ul className="border-hairline border-t">
          {modules.map((entry) => (
            <li
              key={entry.id}
              className="border-hairline flex items-center justify-between border-b py-2.5 text-[13px]"
            >
              <span className={entry.status === "live" ? "text-ink" : "text-muted"}>
                {entry.label}
              </span>
              <span className="text-muted text-[11px] tracking-[0.06em] uppercase">
                {entry.status === "live" ? "Ready" : "Soon"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
