"use client";

import { usePathname } from "next/navigation";

import { crumbFor } from "@/lib/modules";

/**
 * `<Module> / <page>` plus a right-aligned freshness chip, sitting above every
 * module's content. Both halves are shell-owned: a module never renders here.
 *
 * `syncStatus` comes from the server layout so that surfacing a broken or
 * expired connection later is a change there, not here.
 */
export function CrumbRow({ syncStatus }: { syncStatus: string }) {
  const crumb = crumbFor(usePathname());

  return (
    <header className="flex items-center justify-between px-9 pt-7 pb-6">
      <p data-testid="crumb" className="text-muted text-[12.5px]">
        <b className="text-ink font-medium">{crumb.module}</b> / {crumb.page}
      </p>
      <span className="border-hairline text-muted rounded-full border px-2.5 py-[3px] text-[11.5px]">
        {syncStatus}
      </span>
    </header>
  );
}
