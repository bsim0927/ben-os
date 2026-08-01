# ben-os

A single-user personal platform (TypeScript/Next.js on Vercel, Supabase backend) that consolidates personal-admin tools — starting with a Financials vertical, with Email, Calendar, and Notetaking planned as future verticals.

## Language

**Module**:
A self-contained feature area (e.g. Financials) living under `apps/web/app/(modules)/<name>/`, registered in a central module registry, and owning its own prefix-namespaced Supabase tables (`<module>_<entity>`).
_Avoid_: Vertical (used loosely in planning discussions, but "module" is the concrete code/schema unit), plugin, feature.

**Authorized user**:
The single Google account permitted to use the app. Enforced in two places: a middleware/layout check at the app layer, and the `is_authorized()` Postgres function as an RLS backstop at the database layer.
_Avoid_: Owner, admin — this app has no multi-tenant or role concept, there is exactly one authorized user.
