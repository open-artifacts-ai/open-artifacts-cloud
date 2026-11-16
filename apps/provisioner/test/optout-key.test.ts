import { describe, expect, it } from "vitest";
import { deriveOptoutHashKey } from "../src/optout-key.js";
import { provisionerOptions } from "../src/provisioner.js";

const ROOT = "r".repeat(44);
const io = {
  fetch: (async () => new Response("{}")) as typeof fetch,
  now: () => 0,
  sleep: async () => {},
};
// A reference HKDF-SHA-256 (RFC 5869), independent of the module under test.
async function ref(root: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const prk = createHmac("sha256", Buffer.alloc(32)).update(root).digest();
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("oa-optout-v1"), Buffer.from([1])]))
    .digest();
  return okm.toString("base64url");
}
const env = (o: Record<string, string | undefined>) =>
  ({
    PROVISION_TOKEN: { get: async () => "tok" },
    RELEASES: {},
    ACCOUNT_ID: "a".repeat(32),
    OA_ENV: "staging",
    ...o,
  }) as never;

describe("OPTOUT_HASH_KEY derivation", () => {
  it("is HKDF-SHA-256 of the root, info oa-optout-v1, and deterministic", async () => {
    const k = await deriveOptoutHashKey(ROOT);
    expect(k).toBe(await ref(ROOT));
    expect(await deriveOptoutHashKey(ROOT)).toBe(k);
    expect(await deriveOptoutHashKey("s".repeat(44))).not.toBe(k);
  });
  it("is in every install's options when OPTOUT_LIST is 1, identical across calls, absent when 0", async () => {
    const on = { OPTOUT_LIST: "1", OPTOUT_ROOT_KEY: ROOT };
    const a = await provisionerOptions(env(on), "l", io, "j1");
    const b = await provisionerOptions(env(on), "l", io, "j2");
    expect(a.optoutHashKey).toBe(await ref(ROOT));
    expect(b.optoutHashKey).toBe(a.optoutHashKey);
    for (const off of [{ OPTOUT_LIST: "0", OPTOUT_ROOT_KEY: ROOT }, {}]) {
      const o = await provisionerOptions(env(off), "l", io, "j3");
      expect(o.optoutHashKey).toBeUndefined();
    }
  });
  it("on without the root is a terminal failure that does not say the root", async () => {
    await expect(
      provisionerOptions(env({ OPTOUT_LIST: "1" }), "l", io, "j4"),
    ).rejects.toThrow();
  });
});
