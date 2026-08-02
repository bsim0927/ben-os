import { redirect } from "next/navigation";

import { CrumbRow } from "@/components/crumb-row";
import { ModuleSidebar } from "@/components/module-sidebar";
import { authorizedUserFor, isAuthorizedEmail, loginRedirectFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Nothing syncs yet — the Financials module brings the first real source, and
 * these are the two seams it will feed.
 */
const LAST_SYNCED = "No syncs yet";
const SYNC_STATUS = "No sources connected";

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

  return (
    <div className="flex min-h-full flex-1">
      <ModuleSidebar user={authorizedUserFor(user)} lastSynced={LAST_SYNCED} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CrumbRow syncStatus={SYNC_STATUS} />
        <main className="min-w-0 flex-1 px-9 pb-16">{children}</main>
      </div>
    </div>
  );
}
