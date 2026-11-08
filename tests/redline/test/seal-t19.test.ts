import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credFile, type RawTargets } from "../src/provisioning-live.ts";
import {
  loadRecipient,
  newFileRecipient,
  openSealed,
  sealToKey,
} from "../src/seal.ts";
import {
  PRIVATE_FILE,
  PUBLIC_FILE,
  recipientDir,
  runAad,
  t19Open,
  t19Recipient,
  t19Seal,
} from "../src/t19-seal.ts";

const HOOK = "h".repeat(24) + "0123456789abcdefABCDEF";
let temp: string;
let secrets: string;
let targets: RawTargets;
const env = (attempt = "1", id = "42402998826") => ({
  RUNNER_TEMP: temp,
  GITHUB_RUN_ID: id,
  GITHUB_RUN_ATTEMPT: attempt,
});
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "rl-t19-"));
  secrets = join(temp, "redline-secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  targets = {
    secretsDir: secrets,
    a: { name: "rl-a", installId: "ia", app: "https://rl-a.example" },
    b: { name: "rl-b", installId: "ib", app: "https://rl-b.example" },
  };
  writeFileSync(credFile(targets, "a", "HOOK_KEY"), HOOK, { mode: 0o600 });
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("T19's hook-key hand-off (src/t19-seal.ts)", () => {
  it("round-trips: recipient, seal in the other job, open", async () => {
    const e = env();
    const dir = recipientDir(e);
    await t19Recipient(dir);
    const sealed = join(temp, "t19-sealed", "sealed");
    await t19Seal(e, targets, join(dir, PUBLIC_FILE), sealed);
    // The sealed file never holds the key; it is an oa-seal-v1 value.
    const text = readFileSync(sealed, "utf8");
    expect(text.startsWith("oa-seal-v1.")).toBe(true);
    expect(text).not.toContain(HOOK);
    // The t19 job has no key until it opens.
    rmSync(credFile(targets, "a", "HOOK_KEY"));
    await t19Open(e, targets, dir, sealed);
    expect(readFileSync(credFile(targets, "a", "HOOK_KEY"), "utf8")).toBe(HOOK);
  });

  it("writes every secret file 0600, the directory 0700, and deletes the private key on open", async () => {
    const e = env();
    const dir = recipientDir(e);
    await t19Recipient(dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, PRIVATE_FILE))).toBe(0o600);
    const sealed = join(temp, "t19-sealed", "sealed");
    await t19Seal(e, targets, join(dir, PUBLIC_FILE), sealed);
    expect(mode(sealed)).toBe(0o600);
    rmSync(credFile(targets, "a", "HOOK_KEY"));
    await t19Open(e, targets, dir, sealed);
    expect(mode(credFile(targets, "a", "HOOK_KEY"))).toBe(0o600);
    expect(existsSync(join(dir, PRIVATE_FILE))).toBe(false);
    expect(existsSync(join(dir, PUBLIC_FILE))).toBe(true);
  });

  it("a sealed key does not open under another run or attempt (wrong AAD)", async () => {
    const dir = recipientDir(env());
    await t19Recipient(dir);
    const sealed = join(temp, "t19-sealed", "sealed");
    await t19Seal(env("1"), targets, join(dir, PUBLIC_FILE), sealed);
    rmSync(credFile(targets, "a", "HOOK_KEY"));
    for (const other of [env("2"), env("1", "42402998827")])
      await expect(t19Open(other, targets, dir, sealed)).rejects.toThrow();
    // The failed open still deleted the private key: a replay can't retry it.
    expect(existsSync(join(dir, PRIVATE_FILE))).toBe(false);
    expect(existsSync(credFile(targets, "a", "HOOK_KEY"))).toBe(false);
  });

  it("the primitives: right AAD opens, wrong or missing AAD fails, a second recipient can't open", async () => {
    const r = await newFileRecipient();
    const me = await loadRecipient(r);
    const sealed = await sealToKey(r.publicKey, "secret value", "1:1");
    expect(await openSealed(me, sealed, "1:1")).toBe("secret value");
    await expect(openSealed(me, sealed, "1:2")).rejects.toThrow();
    await expect(openSealed(me, sealed)).rejects.toThrow();
    const other = await loadRecipient({
      ...(await newFileRecipient()),
    });
    await expect(openSealed(other, sealed, "1:1")).rejects.toThrow();
  });

  it("refuses a low-order recipient key", async () => {
    for (const bad of ["A".repeat(43), `AQ${"A".repeat(41)}`, "AAAA"])
      await expect(sealToKey(bad, "x", "1:1"), bad).rejects.toThrow();
  });

  it("needs a run id and attempt, decimal", () => {
    expect(runAad(env())).toBe("42402998826:1");
    expect(() => runAad({})).toThrow();
    expect(() =>
      runAad({ GITHUB_RUN_ID: "1; rm", GITHUB_RUN_ATTEMPT: "1" }),
    ).toThrow();
  });
});

describe("scripts/provisioning.ts t19 commands", () => {
  it("t19-recipient writes the key pair under RUNNER_TEMP, printing no key", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "scripts/provisioning.ts",
        "t19-recipient",
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          RUNNER_TEMP: temp,
        },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    const priv = readFileSync(
      join(temp, "t19-recipient", PRIVATE_FILE),
      "utf8",
    );
    expect(r.stdout + r.stderr).not.toContain(priv);
    expect(mode(join(temp, "t19-recipient", PRIVATE_FILE))).toBe(0o600);
  });
});
