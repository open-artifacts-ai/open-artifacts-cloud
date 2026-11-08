import { webcrypto } from "node:crypto";

// The caller's side of R26's sealed delivery (design v7 10.1): an ephemeral
// X25519 key pair per run, its public key sent as `recipientKey`, and the
// opener for R15's `sealed` (`oa-seal-v1.<epk>.<iv>.<ciphertext>`, each
// base64url; ECDH, HKDF-SHA256 over epk || recipient key with info
// "oa-redline-creds-v1", AES-256-GCM). The sealer is
// apps/provisioner/src/seal.ts; test/seal.test.ts round-trips the two.

const subtle = webcrypto.subtle;
const PREFIX = "oa-seal-v1";
const INFO = new TextEncoder().encode("oa-redline-creds-v1");
const X25519 = { name: "X25519" } as const;

const b64u = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    "base64url",
  );
const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("sealed: not base64url");
  const b = Buffer.from(s, "base64url");
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

export interface Recipient {
  pair: CryptoKeyPair;
  /** The raw public key, base64url without padding (R26 `recipientKey`). */
  publicKey: string;
}

/**
 * A fresh X25519 key pair; the private key is not extractable, so it never
 * leaves this process. Only the public key is exported.
 */
export async function newRecipient(): Promise<Recipient> {
  const pair = (await subtle.generateKey(X25519, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = await subtle.exportKey("raw", pair.publicKey);
  return { pair, publicKey: b64u(raw) };
}

/** Opens an `oa-seal-v1` value sealed to `r`. Throws on any other shape or key. */
export async function openSealed(
  r: Recipient,
  sealed: string,
  /** The AAD it was sealed with (T19's cross-job hand-off, below); none for R26's. */
  aad?: string,
): Promise<string> {
  const [p, e, i, c, ...rest] = sealed.split(".");
  if (p !== PREFIX || !e || !i || !c || rest.length)
    throw new Error("sealed: not an oa-seal-v1 value");
  const epk = fromB64u(e);
  const pub = await subtle.importKey("raw", epk, X25519, false, []);
  const shared = await subtle.deriveBits(
    { name: "X25519", public: pub },
    r.pair.privateKey,
    256,
  );
  const mine = fromB64u(r.publicKey);
  const salt = new Uint8Array(epk.length + mine.length);
  salt.set(epk, 0);
  salt.set(mine, epk.length);
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromB64u(i),
      ...(aad === undefined
        ? {}
        : { additionalData: new TextEncoder().encode(aad) }),
    },
    key,
    fromB64u(c),
  );
  return new TextDecoder().decode(pt);
}

/** R26's sealed payload: `{pat, hookKey}` (apps/provisioner/src/redline.ts). */
export interface RedlineCredsPlain {
  pat: string;
  hookKey: string;
}

export function parseCreds(plain: string): RedlineCredsPlain {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new Error("sealed creds: not JSON");
  }
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.pat !== "string" || !o.pat.startsWith("oa_pat_"))
    throw new Error("sealed creds: no oa_pat_ PAT");
  if (typeof o.hookKey !== "string" || o.hookKey.length < 32)
    throw new Error("sealed creds: no hook key");
  return { pat: o.pat, hookKey: o.hookKey };
}

// --- T19's cross-job hand-off (#1730) ---------------------------------------
// rl-a's hook key crosses from the redline job to the t19 job as an
// oa-seal-v1 value sealed to a key pair only the t19 job holds, with the run
// as AAD (`run_id:run_attempt`), so a sealed key can't be replayed into
// another run. The sealer is apps/provisioner/src/seal.ts's, plus the AAD.

/** A key pair whose private half can be written to a file (0600) and read back. */
export interface FileRecipient {
  /** PKCS#8, base64url: the private key's file content. */
  privateKey: string;
  /** The raw public key, base64url. */
  publicKey: string;
}

export async function newFileRecipient(): Promise<FileRecipient> {
  const pair = (await subtle.generateKey(X25519, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    privateKey: b64u(await subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: b64u(await subtle.exportKey("raw", pair.publicKey)),
  };
}

/** A Recipient from a key pair read from files. */
export async function loadRecipient(f: FileRecipient): Promise<Recipient> {
  const priv = await subtle.importKey(
    "pkcs8",
    fromB64u(f.privateKey),
    X25519,
    false,
    ["deriveBits"],
  );
  const pub = await subtle.importKey(
    "raw",
    fromB64u(f.publicKey),
    X25519,
    true,
    [],
  );
  return { pair: { privateKey: priv, publicKey: pub }, publicKey: f.publicKey };
}

/** `plaintext` sealed to the raw X25519 public key `recipientKey`, bound to `aad`. */
export async function sealToKey(
  recipientKey: string,
  plaintext: string,
  aad: string,
): Promise<string> {
  const mine = fromB64u(recipientKey);
  if (mine.length !== 32)
    throw new Error("seal: recipient key is not 32 bytes");
  const rpub = await subtle.importKey("raw", mine, X25519, false, []);
  const eph = (await subtle.generateKey(X25519, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const shared = await subtle.deriveBits(
    { name: "X25519", public: rpub },
    eph.privateKey,
    256,
  );
  if (new Uint8Array(shared).every((x) => x === 0))
    throw new Error("seal: recipient key is of small order");
  const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const salt = new Uint8Array(epk.length + mine.length);
  salt.set(epk, 0);
  salt.set(mine, epk.length);
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [PREFIX, b64u(epk), b64u(iv), b64u(ct)].join(".");
}
