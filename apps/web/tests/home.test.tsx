import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { modules } from "@/lib/modules";

import ConsoleHome from "@/app/(modules)/page";

describe("the console home page", () => {
  it("names the console", () => {
    render(<ConsoleHome />);

    expect(screen.getByRole("heading", { level: 1, name: "ben-os" })).toBeInTheDocument();
  });

  it("reports every registered module and whether it is built", () => {
    render(<ConsoleHome />);

    const list = within(screen.getByRole("list"));

    for (const entry of modules) {
      expect(list.getByText(entry.label)).toBeInTheDocument();
    }

    expect(list.getAllByText("Soon")).toHaveLength(
      modules.filter((entry) => entry.status === "soon").length,
    );
  });
});
