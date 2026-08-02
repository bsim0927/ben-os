/**
 * The module registry — the single place a module is declared.
 *
 * Adding an entry here is the whole of "registering a module": the sidebar, its
 * dimming, and the crumb row all read from this list. Nothing in the shell
 * hardcodes a module name.
 */

/**
 * `soon` modules are shown, dimmed and unclickable, rather than hidden — the
 * sidebar is meant to show what the app is for, not only what has shipped.
 */
export type ModuleStatus = "live" | "soon";

export type ModuleEntry = {
  id: string;
  label: string;
  /** Route the module owns, including every path beneath it. */
  href: string;
  status: ModuleStatus;
  /**
   * `d` attributes of the module's icon, stroked in a 24×24 viewBox. Path data
   * rather than a component so a module stays declarable in this one file.
   */
  iconPaths: string[];
};

export const modules: readonly ModuleEntry[] = [
  {
    id: "financials",
    label: "Financials",
    href: "/financials",
    status: "soon",
    iconPaths: ["M3 17l5-6 4 4 8-10", "M14 5h6v6"],
  },
  {
    id: "email",
    label: "Email",
    href: "/email",
    status: "soon",
    iconPaths: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  },
  {
    id: "calendar",
    label: "Calendar",
    href: "/calendar",
    status: "soon",
    iconPaths: ["M3 4h18v17H3z", "M3 9h18M8 3v3M16 3v3"],
  },
  {
    id: "notes",
    label: "Notes",
    href: "/notes",
    status: "soon",
    iconPaths: ["M6 3h9l3 3v15H6z", "M9 9h6M9 13h6M9 17h4"],
  },
];

/** The module owning `pathname`, if any. `/` belongs to the shell, not a module. */
export function findModule(pathname: string): ModuleEntry | undefined {
  return modules.find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`));
}

export type Crumb = {
  module: string;
  page: string;
};

/**
 * The crumb row's `<Module> / <page>`, derived entirely from the path. Pages
 * off a module's root take their name from the deepest segment; the shell's own
 * home page reads as the console itself.
 */
export function crumbFor(pathname: string): Crumb {
  const owner = findModule(pathname);

  if (!owner) {
    return { module: "Console", page: "Overview" };
  }

  const rest = pathname.slice(owner.href.length).split("/").filter(Boolean);
  const deepest = rest.at(-1);

  return { module: owner.label, page: deepest ? humanise(deepest) : "Overview" };
}

function humanise(segment: string): string {
  const words = segment.replace(/-/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}
