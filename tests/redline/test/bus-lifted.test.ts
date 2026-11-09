import { describe, expect, it, vi } from "vitest";
import { PROBES, ProbeFail, Run } from "../src/provisioning.ts";
import { CONFIG, fakeApi } from "./provisioning-fake.ts";

// #1299: once part 6 lifts the gate it sets HOSTED_BUS_LIFTED, and a bus that
// answers 404 is then a FAIL on P51 (and on the live case), never an
// unproven-live the gate accepts.
vi.mock("../src/bus-gate.ts", () => ({
  HOSTED_BUS_LIFTED: true,
}));

describe("P51 after the lift", () => {
  it("rl-l's bus off (404) is a failure, not unproven", async () => {
    const f = fakeApi();
    f.bus.mode = "off";
    const p = PROBES.find((x) => x.id === "P51");
    await expect(p?.run(new Run(CONFIG, f.io))).rejects.toThrow(
      new ProbeFail("P51: rl-l's bus answers 404 after the lift"),
    );
  });
});
