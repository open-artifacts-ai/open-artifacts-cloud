#!/usr/bin/env node
// #2208, staging and Stripe test mode only: the Stripe Customer Portal
// configuration billing opens sessions with. Without one, the portal uses
// Stripe's dashboard default, which may let a Team owner change seats or plan
// outside our webhook flow. Runs only in CI (.github/workflows/
// staging-portal-config.yml); the Stripe key never touches a laptop.
//
//   portal-read    print each configuration's id, is_default and four
//                  features (on or off). Nothing else: no business profile,
//                  login page or customer data.
//   portal-ensure  create, or update in place, the one configuration with
//                  metadata oa=billing: subscription_update off (no quantity
//                  or plan change), cancel on at period end, payment method
//                  update on, invoice history on, no business_profile URLs.
//                  Prints only its bpc_ id. More than one oa=billing
//                  configuration is refused.
//
// Env: ACTION (portal-read|portal-ensure), STRIPE_SECRET_KEY (test key only;
// checked, never printed).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Refused, stripeClient } from "./staging-team-proof.ts";

export { Refused };

const BPC = /^bpc_[A-Za-z0-9]{1,255}$/;
type Obj = Record<string, unknown>;
type Call = ReturnType<typeof stripeClient>;
export interface Io {
  log: (s: string) => void;
}

const FEATURES = [
  "subscription_update",
  "subscription_cancel",
  "payment_method_update",
  "invoice_history",
] as const;

/** The only form this script ever posts. */
const ENSURE_FORM: Record<string, string> = {
  "features[subscription_update][enabled]": "false",
  "features[subscription_cancel][enabled]": "true",
  "features[subscription_cancel][mode]": "at_period_end",
  "features[payment_method_update][enabled]": "true",
  "features[invoice_history][enabled]": "true",
  "metadata[oa]": "billing",
};

const idOf = (o: Obj): string => {
  const id = o.id;
  if (typeof id !== "string" || !BPC.test(id))
    throw new Refused("a configuration has no bpc_ id");
  return id;
};

async function list(call: Call): Promise<Obj[]> {
  const out = await call("GET", "/v1/billing_portal/configurations?limit=100");
  if (out.has_more === true)
    throw new Refused("more than 100 portal configurations");
  return (out.data as Obj[] | undefined) ?? [];
}

export async function run(io: Io, call: Call, action: string): Promise<void> {
  if (action !== "portal-read" && action !== "portal-ensure")
    throw new Refused("ACTION is portal-read or portal-ensure");
  const configs = await list(call);

  if (action === "portal-read") {
    for (const c of configs) {
      const feats = (c.features ?? {}) as Obj;
      const on = FEATURES.map(
        (f) => `${f} ${(feats[f] as Obj | undefined)?.enabled === true}`,
      ).join(" ");
      io.log(`${idOf(c)} is_default ${c.is_default === true} ${on}`);
    }
    return;
  }

  const ours = configs.filter(
    (c) =>
      c.is_active !== false &&
      (c.metadata as Obj | undefined)?.oa === "billing",
  );
  if (ours.length > 1)
    throw new Refused(
      "more than one portal configuration has metadata oa=billing",
    );
  const made = await call(
    "POST",
    ours[0]
      ? `/v1/billing_portal/configurations/${idOf(ours[0])}`
      : "/v1/billing_portal/configurations",
    ENSURE_FORM,
  );
  io.log(`portal configuration ${idOf(made)}`);
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string): never => {
    console.error(`staging-portal-config: ${msg}`);
    process.exit(1);
  };
  const e = process.env;
  try {
    await run(
      { log: (s) => console.log(`staging-portal-config: ${s}`) },
      stripeClient(e.STRIPE_SECRET_KEY ?? "", fetch),
      e.ACTION ?? "",
    );
  } catch (err) {
    fail(err instanceof Refused ? err.message : "failed");
  }
}
