import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { boundFetch } from "./fetch-timeout.ts";
import {
  AUDIENCES,
  type AudienceKey,
  jwtSource,
  mask,
  OIDC_FILES,
  writeSecretFile,
} from "./oidc.ts";
import {
  bringUpgrade,
  type CredsOut,
  mintCreds,
  type ProvIo,
  provConfig,
  Run,
  revokeCreds,
  stagedVersion,
} from "./provisioning.ts";
import { gitSchemaOf } from "./schema.ts";
import { newRecipient, openSealed, parseCreds } from "./seal.ts";
import { readSecretFile, secretFileName } from "./targets.ts";

// The live wiring of src/provisioning.ts: real fetch (bounded), the wall
// clock, and the OIDC JWT files in secretsDir. Used by the live suite
// (live/provisioning.test.ts) and the workflow's bring-up and revoke steps
// (scripts/provisioning.ts).

export interface RawTargets {
  secretsDir: string;
  a: { name: string; installId: string; app: string };
  b: { name: string; installId: string; app: string };
}

/**
 * Where a side's R26 cred lives: the suite's own path (targets.ts reads
 * <secretsDir>/REDLINE_<NAME>_<KIND> for the target's name, rl-a not a).
 */
export const credFile = (
  t: RawTargets,
  k: "a" | "b",
  kind: "PAT" | "HOOK_KEY",
): string => join(t.secretsDir, secretFileName(t[k].name, kind));

/** The ids and origins of rl-a and rl-b, and secretsDir, from REDLINE_TARGETS. */
export function rawTargets(json: string | undefined): RawTargets {
  if (!json) throw new Error("REDLINE_TARGETS is not set");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("REDLINE_TARGETS is not JSON");
  }
  const side = (k: "a" | "b") => {
    const v = raw[k] as
      | { name?: unknown; installId?: unknown; app?: unknown }
      | undefined;
    if (
      typeof v?.name !== "string" ||
      v.name === "" ||
      typeof v.installId !== "string" ||
      typeof v.app !== "string"
    )
      throw new Error(
        `REDLINE_TARGETS: ${k}.name, ${k}.installId and ${k}.app are required`,
      );
    return { name: v.name, installId: v.installId, app: new URL(v.app).origin };
  };
  if (typeof raw.secretsDir !== "string" || !raw.secretsDir)
    throw new Error("REDLINE_TARGETS: secretsDir is required");
  return { secretsDir: raw.secretsDir, a: side("a"), b: side("b") };
}

const out = (s: string) => process.stdout.write(s);

export { mask };

export function liveRun(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Run {
  const m = mask(env);
  const src = (k: AudienceKey) =>
    jwtSource(join(t.secretsDir, OIDC_FILES[k]), AUDIENCES[k], {
      env,
      onMint: m,
    });
  const patFile = credFile(t, "a", "PAT");
  const io: ProvIo = {
    mask: m,
    fetch: boundFetch(globalThis.fetch),
    now: Date.now,
    wait: (ms) => delay(ms),
    jwt: src("provisioning"),
    stgInventoryJwt: src("stagingInventory"),
    schemaOf: gitSchemaOf,
    rlAPat: existsSync(patFile)
      ? () => readSecretFile(patFile, secretFileName(t.a.name, "PAT"))
      : undefined,
  };
  return new Run(provConfig(env, t), io);
}

/** Mints one JWT per key into secretsDir (0600), masking each. */
export async function mintFiles(
  env: Record<string, string | undefined>,
  dir: string,
  keys: readonly AudienceKey[],
): Promise<void> {
  for (const k of keys) {
    // A fresh mint: jwtSource re-mints because the file is absent.
    const file = join(dir, OIDC_FILES[k]);
    if (existsSync(file)) throw new Error(`${OIDC_FILES[k]} already exists`);
    await jwtSource(file, AUDIENCES[k], { env, onMint: mask(env) })();
  }
}

/**
 * The workflow's bring-up (P24, R26): upgrade rl-a and rl-b, then mint their
 * creds, the two installs at the same time (#1730: the two upgrades are about
 * 2:00 and 1:38 when taken one after the other). Each install is its own
 * chain (upgrade, then R26 mint, then its two files); both are always awaited
 * to the end, so a failing install never leaves the other's job unwatched. Any
 * failure fails the bring-up, and each failure line starts with the install's
 * slug. `run` is a seam for tests (default: the live wiring).
 */
export async function bringUp(
  env: Record<string, string | undefined>,
  t: RawTargets,
  run: Run = liveRun(env, t),
): Promise<void> {
  const m = mask(env);
  const r = await newRecipient();
  const open = async (sealed: string): Promise<CredsOut> => {
    const c = parseCreds(await openSealed(r, sealed));
    m(c.pat);
    m(c.hookKey);
    return c;
  };
  const one = async (name: "a" | "b", side: RawTargets["a"]): Promise<void> => {
    const slug = `rl-${name}`;
    try {
      const how = await bringUpgrade(run, side.installId, slug);
      out(`${slug}: ${how} (${run.c.version})\n`);
      const c = await mintCreds(run, side.installId, slug, {
        publicKey: r.publicKey,
        open,
      });
      writeSecretFile(credFile(t, name, "PAT"), c.pat);
      writeSecretFile(credFile(t, name, "HOOK_KEY"), c.hookKey);
      out(`${slug}: R26 creds written\n`);
    } catch (e) {
      const msg = errText(e);
      if (!(e instanceof Error)) throw new Error(`${slug}: ${msg}`);
      // The error keeps its kind (an InfraError stays one) and gains the slug.
      if (!msg.startsWith(`${slug}:`)) e.message = `${slug}: ${msg}`;
      throw e;
    }
  };
  const done = await Promise.allSettled([one("a", t.a), one("b", t.b)]);
  const failed = done.filter(
    (d): d is PromiseRejectedResult => d.status === "rejected",
  );
  if (failed.length === 0) return;
  for (const f of failed.slice(1)) out(`${errText(f.reason)}\n`);
  throw failed[0]?.reason;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The workflow's last step: R26 revoke on rl-a and rl-b; both run, any failure fails. */
export async function revokeAll(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Promise<number> {
  const run = liveRun(env, t);
  let failed = 0;
  for (const [name, side] of [
    ["a", t.a],
    ["b", t.b],
  ] as const) {
    const f = credFile(t, name, "PAT");
    const pat = existsSync(f)
      ? readSecretFile(f, secretFileName(side.name, "PAT"))
      : undefined;
    try {
      await revokeCreds(run, side.installId, `rl-${name}`, side.app, pat);
      out(`rl-${name}: R26 revoked\n`);
    } catch (e) {
      failed++;
      out(`rl-${name}: revoke failed: ${(e as Error).message}\n`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * The staging-first record: once rl-a's and rl-b's /healthz both report
 * REDLINE_RELEASE, writes it (X.Y.Z) to `file` for the
 * redline-staged-version artifact.
 */
export async function writeStagedVersion(
  env: Record<string, string | undefined>,
  t: RawTargets,
  file: string,
): Promise<void> {
  const v = await stagedVersion(liveRun(env, t));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${v}\n`);
  out(`rl-a and rl-b report ${v}\n`);
}
