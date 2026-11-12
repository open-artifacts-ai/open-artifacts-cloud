import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type Binding,
  type InstallMetaInput,
  parseBusSlugs,
  parseTemplate,
  type ResourceMetaInput,
  userWorkerMetadata,
} from "../src/index.js";

// #1299 part 6: the bus is on for a few named staging installs only, from the
// provisioner's STAGING_BUS_SLUGS list; no var, no route, no prod effect.

const tpl = parseTemplate(
  await readFile(
    new URL("../../../apps/server/wrangler.template.jsonc", import.meta.url),
    "utf8",
  ),
);
const inst = (
  slug: string,
  vars: Record<string, string> = {},
): InstallMetaInput => ({
  id: "iabcdefghjk2",
  appHost: `${slug}.app.test`,
  contentHost: `${slug}.content.test`,
  ownerEmail: "o@x.test",
  vars,
  testHooks: false,
});
const res = (o: Partial<ResourceMetaInput> = {}): ResourceMetaInput => ({
  d1Id: "11111111-2222-4333-8444-555555555555",
  kvId: "0123456789abcdef0123456789abcdef",
  version: "1.2.3",
  rlNs: 2_000_000,
  doMigrationTag: null,
  env: "staging",
  target: "account",
  mode: "create",
  assetsJwt: "jwt",
  mainModule: "index.js",
  secrets: { SESSION_SECRET: "s", CONTENT_SIGNING_KEY: "c" },
  template: tpl,
  ...o,
});
const features = (b: Binding[]): string =>
  String(
    b.find((x) => x.name === "FEATURES" && x.type === "plain_text")?.text ?? "",
  );
const on = (
  slug: string,
  vars: Record<string, string>,
  o: Partial<ResourceMetaInput>,
) => features(userWorkerMetadata(inst(slug, vars), res(o)).bindings);

const LIST = ["rl-agents", "bus1299-b"];

describe("parseBusSlugs", () => {
  it("keeps exact lowercase slugs and drops anything malformed", () => {
    expect(parseBusSlugs("rl-agents,bus1299-b")).toEqual(LIST);
    expect(parseBusSlugs(undefined)).toEqual([]);
    expect(parseBusSlugs("")).toEqual([]);
    expect(
      parseBusSlugs("rl-agents, bus1299-b,,A,x y,a.b,*,rl-*,-x,x-,a--b"),
    ).toEqual(["rl-agents"]);
  });
});

describe("staging bus slugs in userWorkerMetadata", () => {
  it("staging and listed: bus is added once, with a tier", () => {
    const f = on("rl-agents", { TIER: "team" }, { busSlugs: LIST });
    const parts = f.split(",");
    expect(parts.filter((x) => x === "bus")).toHaveLength(1);
    const base = on("other", { TIER: "team" }, { busSlugs: LIST });
    expect(f).toBe(`${base},bus`);
  });

  it("staging and listed, no tier: bus after explicit FEATURES, deduped", () => {
    expect(on("bus1299-b", {}, { busSlugs: LIST })).toMatch(/\bbus\b/);
    const f = on("bus1299-b", { FEATURES: "bus,x" }, { busSlugs: LIST }).split(
      ",",
    );
    expect(f.filter((x) => x === "bus")).toHaveLength(1);
    expect(f).toContain("x");
  });

  it("staging, unlisted or near-miss slug: unchanged", () => {
    const base = on("zzz", { TIER: "team" }, {});
    for (const s of ["rl-agent", "rl-agents2", "xrl-agents", "rl", "bus1299-a"])
      expect(on(s, { TIER: "team" }, { busSlugs: LIST }), s).toBe(base);
    expect(base).not.toMatch(/\bbus\b/);
  });

  it("busAll on staging: an unlisted slug gets bus, once, with the tier's features kept (#2325)", () => {
    const f = on("anything", { TIER: "team" }, { busAll: true }).split(",");
    expect(f.filter((x) => x === "bus")).toHaveLength(1);
    const base = on("anything", { TIER: "team" }, {}).split(",");
    expect(f.filter((x) => x !== "bus")).toEqual(base);
    expect(on("anything", {}, { busAll: false })).not.toMatch(/\bbus\b/);
  });

  it("busAll on prod: nothing, even with the list (#2325)", () => {
    const base = on("anything", { TIER: "team" }, { env: "prod" });
    expect(
      on(
        "anything",
        { TIER: "team" },
        { env: "prod", busAll: true, busSlugs: LIST },
      ),
    ).toBe(base);
    expect(base).not.toMatch(/\bbus\b/);
  });

  it("prod and listed: unchanged", () => {
    const base = on("rl-agents", { TIER: "team" }, { env: "prod" });
    expect(
      on("rl-agents", { TIER: "team" }, { env: "prod", busSlugs: LIST }),
    ).toBe(base);
    expect(base).not.toMatch(/\bbus\b/);
  });

  it("a malformed list entry never matches", () => {
    for (const bad of [["RL-AGENTS"], [" rl-agents"], ["rl-*"], [""]])
      expect(on("rl-agents", {}, { busSlugs: bad })).not.toMatch(/\bbus\b/);
  });

  it("is rebuilt the same on every render (upgrade, rollback, var change)", () => {
    const a = on(
      "rl-agents",
      { TIER: "team" },
      { busSlugs: LIST, mode: "update" },
    );
    const b = on(
      "rl-agents",
      { TIER: "team" },
      { busSlugs: LIST, mode: "create" },
    );
    expect(a).toBe(b);
    expect(a).toMatch(/\bbus\b/);
    // Removed from the list: the next render drops it.
    expect(
      on(
        "rl-agents",
        { TIER: "team" },
        { busSlugs: ["bus1299-b"], mode: "update" },
      ),
    ).not.toMatch(/\bbus\b/);
  });

  it("TIER with FEATURES is still refused", () => {
    expect(() =>
      userWorkerMetadata(
        inst("rl-agents", { TIER: "team", FEATURES: "sync_google" }),
        res({ busSlugs: LIST }),
      ),
    ).toThrow(/derived from TIER/);
  });
});
