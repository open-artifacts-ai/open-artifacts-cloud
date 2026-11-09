// The one switch of the hosted bus's red-line cases (open-artifacts#1299).
// No imports: src/report.ts (the gate) reads it too.

/**
 * Whether the HOSTED=1 gate on the /bus routes is lifted (part 6). While
 * false, a hosted install's bus is off, so a case that needs it reports
 * unproven-live with BUS_OFF_REASON, which ACCEPTED_UNPROVEN lets the gate
 * pass. Part 6 sets this true in the same change that lifts the gate and
 * deletes those entries: from then on a bus that is off is a FAIL.
 */
export const HOSTED_BUS_LIFTED = false;

/** The one reason a bus case gives while the bus is off (matched exactly by the gate). */
export const BUS_OFF_REASON =
  "the bus is off on hosted installs (HOSTED=1) until open-artifacts#1299 part 6 lifts it";
