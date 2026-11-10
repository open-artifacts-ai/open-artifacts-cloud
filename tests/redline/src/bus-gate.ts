// The one switch of the hosted bus's red-line cases (open-artifacts#1299).
// No imports.

/**
 * Whether the HOSTED=1 gate on the /bus routes is lifted (part 6). While
 * false, the bus cases assert the design as it is: the bus is OFF on every
 * hosted install (its ping route answers 404), and a bus that is on is a
 * FAIL. Part 6 sets this to true in the same change that lifts the gate;
 * the cases then run their full assertions (a bus that is off is a FAIL).
 */
export const HOSTED_BUS_LIFTED = false;
