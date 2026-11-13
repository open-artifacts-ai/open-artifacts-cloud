// do-orphans.sh (open-artifacts#2360): staging Durable Object namespaces whose
// install Worker is gone, report-only. curl is a stub (GET only); the token
// reaches it on stdin only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const NS = "oa-staging";

// $STATE/do-<page> answers the namespace listing, $STATE/scripts-<page> the
// dispatch namespace's. Any flag that makes a non-GET is logged UNEXPECTED.
const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"code":9109}]}'; exit 0 ;; esac
for a in "$@"; do case "$a" in -X|--request|-d|--data*|-F|--form|-T|--json) echo "UNEXPECTED flag $a" >> "$STUB_LOG"; echo '{"success":false}'; exit 0 ;; esac; done
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
case "$path" in
  "/accounts/$STUB_ACCT/workers/durable_objects/namespaces?"*"&page="*) f="$STATE/do-\${path##*page=}" ;;
  "/accounts/$STUB_ACCT/workers/dispatch/namespaces/$STUB_NS/scripts?"*"&page="*) f="$STATE/scripts-\${path##*page=}" ;;
  *) echo "UNEXPECTED $path" >> "$STUB_LOG"; echo '{"success":false}'; exit 0 ;;
esac
[ -f "$f" ] || { echo '{"success":false,"errors":[{"code":10007}]}'; exit 0; }
[ "$(cat "$f")" = NETERR ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }
cat "$f"`;

const ok = (result: unknown[], total_pages?: number) =>
  JSON.stringify({
    success: true,
    errors: [],
    result,
    ...(total_pages ? { result_info: { total_pages } } : {}),
  });
const ns = (id: string, script: string, cls: string) => ({
  id,
  script,
  class: cls,
  name: `${script}-${cls}`,
});
const sc = (...n: string[]) => ok(n.map((id) => ({ id })));

const run = (files: Record<string, string>) => {
  const sb = sandbox({ curl });
  for (const [n, body] of Object.entries(files))
    writeFileSync(join(sb.dir, n), body);
  const r = sb.run(["bash", script("do-orphans.sh")], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      DISPATCH_NAMESPACE: NS,
      STUB_ACCT: ACCT,
      STUB_NS: NS,
    },
  });
  const log = sb.log();
  expect([r.out, r.err, ...log].join("\n")).not.toContain(TOK);
  expect(log.filter((l) => l.startsWith("UNEXPECTED"))).toEqual([]);
  return { ...r, log };
};

describe("do-orphans.sh", () => {
  it("prints counts only: live and orphan, then the orphans per class; no script name or id", () => {
    const r = run({
      "do-1": ok([
        ns("n1-id", "oa-s-iaaa", "BusHub"),
        ns("n2-id", "oa-s-iaaa", "Other"),
        ns("n3-id", "oa-s-ibbb", "BusHub"),
        ns("n4-id", "oa-s-ibbb", "Other"),
        ns("n7-id", "oa-s-iddd", "BusHub"),
        ns("n8-id", "oa-s-iddd", "we ird/Class"),
        ns("n5-id", "oa-s-provisioner", "Wf"),
        ns("n6-id", "oa-p-iccc", "BusHub"),
      ]),
      "scripts-1": sc("oa-s-iaaa", "oa-s-provisioner"),
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "live=2 orphan=4",
      "orphan BusHub=2",
      "orphan Other=1",
      "orphan other=1",
      "",
    ]);
    for (const secret of ["oa-s-i", "n1-id", "n3-id", "n8-id", "ird"])
      expect(r.out + r.err).not.toContain(secret);
  });

  it("no orphans: only the counts", () => {
    const r = run({
      "do-1": ok([ns("n1", "oa-s-iaaa", "BusHub")]),
      "scripts-1": sc("oa-s-iaaa"),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("live=1 orphan=0\n");
  });

  it("follows pagination on both lists", () => {
    const r = run({
      "do-1": ok([ns("n1", "oa-s-iaaa", "BusHub")], 2),
      "do-2": ok([ns("n3", "oa-s-ibbb", "BusHub")], 2),
      "scripts-1": ok([{ id: "oa-s-iaaa" }], 2),
      "scripts-2": ok([{ id: "other" }], 2),
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("live=1 orphan=1\norphan BusHub=1\n");
    expect(r.log.filter((l) => l.includes("page=2"))).toHaveLength(2);
  });

  it("stops when an API ignores paging and repeats a full page", () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` }));
    const r = run({
      "do-1": ok([ns("n1", "oa-s-iaaa", "BusHub")]),
      "scripts-1": ok([...full, { id: "oa-s-iaaa" }].slice(1)),
      "scripts-2": ok([...full, { id: "oa-s-iaaa" }].slice(1)),
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("live=1 orphan=0\n");
  });

  it("fails when no live install has a BusHub namespace: the list does not show namespaced scripts", () => {
    for (const files of [
      {
        "do-1": ok([ns("n5", "oa-s-provisioner", "Wf")]),
        "scripts-1": sc("oa-s-iaaa"),
      },
      {
        // BusHub only on an orphan.
        "do-1": ok([ns("n1", "oa-s-ibbb", "BusHub")]),
        "scripts-1": sc("oa-s-iaaa"),
      },
    ]) {
      const r = run(files);
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        "the namespace list does not show namespaced scripts",
      );
      expect(r.err).not.toContain("oa-s-i");
    }
  });

  it.each([
    [
      "a namespace list error",
      { "do-1": ok([]).replace("true", "false") },
      "list Durable Object namespaces failed",
    ],
    ["a network error", { "do-1": "NETERR" }, "network error"],
    [
      "a scripts list error",
      {
        "do-1": ok([ns("n1", "oa-s-iaaa", "BusHub")]),
        "scripts-1": JSON.stringify({
          success: false,
          errors: [{ code: 10000 }],
        }),
      },
      `list ${NS} scripts failed`,
    ],
  ])("fails closed on %s", (_, files, msg) => {
    const r = run(files as Record<string, string>);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(r.out).toBe("");
  });

  it("makes only GET requests, with the token on stdin", () => {
    const r = run({
      "do-1": ok([ns("n1", "oa-s-iaaa", "BusHub")]),
      "scripts-1": sc("oa-s-iaaa"),
    });
    const curls = r.log.filter((l) => l.startsWith("curl "));
    expect(curls).toHaveLength(2);
    for (const l of curls) {
      expect(l).toContain("-K -");
      expect(l).not.toMatch(/ (-X|--request|-d|--data\S*|-F|-T)\b/);
      expect(l).not.toContain("Authorization");
    }
  });

  it("takes no arguments and refuses a malformed namespace", () => {
    const sb = sandbox({ curl });
    const env = {
      CLOUDFLARE_API_TOKEN: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      DISPATCH_NAMESPACE: NS,
    };
    expect(sb.run(["bash", script("do-orphans.sh"), "x"], { env }).code).toBe(
      2,
    );
    expect(
      sb.run(["bash", script("do-orphans.sh")], {
        env: { ...env, DISPATCH_NAMESPACE: "a/b" },
      }).code,
    ).toBe(2);
    expect(sb.log()).toEqual([]);
  });
});
