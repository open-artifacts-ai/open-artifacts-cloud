// The redline-staging job's Provisioning API steps (design v7 4.4, 10.1, 12.2):
//   node --experimental-strip-types scripts/provisioning.ts mint-oidc <key>...
//   node --experimental-strip-types scripts/provisioning.ts bringup
//   node --experimental-strip-types scripts/provisioning.ts staged-version <file>
//   node --experimental-strip-types scripts/provisioning.ts revoke
//   node --experimental-strip-types scripts/provisioning.ts t19-recipient
//   node --experimental-strip-types scripts/provisioning.ts t19-seal <pub> <out>
//   node --experimental-strip-types scripts/provisioning.ts t19-open
// mint-oidc writes one GitHub OIDC JWT per audience key (provisioning,
// stagingInventory, prodInventory) into REDLINE_TARGETS.secretsDir as 0600
// files. bringup upgrades rl-a and rl-b to REDLINE_RELEASE (R5) and writes
// their R26 creds (REDLINE_RL_<X>_PAT, _HOOK_KEY); it first starts bus-pair
// (cloud #202: rl-busa and rl-busb) as a detached process it never waits for. staged-version writes
// REDLINE_RELEASE (X.Y.Z) to <file> once rl-a's and rl-b's /healthz both
// report it (the redline-staged-version artifact). revoke is the job's
// if: always() end: R26 revoke on both, and their PATs must then be 401.
// t19-recipient, t19-seal and t19-open hand rl-a's hook key from the redline
// job to the t19 job, sealed to a key only the t19 job holds (src/t19-seal.ts).
// Every value is masked (::add-mask::) before anything else could print it.

import { join } from "node:path";
import type { AudienceKey } from "../src/oidc.ts";
import { AUDIENCES } from "../src/oidc.ts";
import {
  bringUp,
  mintFiles,
  rawTargets,
  revokeAll,
  runBusPair,
  writeStagedVersion,
} from "../src/provisioning-live.ts";
import {
  recipientDir,
  t19Open,
  t19Recipient,
  t19Seal,
} from "../src/t19-seal.ts";

const [cmd, ...rest] = process.argv.slice(2);
const env = process.env;

async function main(): Promise<number> {
  if (cmd === "t19-recipient") {
    await t19Recipient(recipientDir(env));
    return 0;
  }
  const t = rawTargets(env.REDLINE_TARGETS);
  if (cmd === "t19-seal") {
    if (rest.length !== 2 || !rest[0] || !rest[1])
      throw new Error("t19-seal: <public key file> <sealed output file>");
    await t19Seal(env, t, rest[0], rest[1]);
    return 0;
  }
  if (cmd === "t19-open") {
    // The sealed value comes from the redline job's t19-sealed artifact,
    // downloaded to <RUNNER_TEMP>/t19-sealed/sealed.
    await t19Open(
      env,
      t,
      recipientDir(env),
      join(env.RUNNER_TEMP ?? "", "t19-sealed", "sealed"),
    );
    return 0;
  }
  if (cmd === "mint-oidc") {
    const keys = rest as AudienceKey[];
    if (!keys.length || !keys.every((k) => k in AUDIENCES))
      throw new Error(
        `mint-oidc: keys are ${Object.keys(AUDIENCES).join(", ")}`,
      );
    await mintFiles(env, t.secretsDir, keys);
    return 0;
  }
  if (cmd === "bringup") {
    await bringUp(env, t);
    return 0;
  }
  // Cloud #202: the hosted bus pair, in the detached process bringup starts.
  if (cmd === "bus-pair") {
    await runBusPair(env, t);
    return 0;
  }
  if (cmd === "staged-version") {
    if (rest.length !== 1 || !rest[0])
      throw new Error("staged-version: one output file");
    await writeStagedVersion(env, t, rest[0]);
    return 0;
  }
  if (cmd === "revoke") return revokeAll(env, t);
  throw new Error(
    "usage: provisioning.ts mint-oidc <key>... | bringup | bus-pair | staged-version <file> | revoke | t19-recipient | t19-seal <pub> <out> | t19-open",
  );
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`provisioning: ${(e as Error).message}`);
    process.exit(1);
  },
);
