import { describe, expect, it, vi } from "vitest";
import { PROBES, ProbeFail, Run } from "../src/provisioning.ts";
import { CONFIG, fakeApi } from "./provisioning-fake.ts";

// #1299: against a pin from before the lift (flag false) P51 asserts the bus
// is off under HOSTED=1. The committed flag is true (part 6), so it is mocked
// false here.
vi.mock("../src/bus-gate.ts", () => ({ HOSTED_BUS_LIFTED: false }));
const p51 = () => PROBES.find((x) => x.id === "P51");

describe("P51 before the lift", () => {
  it("the bus off (404) passes, with a note, and suspends nothing", async () => {
    const f = fakeApi();
    f.bus.mode = "off";
    const out = await p51()?.run(new Run(CONFIG, f.io));
    expect(out).toMatchObject({ level: "pass" });
    expect(f.log.some((l) => l.endsWith("/suspend"))).toBe(false);
  });
  it("a bus that is on is a failure, and its session is cleaned up", async () => {
    const f = fakeApi();
    await expect(p51()?.run(new Run(CONFIG, f.io))).rejects.toBeInstanceOf(
      ProbeFail,
    );
    expect(f.bus.cleaned).toBe(1);
    expect(f.log.some((l) => l.endsWith("/suspend"))).toBe(false);
  });
});
