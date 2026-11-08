// The three steps of T19's cross-job hook-key hand-off (#1730), run through
// scripts/provisioning.ts:
//   t19-recipient          (t19 job)     a key pair under RUNNER_TEMP: the
//                                         private key 0600, the public key to upload
//   t19-seal <pub> <out>   (redline job) rl-a's hook key sealed to it
//   t19-open               (t19 job)     the key written 0600 where T19 reads
//                                         it, the private key deleted
// The AAD is `run_id:run_attempt` (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT), so a
// sealed key can't be replayed into another run. Nothing here prints a secret;
// the opened key is masked.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mask, writeSecretFile } from "./oidc.ts";
import { credFile, type RawTargets } from "./provisioning-live.ts";
import {
  loadRecipient,
  newFileRecipient,
  openSealed,
  sealToKey,
} from "./seal.ts";
import { readSecretFile, secretFileName } from "./targets.ts";

type Env = Record<string, string | undefined>;

/** `run_id:run_attempt`, each decimal: anything else throws. */
export function runAad(env: Env): string {
  const id = env.GITHUB_RUN_ID ?? "";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "";
  if (!/^\d{1,20}$/.test(id) || !/^\d{1,3}$/.test(attempt))
    throw new Error("t19: GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required");
  return `${id}:${attempt}`;
}

export const recipientDir = (env: Env): string => {
  if (!env.RUNNER_TEMP) throw new Error("t19: RUNNER_TEMP is not set");
  return join(env.RUNNER_TEMP, "t19-recipient");
};
export const PRIVATE_FILE = "private-key";
export const PUBLIC_FILE = "public-key";

/** Writes the key pair: private 0600, public 0644, in a 0700 directory. */
export async function t19Recipient(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = await newFileRecipient();
  writeSecretFile(join(dir, PRIVATE_FILE), r.privateKey);
  writeFileSync(join(dir, PUBLIC_FILE), r.publicKey, { mode: 0o644 });
  chmodSync(join(dir, PUBLIC_FILE), 0o644);
}

/** Seals rl-a's hook key to the public key in `pubFile`, into `outFile` (0600). */
export async function t19Seal(
  env: Env,
  t: RawTargets,
  pubFile: string,
  outFile: string,
): Promise<void> {
  const pub = readFileSync(pubFile, "utf8").trim();
  const key = readSecretFile(
    credFile(t, "a", "HOOK_KEY"),
    secretFileName(t.a.name, "HOOK_KEY"),
  );
  const m = mask(env);
  m(key);
  const sealed = await sealToKey(pub, key, runAad(env));
  mkdirSync(join(outFile, ".."), { recursive: true });
  writeSecretFile(outFile, sealed);
}

/**
 * Opens `sealedFile` with the private key in `dir`, writes rl-a's hook key
 * where the suite and T19 read it (0600), and deletes the private key, even
 * when the opening fails.
 */
export async function t19Open(
  env: Env,
  t: RawTargets,
  dir: string,
  sealedFile: string,
): Promise<void> {
  try {
    const r = await loadRecipient({
      privateKey: readSecretFile(join(dir, PRIVATE_FILE), "t19 private key"),
      publicKey: readFileSync(join(dir, PUBLIC_FILE), "utf8").trim(),
    });
    const key = await openSealed(
      r,
      readFileSync(sealedFile, "utf8").trim(),
      runAad(env),
    );
    if (key.length < 32)
      throw new Error("t19: the opened hook key is too short");
    mask(env)(key);
    mkdirSync(t.secretsDir, { recursive: true, mode: 0o700 });
    writeSecretFile(credFile(t, "a", "HOOK_KEY"), key);
  } finally {
    rmSync(join(dir, PRIVATE_FILE), { force: true });
  }
}
