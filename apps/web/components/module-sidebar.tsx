"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { findModule, modules, type ModuleEntry } from "@/lib/modules";

export type Account = {
  name: string;
  initial: string;
  /** Freshness of the data behind the console, shown under the account name. */
  lastSynced: string;
};

/**
 * The persistent left rail. Its contents are entirely a function of the module
 * registry — this component knows how a module looks, never which ones exist.
 */
export function ModuleSidebar({ account }: { account: Account }) {
  const active = findModule(usePathname());

  return (
    <aside className="border-hairline bg-panel flex w-[232px] flex-none flex-col gap-7 border-r px-3 py-5">
      <p className="text-muted px-2 font-mono text-[13px] tracking-[0.08em]">
        <b className="text-ink font-semibold">ben</b>/os
      </p>

      <nav aria-label="Modules">
        <ul className="flex flex-col gap-0.5">
          {modules.map((entry) => (
            <ModuleNavItem key={entry.id} entry={entry} isActive={entry.id === active?.id} />
          ))}
        </ul>
      </nav>

      <div className="flex-1" />

      <div
        data-testid="account-chip"
        className="border-hairline flex items-center gap-2.5 border-t px-2 pt-3"
      >
        <span
          data-testid="avatar"
          className="bg-accent text-bg grid size-[26px] flex-none place-items-center rounded-md text-[12px] font-bold"
        >
          {account.initial}
        </span>
        <span className="min-w-0">
          <span className="text-ink block truncate text-[12px]">{account.name}</span>
          <span className="text-muted block text-[11px]">{account.lastSynced}</span>
        </span>
      </div>
    </aside>
  );
}

function ModuleNavItem({ entry, isActive }: { entry: ModuleEntry; isActive: boolean }) {
  // Unbuilt modules stay in the rail, dimmed and inert: the sidebar shows what
  // the console is for, not only what has shipped.
  const soon = entry.status === "soon";

  const shared = [
    "flex items-center gap-2.5 rounded-md border-l-2 px-2.5 py-2 text-[13.5px]",
    isActive ? "border-l-accent bg-panel-2 text-ink" : "border-l-transparent text-muted",
  ].join(" ");

  const contents = (
    <>
      <ModuleIcon paths={entry.iconPaths} />
      <span>{entry.label}</span>
      {soon ? (
        <span className="border-hairline text-muted ml-auto rounded-full border px-1.5 py-px text-[9.5px] tracking-[0.06em]">
          Soon
        </span>
      ) : null}
    </>
  );

  return (
    // An unbuilt module renders as plain text rather than a disabled control:
    // there is nothing to activate, so there is nothing to mark as disabled.
    // The "Soon" badge is what says so, to screen readers and eyes alike.
    <li
      aria-label={entry.label}
      aria-current={isActive ? "page" : undefined}
      data-status={entry.status}
      className={soon ? "opacity-45" : undefined}
    >
      {soon ? (
        <span className={shared}>{contents}</span>
      ) : (
        <Link href={entry.href} className={`${shared} hover:bg-panel-2 hover:text-ink`}>
          {contents}
        </Link>
      )}
    </li>
  );
}

function ModuleIcon({ paths }: { paths: readonly string[] }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className="size-4 flex-none"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
