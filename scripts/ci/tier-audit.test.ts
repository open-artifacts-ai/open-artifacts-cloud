// tier-audit.sh: which prod install Workers lack a binding named TIER. Job logs are
// public: no count, no name of an install that is fine. curl is a stub that refuses any non-GET shape; the token reaches it on
// stdin only; no binding value, type or other name may reach the output.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const NS = "oa-prod";
const VALUE = "SECRET_TIER_VALUE_xyz";
const OTHER = "OTHER_BINDING_NAME_abc";
const OTHER_VALUE = "OTHER_BINDING_VALUE_def";

const ok = (result: unknown, info?: Record<string, unknown>) =>
  JSON.stringify({
    success: true,
    errors: [],
    result,
    ...(info ? { result_info: info } : {}),
  });
const settings = (bindings: unknown) => ok({ bindings });
const TIER_B = { name: "TIER", type: "plain_text", text: VALUE };
const OTHER_B = { name: OTHER, type: "secret_text", text: OTHER_VALUE };

// $STATE/list-<page> answers the listing, $STATE/set-<script> a settings GET;
// a sibling <file>.code overrides the HTTP status (default 200). A request
// with any method, body or form flag is logged UNEXPECTED and answered 500.
const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo "UNEXPECTED token"; exit 0 ;; esac
for a in "$@"; do case "$a" in -X|--request|-d|--data*|-F|--form|-T|--upload-file|--json|-G) echo "UNEXPECTED flag $a" >> "$STUB_LOG"; printf '{}\\n500'; exit 0 ;; esac; done
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
base="/accounts/$STUB_ACCT/workers/dispatch/namespaces/$STUB_NS/scripts"
case "$path" in
  "$base?per_page="*"&page="*) f="$STATE/list-\${path##*page=}" ;;
  "$base/"*"/settings") s="\${path#$base/}"; f="$STATE/set-\${s%/settings}" ;;
  *) echo "UNEXPECTED $path" >> "$STUB_LOG"; printf '{}\\n500'; exit 0 ;;
esac
[ -f "$f" ] || { printf '{"success":false,"errors":[{"code":10007}]}\\n404'; exit 0; }
[ "$(cat "$f")" = NETERR ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }
code=200; [ -f "$f.code" ] && code="$(cat "$f.code")"
printf '%s\\n%s' "$(cat "$f")" "$code"`;

const run = (
  files: Record<string, string>,
  env: Record<string, string> = {},
) => {
  const sb = sandbox({ curl });
  for (const [n, body] of Object.entries(files))
    writeFileSync(join(sb.dir, n), body);
  const r = sb.run(["bash", script("tier-audit.sh")], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      DISPATCH_NAMESPACE: NS,
      STUB_ACCT: ACCT,
      STUB_NS: NS,
      ...env,
    },
  });
  const log = sb.log();
  const all = [r.out, r.err, ...log].join("\n");
  for (const secret of [
    TOK,
    VALUE,
    OTHER,
    OTHER_VALUE,
    "plain_text",
    "secret_text",
  ])
    expect(all).not.toContain(secret);
  expect(log.filter((l) => l.startsWith("UNEXPECTED"))).toEqual([]);
  return { ...r, log };
};
const ids = (...n: string[]) => ok(n.map((id) => ({ id })));

describe("tier-audit.sh", () => {
  it("prints only the scripts without TIER and a without-count, even when a TIER value is present", () => {
    const r = run({
      "list-1": ids("i-a", "i-b", "i-c"),
      "set-i-a": settings([OTHER_B, TIER_B]),
      "set-i-b": settings([OTHER_B]),
      "set-i-c": settings([]),
    });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "i-b TIER=no",
      "i-c TIER=no",
      "2 without TIER",
      "",
    ]);
    expect(r.out).not.toContain("i-a");
    expect(r.out).not.toMatch(/total|with_tier|TIER=yes/);
  });

  it("says every install has TIER and prints no name or count", () => {
    const r = run({
      "list-1": ids("i-a", "i-b"),
      "set-i-a": settings([TIER_B]),
      "set-i-b": settings([OTHER_B, TIER_B]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("every install has TIER\n");
  });

  it("matches the binding name exactly", () => {
    const r = run({
      "list-1": ids("i-a"),
      "set-i-a": settings([{ name: "TIER_X" }, { name: "tier" }]),
    });
    expect(r.out).toBe("i-a TIER=no\n1 without TIER\n");
  });

  it("follows pagination and counts each script once", () => {
    const r = run({
      "list-1": ok([{ id: "i-a" }, { id: "i-b" }], { total_pages: 2 }),
      "list-2": ok([{ id: "i-c" }], { total_pages: 2 }),
      "set-i-a": settings([TIER_B]),
      "set-i-b": settings([TIER_B]),
      "set-i-c": settings([]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("i-c TIER=no\n1 without TIER\n");
    const lists = r.log.filter((l) => l.includes("per_page="));
    expect(lists).toHaveLength(2);
    expect(lists[1]).toContain("page=2");
  });

  it("stops when the API ignores paging and repeats a full page", () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `i-${i}` }));
    const files: Record<string, string> = {
      "list-1": ok(full),
      "list-2": ok(full),
    };
    for (const x of full) files[`set-${x.id}`] = settings([]);
    const r = run(files);
    expect(r.code).toBe(0);
    expect(r.out).toContain("100 without TIER");
  });

  it("names a failing script with status and error codes only, and exits 1", () => {
    const r = run({
      "list-1": ids("i-a", "i-b"),
      "set-i-a": settings([TIER_B]),
      "set-i-b": JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: `leak ${VALUE}` }],
      }),
      "set-i-b.code": "403",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("i-b ERROR HTTP 403 codes=10000");
    expect(r.out).toContain("errors=1");
    expect(r.out).not.toContain("every install has TIER");
    expect(r.out).not.toContain("i-a");
  });

  it.each([
    ["a network error", { "list-1": "NETERR" }, "network error"],
    [
      "a listing error",
      {
        "list-1": JSON.stringify({ success: false, errors: [{ code: 9109 }] }),
        "list-1.code": "401",
      },
      "HTTP 401 codes=9109",
    ],
    ["an unparsable listing", { "list-1": "<html>" }, "HTTP 200 codes=none"],
    ["no result list", { "list-1": ok({}) }, "no result list"],
  ])("fails closed on %s", (_, files, msg) => {
    const r = run(files as Record<string, string>);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(r.out).toBe("");
  });

  it("reports settings without a bindings list as an error", () => {
    const r = run({ "list-1": ids("i-a"), "set-i-a": ok({}) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("i-a ERROR no bindings list");
    expect(r.out).toContain("errors=1");
  });

  it("skips a script name that is not a plain name, without requesting it", () => {
    const r = run({ "list-1": ids("../x", "i-a"), "set-i-a": settings([]) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR unexpected script name");
    expect(r.out).not.toMatch(/#\d/);
    expect(r.out).not.toContain("../x");
    expect(r.log.filter((l) => l.includes("settings"))).toHaveLength(1);
  });

  it("makes only GET requests: no method, body or form flag, token on stdin", () => {
    const r = run({
      "list-1": ids("i-a"),
      "set-i-a": settings([TIER_B]),
    });
    const curls = r.log.filter((l) => l.startsWith("curl "));
    expect(curls).toHaveLength(2);
    for (const l of curls) {
      expect(l).toContain("-K -");
      expect(l).not.toMatch(
        / (-X|--request|-d|--data\S*|-F|--form|-T|--json)\b/,
      );
      expect(l).not.toContain("Authorization");
    }
  });

  it("the script names no method or body flag and no non-GET helper", () => {
    const text = readFileSync(script("tier-audit.sh"), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(text).not.toMatch(
      /(^|\s)(-X|--request|--data\S*|-d|-F|--form|-T)\s/,
    );
    expect(text).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(text.match(/\bcurl\b/g)).toHaveLength(1);
    expect(
      readFileSync(join(root, "scripts/ci/hosted-cf.sh"), "utf8"),
    ).toContain("CF=https://api.cloudflare.com/client/v4");
  });

  it("takes no arguments", () => {
    const sb = sandbox({ curl });
    const r = sb.run(["bash", script("tier-audit.sh"), "x"], {
      env: {
        CLOUDFLARE_API_TOKEN: TOK,
        CLOUDFLARE_ACCOUNT_ID: ACCT,
        DISPATCH_NAMESPACE: NS,
      },
    });
    expect(r.code).toBe(2);
    expect(sb.log()).toEqual([]);
  });

  it.each([
    ["DISPATCH_NAMESPACE", "a/b"],
    ["CLOUDFLARE_ACCOUNT_ID", "nothex"],
  ])("refuses a malformed %s before any request", (k, v) => {
    const r = run({ "list-1": ids() }, { [k]: v });
    expect(r.code).toBe(2);
    expect(r.log.filter((l) => l.startsWith("curl "))).toEqual([]);
  });
});
