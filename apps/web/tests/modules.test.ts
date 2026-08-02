import { describe, expect, it } from "vitest";

import { crumbFor, findModule, modules } from "@/lib/modules";

describe("module registry", () => {
  it("lists every module the app plans to have, built or not", () => {
    expect(modules.map((m) => m.id)).toEqual(["financials", "email", "calendar", "notes"]);
  });

  it("gives every module the pieces the sidebar needs to render it", () => {
    for (const entry of modules) {
      expect(entry.label).not.toBe("");
      expect(entry.href).toMatch(/^\/[a-z-]+$/);
      expect(entry.iconPaths.length).toBeGreaterThan(0);
      expect(["live", "soon"]).toContain(entry.status);
    }
  });

  it("marks the modules that are not built yet as soon, not hidden", () => {
    // Nothing is built yet at this point — Financials lands in a later ticket.
    expect(modules.filter((m) => m.status === "soon").map((m) => m.id)).toEqual([
      "financials",
      "email",
      "calendar",
      "notes",
    ]);
  });

  it("has one entry per href", () => {
    expect(new Set(modules.map((m) => m.href)).size).toBe(modules.length);
  });
});

describe("findModule", () => {
  it("finds the module owning a path, including its sub-pages", () => {
    expect(findModule("/financials")?.id).toBe("financials");
    expect(findModule("/financials/fidelity/holdings")?.id).toBe("financials");
  });

  it("returns nothing for paths no module owns", () => {
    expect(findModule("/")).toBeUndefined();
    expect(findModule("/financials-archive")).toBeUndefined();
  });
});

describe("crumbFor", () => {
  it("labels the console's own home page", () => {
    expect(crumbFor("/")).toEqual({ module: "Console", page: "Overview" });
  });

  it("labels a module's root as its overview", () => {
    expect(crumbFor("/financials")).toEqual({ module: "Financials", page: "Overview" });
  });

  it("titles the deepest segment of a module sub-page", () => {
    expect(crumbFor("/financials/fidelity/holdings")).toEqual({
      module: "Financials",
      page: "Holdings",
    });
  });

  it("humanises a hyphenated segment", () => {
    expect(crumbFor("/financials/net-worth").page).toBe("Net worth");
  });
});
