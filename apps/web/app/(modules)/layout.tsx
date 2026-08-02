import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { CrumbRow } from "@/components/crumb-row";
import { ModuleSidebar, type Account } from "@/components/module-sidebar";
import { isAuthorizedEmail } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The dashboard shell, and the inner half of the auth gate.
 *
 * The middleware already turned unauthorized requests away; this check runs
 * again anyway, because a routing mistake there should cost a redirect, not the
 * whole app's privacy. Every module route renders inside here.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAuthorizedEmail(user.email)) {
    redirect(user ? "/login?error=unauthorized" : "/login");
  }

  return (
    <div className="flex min-h-full flex-1">
      <ModuleSidebar account={accountFor(user)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CrumbRow />
        <main className="min-w-0 flex-1 px-9 pb-16">{children}</main>
      </div>
    </div>
  );
}

function accountFor(user: User): Account {
  const metadata = user.user_metadata as { full_name?: string; name?: string } | undefined;
  const name = metadata?.full_name?.trim() || metadata?.name?.trim() || user.email || "Account";

  return {
    name,
    initial: name.charAt(0).toUpperCase(),
    // Nothing syncs yet — the Financials module brings the first real source.
    lastSynced: "No syncs yet",
  };
}
