-- Tripwires against accidental destruction of the financials tables.
--
-- These tables stopped being disposable on 2026-08-02: they hold transaction
-- history that cannot be re-fetched, because SimpleFIN Bridge only serves a
-- bounded recent window. A dropped table or a stray `delete` is not recoverable
-- by re-syncing.
--
-- WHAT THIS IS NOT: a permission boundary. The `postgres` role owns these
-- tables, and an owner can disable a trigger or drop an event trigger in one
-- statement. Anyone determined to destroy data still can. What this stops is
-- the *accident* — the unqualified `delete`, the `truncate` meant for a test
-- database, the `drop table` in the wrong project — by making each of them fail
-- loudly and require a deliberate second step to repeat.
--
-- The deliberate second step, for genuine maintenance:
--
--   begin;
--   set local ben_os.allow_bulk_delete = 'on';
--   <the destructive statement>;
--   commit;
--
-- `set local` confines it to that transaction, so the guard is back on for the
-- next statement and cannot be left off by mistake.

create or replace function public.bulk_delete_allowed()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('ben_os.allow_bulk_delete', true), 'off') = 'on';
$$;

comment on function public.bulk_delete_allowed() is
  'True when the current transaction has opted in to destructive statements via ben_os.allow_bulk_delete.';

-- ---------------------------------------------------------------------------
-- Mass delete
-- ---------------------------------------------------------------------------

-- Statement-level with a transition table, so the row count is known once per
-- statement rather than per row. The sync's own pruning removes a handful of
-- pending rows inside a 5-day window and never approaches this.
create or replace function public.guard_bulk_delete()
returns trigger
language plpgsql
as $$
declare
  removed bigint;
begin
  if public.bulk_delete_allowed() then
    return null;
  end if;

  select count(*) into removed from deleted;

  if removed > 100 then
    raise exception
      'Refusing to delete % rows from %.% in one statement.', removed, tg_table_schema, tg_table_name
      using hint =
        'This data cannot be re-fetched. If deliberate: begin; '
        || 'set local ben_os.allow_bulk_delete = ''on''; <statement>; commit;';
  end if;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Truncate
-- ---------------------------------------------------------------------------

-- No threshold: nothing in this app truncates these tables, so any truncate at
-- all is either a test pointed at the wrong database or a mistake.
create or replace function public.guard_truncate()
returns trigger
language plpgsql
as $$
begin
  if public.bulk_delete_allowed() then
    return null;
  end if;

  raise exception 'Refusing to truncate %.%.', tg_table_schema, tg_table_name
    using hint =
      'This data cannot be re-fetched. If deliberate: begin; '
      || 'set local ben_os.allow_bulk_delete = ''on''; <statement>; commit;';
end $$;

-- ---------------------------------------------------------------------------
-- Drop
-- ---------------------------------------------------------------------------

-- `sql_drop` fires after the drop but inside its transaction, so raising here
-- rolls the whole thing back. This is the one guard a table owner cannot simply
-- disable per-table — it has to be dropped by name first.
create or replace function public.guard_financials_drop()
returns event_trigger
language plpgsql
as $$
declare
  dropped record;
begin
  if public.bulk_delete_allowed() then
    return;
  end if;

  for dropped in select * from pg_event_trigger_dropped_objects() loop
    if dropped.object_type = 'table'
       and dropped.schema_name = 'public'
       and dropped.object_name like 'financials\_%'
    then
      raise exception 'Refusing to drop %.%.', dropped.schema_name, dropped.object_name
        using hint =
          'This data cannot be re-fetched. If deliberate: begin; '
          || 'set local ben_os.allow_bulk_delete = ''on''; <statement>; commit;';
    end if;
  end loop;
end $$;

drop event trigger if exists financials_guard_drop;
create event trigger financials_guard_drop on sql_drop
  execute function public.guard_financials_drop();

-- ---------------------------------------------------------------------------
-- Attach to every financials table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'financials_connection',
    'financials_account',
    'financials_transaction',
    'financials_balance_snapshot',
    'financials_category'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard_delete', t);
    execute format(
      'create trigger %I after delete on public.%I '
      || 'referencing old table as deleted for each statement '
      || 'execute function public.guard_bulk_delete()', t || '_guard_delete', t);

    execute format('drop trigger if exists %I on public.%I', t || '_guard_truncate', t);
    execute format(
      'create trigger %I before truncate on public.%I '
      || 'for each statement execute function public.guard_truncate()',
      t || '_guard_truncate', t);
  end loop;
end $$;
