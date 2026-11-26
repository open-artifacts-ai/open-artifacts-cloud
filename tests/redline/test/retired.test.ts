import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/report.ts";
import {
  citedTestGaps,
  HOSTED_MATRIX_CI,
  hostedMatrixCiGaps,
  RETIRED,
  retiredGaps,
} from "../src/retired.ts";
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

describe("a skipped test is no replacement (cloud #264 step 2)", () => {
  const file = "x.test.ts";
  const gaps = (text: string, describe = "outer", test = "the case") =>
    citedTestGaps("r", { file, describe, test }, text);

  it("an enabled test under its describe resolves", () => {
    expect(
      gaps('describe("outer", () => {\n  it("the case", () => {});\n});\n'),
    ).toEqual([]);
  });

  it("it.skip, it.todo, xit, skipIf and runIf on the test itself are no replacement", () => {
    for (const head of [
      'it.skip("the case"',
      'it.todo("the case"',
      'xit("the case"',
      'it.skipIf(x)("the case"',
      'it.runIf(CI)("the case"',
      'it.concurrent.skip("the case"',
    ])
      expect(
        gaps(`describe("outer", () => {\n  ${head}, () => {});\n});\n`),
        head,
      ).toEqual(['r: the cited test "the case" in x.test.ts is skipped']);
  });

  it("a skip anywhere up the describe chain is no replacement", () => {
    const text = [
      'describe.skip("outer", () => {',
      '  describe("middle", () => {',
      '    it("the case", () => {});',
      "  });",
      "});",
      "",
    ].join("\n");
    expect(gaps(text)).toEqual([
      'r: the cited test "the case" in x.test.ts is skipped',
    ]);
    expect(gaps(text.replace("describe.skip", "xdescribe"))).toHaveLength(1);
    expect(gaps(text.replace("describe.skip", "describe"))).toEqual([]);
  });

  it("generated rows count: describe.each and it.each keep their template titles", () => {
    const text = [
      'describe("outer", () => {',
      '  describe.each(ROWS.filter((s) => !off(s)).map((s) => ({ ...s })))("$name", (s) => {',
      "    it.concurrent.each(CALLERS.map((c) => [c]))(",
      '      "%s",',
      "      async () => {},",
      "    );",
      "  });",
      "});",
      "",
    ].join("\n");
    expect(gaps(text, "outer", "%s")).toEqual([]);
    expect(
      gaps(
        text.replace("describe.each(", "describe.skip.each("),
        "outer",
        "%s",
      ),
    ).toHaveLength(1);
  });

  it("a test under another describe, or none, is not the cited one", () => {
    const text =
      'describe("other", () => {\n  it("the case", () => {});\n});\nit("the case", () => {});\n';
    expect(gaps(text)).toEqual([
      'r: no test "the case" under "outer" in x.test.ts',
    ]);
  });

  it("on the real files: P44's cited test, or its whole suite, skipped is a gap", () => {
    const f = "apps/provisioning/test/oauth.test.ts";
    const skip = (fn: (t: string) => string) =>
      retiredGaps(manifest(), (p) =>
        p === f ? fn(readRepoFile(p) ?? "") : readRepoFile(p),
      );
    const p44 = (g: string[]) =>
      g.filter((x) => x.includes("P44") && x.includes("is skipped"));
    expect(p44(skip((t) => t))).toEqual([]);
    expect(
      p44(
        skip((t) => t.replace(/\bit(\(\s*"loopback with a port)/, "it.skip$1")),
      ),
    ).toHaveLength(1);
    expect(
      p44(
        skip((t) =>
          t.replace(
            'describe("DCR (/oauth/register)"',
            'describe.skip("DCR (/oauth/register)"',
          ),
        ),
      ),
    ).toHaveLength(2);
  });

  it("the matrix citations need the hosted run as a blocking PR step in public's CI", () => {
    const real = readRepoFile(HOSTED_MATRIX_CI.file);
    expect(hostedMatrixCiGaps(real)).toEqual([]);
    const gapsWith = (fn: (t: string) => string) =>
      retiredGaps(manifest(), (p) =>
        p === HOSTED_MATRIX_CI.file ? fn(real ?? "") : readRepoFile(p),
      ).filter((g) => g.startsWith(HOSTED_MATRIX_CI.file));
    expect(gapsWith((t) => t)).toEqual([]);
    const step = "      - run: pnpm --filter @oa/server test:authz:hosted\n";
    expect(real).toContain(step);
    const cases: [string, (t: string) => string][] = [
      [
        "only in a comment",
        (t) =>
          t.replace(
            step,
            "      - run: echo nothing # pnpm --filter @oa/server test:authz:hosted\n",
          ),
      ],
      ["if: false", (t) => t.replace(step, `${step}        if: false\n`)],
      [
        "if: ${{ false }}",
        (t) => t.replace(step, `${step}        if: \${{ false }}\n`),
      ],
      [
        "continue-on-error",
        (t) => t.replace(step, `${step}        continue-on-error: true\n`),
      ],
      [
        "only on push",
        (t) =>
          t.replace(step, `${step}        if: github.event_name == 'push'\n`),
      ],
      [
        "only echoed",
        (t) =>
          t.replace(
            step,
            "      - run: echo pnpm --filter @oa/server test:authz:hosted\n",
          ),
      ],
      [
        "only printed by printf",
        (t) =>
          t.replace(
            step,
            "      - run: printf '%s' 'pnpm --filter @oa/server test:authz:hosted'\n",
          ),
      ],
      [
        "a non-PR job",
        (t) =>
          t.replace(
            "  authz-matrix:\n",
            "  authz-matrix:\n    if: github.event_name == 'push'\n",
          ),
      ],
      [
        "no pull_request trigger",
        (t) => t.replace(/^ {2}pull_request:.*\n/m, ""),
      ],
      [
        "no merge_group trigger",
        (t) => t.replace(/^ {2}merge_group:.*\n/m, ""),
      ],
      ["unreadable", () => "\u0000: ["],
    ];
    for (const [what, fn] of cases) {
      const changed = fn(real ?? "");
      if (what !== "unreadable") expect(changed, what).not.toBe(real);
      expect(gapsWith(fn), what).toHaveLength(1);
    }
    expect(hostedMatrixCiGaps(null)).toHaveLength(1);
    // A condition that can be true (the release-only skip) still counts.
    const cond = "        if: ${{ steps.ro.outputs.release_only != 'true' }}\n";
    expect(real).toContain(`${step}${cond}`);
  });
});
