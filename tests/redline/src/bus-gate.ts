// The one switch of the hosted bus's red-line cases (open-artifacts#1299).
// No imports.

/**
 * Whether the HOSTED=1 gate on the /bus routes is lifted. True since part 6:
 * the public release that made busOn "BUS_HUB bound", which PUBLIC_PIN must
 * name or be newer than. The cases run their full assertions and a bus that
 * is off (404) is a FAIL. Set false only to test a pin from before the lift,
 * where the bus is OFF on hosted and a bus that is on is a FAIL.
 */
export const HOSTED_BUS_LIFTED = true;
