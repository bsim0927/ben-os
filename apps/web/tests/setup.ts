import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only self-registers cleanup when vitest runs with globals,
// which this project doesn't. Without this, renders pile up across tests and
// every query finds duplicates.
afterEach(cleanup);
