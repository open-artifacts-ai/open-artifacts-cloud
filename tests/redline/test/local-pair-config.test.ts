// #1252: the local pair's opt-in T19 flag. Off, every generated config is
// byte for byte what it was before the flag existed (the fixtures were
// written from the unchanged code), so the red-line suite's own runs can't
// change. On, it adds only the release's assets block, HOSTED, Cloudflare's
// always-pass Turnstile test keys, Google and codes only, and hosts with the
// port; and the script starts a fake IdP on 127.0.0.1, never with it off.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  localT19Of,
  requireT19Assets,
  T19_ASSETS,
  T19_IDP_CLIENT,
  T19_IDP_TENANTS,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
  t19Assets,
  t19Idp,
  wranglerConfig,
} from "../src/local-pair.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const I = {
  name: "rl-a",
  testDomain: "oa-redline-a.fyi",
  installId: "itestfixture0",
};
const FIXTURES = join(import.meta.dirname, "fixtures", "local-pair-config");
const text = (v: unknown) =>
  `${JSON.stringify(v, null, 2).split(ROOT).join("<root>")}\n`;
// .txt, not .json: the formatter would rewrite them, and they must stay
// exactly what JSON.stringify(config, null, 2) wrote before the flag.
const fixture = (name: string) =>
  readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
// The pinned public tree's own test config, which wranglerConfig starts from.
const PUBLIC = JSON.parse(
  readFileSync(join(ROOT, "apps", "server", "wrangler.test.jsonc"), "utf8"),
) as Record<string, unknown> & { vars?: Record<string, unknown> };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/**
 * The part of a config this repo's code decides: every top-level key and var
 * that differs from the public file, plus the names of the public ones it
 * drops. What passes through unchanged is the public release's, so a binding
 * public adds (open-artifacts#3010's IMAGES) needs no fixture port in the
 * bump (cloud #264); a change to a key wranglerConfig rewrites still shows.
 */
function cloudPart(cfg: Record<string, unknown>) {
  const pubVars = PUBLIC.vars ?? {};
  const vars = (cfg.vars ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg))
    if (k === "vars")
      out.vars = Object.fromEntries(
        Object.entries(vars).filter(([n, x]) => !same(x, pubVars[n])),
      );
    else if (!same(v, PUBLIC[k])) out[k] = v;
  out.dropped = Object.keys(PUBLIC).filter((k) => !(k in cfg));
  out.droppedVars = Object.keys(pubVars).filter((n) => !(n in vars));
  return out;
}
const part = (cfg: unknown) => text(cloudPart(cfg as Record<string, unknown>));

describe("local pair config, T19 flag off", () => {
  it("is byte-identical to the config before the flag (base, google, d1), past the public file", () => {
    expect(part(wranglerConfig(I, 8787))).toBe(fixture("base-kv"));
    expect(part(wranglerConfig(I, 8787, undefined, "base", "kv", false))).toBe(
      fixture("base-kv"),
    );
    expect(part(wranglerConfig(I, 8787, undefined, "google"))).toBe(
      fixture("google-kv"),
    );
    expect(part(wranglerConfig(I, 8787, undefined, "base", "d1"))).toBe(
      fixture("base-d1"),
    );
  });

  it("passes every other public key and var through unchanged", () => {
    for (const cfg of [
      wranglerConfig(I, 8787),
      wranglerConfig(I, 8787, undefined, "google"),
      wranglerConfig(I, 8787, undefined, "base", "d1"),
    ] as Record<string, unknown>[]) {
      const p = cloudPart(cfg);
      for (const k of Object.keys(PUBLIC))
        if (k !== "vars" && !(k in p) && !(p.dropped as string[]).includes(k))
          expect(cfg[k]).toEqual(PUBLIC[k]);
      const vars = cfg.vars as Record<string, unknown>;
      const pv = p.vars as Record<string, unknown>;
      for (const [n, x] of Object.entries(PUBLIC.vars ?? {}))
        if (!(n in pv) && !(p.droppedVars as string[]).includes(n))
          expect(vars[n]).toEqual(x);
      // The secrets never pass through.
      for (const s of [
        "SESSION_SECRET",
        "CONTENT_SIGNING_KEY",
        "TEST_HOOK_KEY",
        "ACCESS_CLIENT_SECRET",
        "GOOGLE_CLIENT_SECRET",
      ])
        expect(vars[s]).toBeUndefined();
    }
  });

  it("REDLINE_LOCAL_T19: off unless exactly 1", () => {
    expect(localT19Of({})).toBe(false);
    expect(localT19Of({ REDLINE_LOCAL_T19: "" })).toBe(false);
    expect(localT19Of({ REDLINE_LOCAL_T19: "1" })).toBe(true);
    for (const v of ["true", "yes", "0", " 1"])
      expect(() => localT19Of({ REDLINE_LOCAL_T19: v })).toThrow(
        /REDLINE_LOCAL_T19/,
      );
  });
});

describe("local pair config, T19 flag on", () => {
  const on = wranglerConfig(I, 8787, undefined, "base", "kv", true) as Record<
    string,
    unknown
  > & { vars: Record<string, string> };
  const off = wranglerConfig(I, 8787) as Record<string, unknown> & {
    vars: Record<string, string>;
  };

  it("adds only assets, HOSTED, the Turnstile test keys, Google and codes, hosts with the port", () => {
    const { assets, vars, ...rest } = on;
    const { vars: offVars, ...offRest } = off;
    expect(rest).toEqual(offRest);
    expect(assets).toEqual(t19Assets());
    expect(vars).toEqual({
      ...offVars,
      // A browser follows URLs the Worker builds from these (the signed
      // upload URL), so they carry the port the pair serves on.
      APP_HOST: "rl-a.app.localhost:8787",
      CONTENT_HOST: "rl-a.content.localhost:8787",
      // rl-a has no Access.
      AUTH_PROVIDERS: "google,email",
      HOSTED: "1",
      TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
      TURNSTILE_SECRET: TURNSTILE_TEST_SECRET,
    });
  });

  it("uses only Cloudflare's published always-pass test keys", () => {
    expect(TURNSTILE_TEST_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(TURNSTILE_TEST_SECRET).toBe("1x0000000000000000000000000000000AA");
  });

  it("the assets block is the release's, at apps/server/dist-assets", () => {
    // The release config (comments stripped, placeholders are strings).
    const raw = readFileSync(
      join(ROOT, "apps", "server", "wrangler.template.jsonc"),
      "utf8",
    );
    const json = raw
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const tpl = JSON.parse(json) as { assets: Record<string, unknown> };
    expect({ ...t19Assets(), directory: tpl.assets.directory }).toEqual(
      tpl.assets,
    );
    expect(T19_ASSETS).toBe(join(ROOT, "apps", "server", "dist-assets"));
  });

  it("fails clearly when apps/server/dist-assets isn't built", () => {
    const dir = mkdtempSync(join(tmpdir(), "t19-assets-"));
    try {
      expect(() => requireT19Assets(dir)).toThrow(
        /index\.html is missing; build the assets first with pnpm --filter @oa\/server build/,
      );
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      expect(() => requireT19Assets(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Resolves true if a TCP connect to host:port succeeds, false if refused. */
const reaches = (host: string, port: number) =>
  new Promise<boolean>((res) => {
    const s = connect({ host, port });
    s.setTimeout(3000, () => {
      s.destroy();
      res(false);
    });
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });

describe("T19's fake IdP", () => {
  it("is never started with the flag off", async () => {
    let calls = 0;
    const start = (async () => {
      calls++;
      throw new Error("started");
    }) as unknown as Parameters<typeof t19Idp>[1];
    expect(await t19Idp(false, start)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("with the flag on, feeds the pair and listens on localhost only", async () => {
    const idp = await t19Idp(true);
    expect(idp).toBeDefined();
    if (!idp) return;
    try {
      const u = new URL(idp.pair.origin);
      expect(u.protocol).toBe("http:");
      expect(u.hostname).toBe("127.0.0.1");
      const port = Number(u.port);
      expect(idp.pair.clientId).toBe(T19_IDP_CLIENT);
      expect(idp.pair.tenants).toEqual(T19_IDP_TENANTS);
      expect(idp.pair.clientSecret.length).toBeGreaterThanOrEqual(32);
      expect(await reaches("127.0.0.1", port)).toBe(true);
      // Every address of this machine that isn't loopback is refused.
      const others = Object.values(networkInterfaces())
        .flat()
        .filter((a) => a && !a.internal)
        .map((a) => a?.address as string)
        .filter((a) => !a.startsWith("fe80"));
      for (const a of others)
        expect([a, await reaches(a, port)]).toEqual([a, false]);
    } finally {
      await idp.stop();
    }
  });
});
