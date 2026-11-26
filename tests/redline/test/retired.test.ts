import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/report.ts";
import { RETIRED, retiredGaps } from "../src/retired.ts";
import { SPLIT_RETIRED } from "../src/retired-split.ts";
import { readRepoFile } from "../src/surfaces.ts";

const manifest = () =>
  parseManifest(
    readFileSync(join(import.meta.dirname, "../live/manifest.json"), "utf8"),
  ).cases;

describe("retired live cases (#1235)", () => {
  it("none is in the manifest, and every replacement resolves", () => {
    expect(retiredGaps(manifest(), readRepoFile)).toEqual([]);
  });

  it("each names the failure it guarded (a failure-model id) or none", () => {
    // #1235's 17, plus cloud #264 step 2's (src/retired-split.ts).
    expect(RETIRED).toHaveLength(17 + SPLIT_RETIRED.length);
    for (const r of RETIRED) {
      expect(r.guards).toMatch(/^(none|[A-Z]+-\d+)$/);
      expect(r.coveredBy.length).toBeGreaterThan(0);
    }
  });

  it("flag a retired case put back in the manifest", () => {
    const [r] = RETIRED;
    if (!r) throw new Error("no retired case");
    expect(
      retiredGaps(
        [...manifest(), { file: r.file, name: r.name }],
        readRepoFile,
      ),
    ).toContain(`retired but still required: ${r.file} > ${r.name}`);
  });

  it("flag a replacement whose test was renamed", () => {
    const r = RETIRED.find((x) => x.name.startsWith("scheduler"));
    const c = r?.coveredBy[0];
    if (!r || !c?.test) throw new Error("no cited test");
    const test = c.test;
    const gaps = retiredGaps(manifest(), (p) =>
      p === c.file
        ? (readRepoFile(p) ?? "").replaceAll(test, "renamed")
        : readRepoFile(p),
    );
    expect(gaps).toContain(
      `${r.file} > ${r.name}: no test "${test}" in ${c.file}`,
    );
  });

  it("cloud #264 step 2: every retired case is out of the manifest, and the nightly and smoke cases stay", () => {
    const m = manifest();
    const has = (file: string, name: string) =>
      m.some((c) => c.file === file && c.name === name);
    // 422 cases before: 283 retired, 139 live (nightly).
    expect(m).toHaveLength(139);
    expect(SPLIT_RETIRED).toHaveLength(283);
    for (const r of SPLIT_RETIRED)
      expect(has(r.file, r.name), r.name).toBe(false);
    for (const [file, name] of [
      [
        "live/guard.test.ts",
        "credentials (harness smoke) > A's admin PAT at B: /api/v1/me",
      ],
      [
        "live/guard.test.ts",
        "credentials (harness smoke) > A's session cookie at B: /api/v1/me",
      ],
      [
        "live/credentials.test.ts",
        "credentials > A's MCP OAuth access token at B: /mcp tools/list",
      ],
      [
        "live/credentials.test.ts",
        "credentials > A's signed content URL at B's content host",
      ],
      // No single named PR test yet: kept live.
      [
        "live/credentials.test.ts",
        "credentials > B's private artifact id fetched with A's credentials at A: 404",
      ],
      [
        "live/edge.test.ts",
        "unmapped host > unmapped names get the generic 404, never an install",
      ],
      [
        "live/edge.test.ts",
        "unmapped host > a deleted install's old host gets the generic 404",
      ],
      [
        "live/surfaces.test.ts",
        "surface probes (cross-install) > artifact mcp get_artifact [oauth]",
      ],
      [
        "live/surfaces.test.ts",
        "surface probes (cross-install) > org DELETE /api/v1/oauth-clients/:grantId [session]",
      ],
    ] as const)
      expect(has(file, name), name).toBe(true);
    // P4 and P12 have no named PR test for every leg: kept live.
    for (const id of [
      "P4",
      "P12",
      "P15",
      "P20",
      "P21",
      "P22",
      "P23",
      "P25",
      "P29",
      "P31",
      "P32",
      "P34",
      "P45",
      "P52",
      "P53",
    ])
      expect(
        m.some((c) => c.name.startsWith(`provisioning > ${id}: `)),
        id,
      ).toBe(true);
    expect(m.filter((c) => c.file === "live/bus.test.ts")).toHaveLength(2);
  });

  it("every citation names its test: file, describe and test name", () => {
    for (const r of RETIRED)
      for (const c of r.coveredBy)
        expect(c.test, `${r.name}: ${c.file}`).toBeTruthy();
  });

  it("refuses a citation that names no test", () => {
    const [r] = SPLIT_RETIRED;
    if (!r) throw new Error("no retired case");
    const c = r.coveredBy[0];
    if (!c) throw new Error("no citation");
    const saved = c.test;
    try {
      delete (c as { test?: string }).test;
      expect(retiredGaps(manifest(), readRepoFile)).toContain(
        `${r.file} > ${r.name}: a citation names no test (${c.file} "${c.describe}")`,
      );
    } finally {
      (c as { test?: string }).test = saved;
    }
  });

  it("P43 and P44 cite a named test for each of their legs", () => {
    const of = (id: string) =>
      SPLIT_RETIRED.find((r) =>
        r.name.startsWith(`provisioning > ${id}: `),
      )?.coveredBy.map((c) => c.test);
    expect(of("P43")).toEqual([
      "no session, cross-site: 200 bounce page to the same URL plus b=1",
      "no session with b=1, or same-origin: the sign-in page links /auth/start with the query, b dropped",
    ]);
    expect(of("P44")).toEqual([
      "loopback with a port and the exact MCP_REDIRECT_URIS entry are accepted",
      "refuses %s with invalid_redirect_uri, counted in oauth_register",
    ]);
  });
});
