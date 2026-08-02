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
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
