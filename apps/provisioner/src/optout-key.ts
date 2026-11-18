// The hosted opt-out list's one purpose key (open-artifacts#2652). Every hosted
// install gets the same OPTOUT_HASH_KEY, derived (never stored, never logged)
// from the platform root secret OPTOUT_ROOT_KEY with HKDF-SHA-256: salt empty,
// info "oa-optout-v1", 32 bytes, base64url. The same root always gives the same
// key, so a render never rotates it.

export const OPTOUT_HKDF_INFO = "oa-optout-v1";

/** The root's HKDF output as 32 base64url bytes. */
export async function deriveOptoutHashKey(root: string): Promise<string> {
  if (root.length < 32) throw new Error("OPTOUT_ROOT_KEY is too short");
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(root),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode(OPTOUT_HKDF_INFO),
    },
    ikm,
    256,
  );
  let bin = "";
  for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
