import { createClient } from "@/lib/supabase/client";
import type { CategoryRef } from "@/lib/financials/flow";

/**
 * The two writes the Financials module makes from the browser: naming a
 * category, and putting a transaction in one.
 *
 * Straight from the client rather than through a route handler, because there is
 * nothing for a server hop to add here. The Access URL never touches these
 * tables (ADR 0002 keeps it out of the database entirely), and
 * `financials_category_authorized` / `financials_transaction_authorized` already
 * gate every row on `is_authorized()` — a route would re-implement that check in
 * TypeScript and add a round trip for the privilege.
 *
 * Both throw on failure. The caller is optimistic, so a throw is what tells it
 * to put the row back the way it was.
 */

/**
 * Records that `transactionId` belongs to `categoryId`, or to nothing.
 *
 * `null` clears the category rather than deleting anything — categories are
 * shared, and removing one from a transaction must not take it off the others.
 */
export async function assignCategory(
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase
    .from("financials_transaction")
    .update({ category_id: categoryId })
    .eq("id", transactionId);

  if (error) throw new Error(error.message);
}

/**
 * The category called `name`, creating it only if it is new.
 *
 * An upsert rather than an insert: `financials_category_name_key` makes a second
 * "Groceries" an error, and the honest response to typing an existing name is
 * the existing category — that reuse is the point of the table (spec #27).
 */
export async function createCategory(name: string): Promise<CategoryRef> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("financials_category")
    .upsert({ name: name.trim() }, { onConflict: "name" })
    .select("id, name")
    .single<CategoryRef>();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("The category was not returned after saving.");

  return data;
}
