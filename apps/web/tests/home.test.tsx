import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ConsoleHome from "@/app/(modules)/page";

describe("the console home page", () => {
  it("names the console", () => {
    render(<ConsoleHome />);

    expect(screen.getByRole("heading", { level: 1, name: "ben-os" })).toBeInTheDocument();
  });

  it("leaves the module list to the sidebar rather than restating it", () => {
    render(<ConsoleHome />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
