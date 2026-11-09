// #1299 (part 4) adds two cases to main's: the bus's cross-install machine
// token and P51. They are listed here by name so the check below still holds
// every one of main's cases, in main's order, and nothing else is added
// without a line here. Each is accepted-unproven only while the bus is off
// (src/bus-gate.ts); part 6 removes those entries.
export const ADDED = [
  {
    file: "live/bus.test.ts",
    name: "bus > A's machine token at B: /bus/connect is 401, no 101 (each token upgrades at its own install)",
  },
  {
    file: "live/provisioning.test.ts",
    name: "provisioning > P51: bus (#1299): suspend closes a long-connected machine socket and refuses a new one; the same token connects again after resume",
  },
];
