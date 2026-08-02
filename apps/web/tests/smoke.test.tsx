import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "@/app/page";

describe("scaffold smoke test", () => {
  it("renders the placeholder page", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: "ben-os" })).toBeInTheDocument();
  });
});
