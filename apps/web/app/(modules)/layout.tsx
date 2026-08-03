import { redirect } from "next/navigation";

import { CrumbRow } from "@/components/crumb-row";
import { ModuleSidebar } from "@/components/module-sidebar";
import { authorizedUserFor, isAuthorizedEmail, loginRedirectFor } from "@/lib/auth";
import { describeSyncStatus, readSyncStatus } from "@/lib/financials/sync-status";
import { createClient } from "@/lib/supabase/server";

/**
 * The dashboard shell, and the inner half of the auth gate.
 *
 * The proxy already turned unauthorized requests away; this check runs again
 * anyway, because a routing mistake there should cost a redirect, not the whole
 * app's privacy. Every module route renders inside here.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAuthorizedEmail(user.email)) {
    redirect(loginRedirectFor(user));
  }

  // Only after the gate: an unauthorized visitor should be redirected, not
  // served a count of the accounts they aren't allowed to see.
  const sync = describeSyncStatus(await readSyncStatus(), new Date());

  return (
    <div className="flex min-h-full flex-1">
      <ModuleSidebar user={authorizedUserFor(user)} lastSynced={sync.lastSynced} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CrumbRow syncStatus={sync.chip} />
        <main className="min-w-0 flex-1 px-9 pb-16">{children}</main>
      </div>
    </div>
  );
}
