#!/usr/bin/env python3
"""Refuse destructive SQL sent to Supabase through the MCP server.

The financials tables hold transaction history that cannot be re-fetched —
SimpleFIN Bridge only serves a bounded recent window — so a mistaken `truncate`
or unqualified `delete` is permanent. The database carries its own guards
(`20260802205533_financials_destructive_guards.sql`); this is the layer in front
of them, and it exists because the two catch different things:

- The database guards catch any client, including `psql`, but only fire once the
  statement runs, and can be disabled by the table owner.
- This hook catches only statements sent through the Supabase MCP tools, but
  stops them before they reach the database at all — including the statements
  that would disable the database guards.

Neither is a permission boundary. Both are here to make destruction deliberate
rather than possible by accident.

Deliberate destruction opts in the same way it does at the database layer, by
including the opt-in in the SQL:

    begin;
    set local ben_os.allow_bulk_delete = 'on';
    <the destructive statement>;
    commit;

That is a real statement the database also honours, not a magic comment — so
one convention covers both layers and neither can be satisfied by accident.
"""

import json
import re
import sys

OPT_IN = "ben_os.allow_bulk_delete"
GUARDED_TOOLS = {"mcp__supabase__execute_sql", "mcp__supabase__apply_migration"}


def normalise(sql: str) -> str:
    """Strip comments and collapse whitespace, so patterns can't be hidden in them."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", " ", sql)

    return re.sub(r"\s+", " ", sql).strip().lower()


def statements(sql: str) -> list[str]:
    """Crude split on `;`. Good enough: the only thing it must get right is
    keeping a WHERE clause attached to the statement it belongs to."""
    return [part.strip() for part in sql.split(";") if part.strip()]


def offences(sql: str) -> list[str]:
    found = []

    for stmt in statements(sql):
        if re.search(r"\btruncate\b", stmt):
            found.append("TRUNCATE removes every row and cannot be rolled back once committed.")

        if re.search(r"\bdrop\s+(table|schema|database)\b", stmt):
            found.append("DROP TABLE/SCHEMA/DATABASE destroys data along with the structure.")

        # `delete from` with no WHERE anywhere in the same statement.
        if re.search(r"\bdelete\s+from\b", stmt) and not re.search(r"\bwhere\b", stmt):
            found.append("DELETE without a WHERE clause removes every row in the table.")

        # Statement-initial UPDATE only. `on conflict do update` is an upsert —
        # it is how the sync writes every row it has, and has no WHERE by design.
        if re.match(r"^update\b", stmt) and not re.search(r"\bwhere\b", stmt):
            found.append("UPDATE without a WHERE clause rewrites every row in the table.")

        if re.search(r"\bdrop\s+event\s+trigger\b", stmt) or re.search(
            r"\bdisable\s+trigger\b", stmt
        ):
            found.append(
                "Disabling or dropping a trigger would remove the database's own "
                "guards against exactly these statements."
            )

    return found


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        # Malformed input is not this hook's business to adjudicate. Staying out
        # of the way beats blocking every tool call on a parsing bug.
        return 0

    if payload.get("tool_name") not in GUARDED_TOOLS:
        return 0

    sql = payload.get("tool_input", {}).get("query") or ""
    normalised = normalise(sql)

    if OPT_IN in normalised:
        return 0

    problems = offences(normalised)

    if not problems:
        return 0

    # De-duplicate while keeping order, so a multi-statement script that trips
    # the same rule five times reports it once.
    unique = list(dict.fromkeys(problems))

    reason = (
        "Blocked by .claude/hooks/guard-supabase-sql.py.\n\n"
        + "\n".join(f"- {problem}" for problem in unique)
        + "\n\nThis database holds live financial history that cannot be re-fetched: "
        "SimpleFIN Bridge only serves a bounded recent window, so anything removed "
        "here is gone for good.\n\n"
        "Do not work around this by rephrasing the statement. Stop and ask the user "
        "what they want. If they confirm they want it, the deliberate form is:\n\n"
        "    begin;\n"
        "    set local ben_os.allow_bulk_delete = 'on';\n"
        "    <the statement>;\n"
        "    commit;\n\n"
        "which the database's own guards honour as well."
    )

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
