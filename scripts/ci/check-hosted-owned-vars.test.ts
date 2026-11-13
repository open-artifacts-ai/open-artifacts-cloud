import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hardcodedOwnedVars,
  ownedVarNames,
} from "./check-hosted-owned-vars.ts";

const real = join(import.meta.dirname, "../..");

function fixture(vars: string, env = "prod"): string {
  const root = mkdtempSync(join(tmpdir(), "owned-vars-"));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  mkdirSync(join(root, ".github/hosted"), { recursive: true });
  mkdirSync(join(root, "apps/w"), { recursive: true });
  cpSync(
    join(real, "scripts/ci/hosted-constants.sh"),
    join(root, "scripts/ci/hosted-constants.sh"),
  );
  for (const e of ["staging", "prod"])
    cpSync(
      join(real, ".github/hosted", `${e}.json`),
      join(root, ".github/hosted", `${e}.json`),
    );
  writeFileSync(
    join(root, "apps/w/wrangler.jsonc"),
    `{ // c\n "env": { "${env}": { "vars": { ${vars} } } } }`,
  );
  return root;
}

describe("check-hosted-owned-vars.ts", () => {
  it("fails a hardcoded SIGNUPS_ENABLED in env.prod", () => {
    const p = hardcodedOwnedVars(fixture(`"SIGNUPS_ENABLED": "false"`));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("env.prod.vars.SIGNUPS_ENABLED");
  });
  it("fails a hardcoded owned var in env.staging", () => {
    expect(
      hardcodedOwnedVars(fixture(`"WELCOME_FROM": "a@b.co"`, "staging")),
    ).toHaveLength(1);
  });
  it("fails the other env's placeholder", () => {
    expect(
      hardcodedOwnedVars(
        fixture(`"SIGNUPS_ENABLED": "{{SIGNUPS_ENABLED_STAGING}}"`),
      ),
    ).toHaveLength(1);
  });
  it("passes the placeholder and unowned vars", () => {
    expect(
      hardcodedOwnedVars(
        fixture(`"SIGNUPS_ENABLED": "{{SIGNUPS_ENABLED_PROD}}", "OTHER": "x"`),
      ),
    ).toEqual([]);
  });
  it("maps keys from hosted-constants.sh", () => {
    const m = ownedVarNames(
      ["account_id", "signups_enabled"],
      readFileSync(join(real, "scripts/ci/hosted-constants.sh"), "utf8"),
    );
    expect(m.get("SIGNUPS_ENABLED")).toBe("signups_enabled");
    expect(m.get("ACCOUNT_ID")).toBe("account_id");
  });
  // The overlay build adds the public repo's apps, which this repo does not
  // own; the scripts CI job runs the check on the plain checkout.
  it.skipIf(existsSync(join(real, "apps/auth-broker")))(
    "current main passes",
    () => {
      expect(hardcodedOwnedVars(real)).toEqual([]);
    },
  );
});
