import { describe, expect, it, vi } from "vitest";

// The setup file fails closed without live targets (src/rl-anon.ts): name a
// local pair, which paces nothing, before it loads.
vi.hoisted(() => {
  process.env.REDLINE_TARGETS = JSON.stringify({ mode: "local" });
});

import "../live/setup.ts";
import { note, takeFileNotes } from "../src/notes.ts";

// live/setup.ts is the live suite's setup file: it must load and register its
// hooks under vitest (a bad hook signature fails every live file at collect).

describe("live/setup.ts", () => {
  it("loads, and notes land on the running test, not the file", () => {
    note("in a test");
    expect(takeFileNotes()).toEqual([]);
  });
});
