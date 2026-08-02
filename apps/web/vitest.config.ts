import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    // Placeholders so the Supabase clients construct; every test stubs the
    // client itself, so nothing here is ever dialled.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.test",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    },
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    // Starts one real Postgres for the run and hands its URL to the tests that
    // need it. Costs well under a second, and the financials sync has no
    // meaningful test without it — its behaviour lives in SQL and RLS.
    globalSetup: ["./tests/support/postgres-global.ts"],
    // The database tests each drive several polls end to end; the default 5s is
    // tight for the first one, which pays for the pool's initial connection.
    testTimeout: 20_000,
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
