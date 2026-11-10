import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// hosted-zones.sh: plan reads only and lists each change; apply makes exactly
// those; a different `*` record or route stops both. Tokens reach curl on stdin.
const SCRIPT = join(root, "scripts/ops/hosted-zones.sh");
const TOK = "cf-token-SHOULD-NEVER-APPEAR";
const APPZ = "a".repeat(32);
const PAGEZ = "b".repeat(32);

// curl: every call must carry the one token (CLOUDFLARE_API_TOKEN) on stdin.
// State: $STATE/wild-<zone>.json, setting-<zone>-<k>.json, routes-<zone>.json,
// workers (names that exist); writes are logged as "WRITE <method> <path> <body>"
// and land in the state, unless $DROP names the kind (dns, setting, route):
// then the API says success and nothing changes.
const curl = `
cfg="$(cat)"
tok=""; case "$cfg" in *"$TOK_EXPECT"*) tok=ok ;; esac
m=GET; body=""
for ((i = 1; i <= $#; i++)); do
  [ "\${!i}" = -X ] && { j=$((i + 1)); m="\${!j}"; }
  [ "\${!i}" = -d ] && { j=$((i + 1)); body="\${!j}"; }
done
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
[ "$m" = GET ] || echo "WRITE $m $path $body" >> "$STUB_LOG"
ok() { printf '{"success":true,"result":%s}' "$1"; }
case "$path" in
  /accounts/*/workers/scripts/*/settings)
    w="\${path#*/workers/scripts/}"; w="\${w%%/*}"
    # Like Cloudflare: 10007 is "not found"; any other failure is another code.
    if [ "$tok" != ok ]; then echo '{"success":false,"errors":[{"code":10000}]}'
    elif [ -f "$STATE/neterr-$w" ]; then echo "curl: (6) Could not resolve host" >&2; exit 6
    elif [ -f "$STATE/fail-$w" ]; then echo '{"success":false,"errors":[{"code":10001,"message":"boom"}]}'
    elif grep -qx "$w" "$STATE/workers"; then ok '{}'
    else echo '{"success":false,"errors":[{"code":10007,"message":"not found"}]}'; fi ;;
  /user/tokens/verify) [ "$tok" = ok ] && ok '{"status":"active"}' || echo '{"success":false}' ;;
  "/zones?name="*)
    [ "$tok" = ok ] || { echo '{"success":false}'; exit 0; }
    q="\${path#*name=}"; n="\${q%%&*}"
    # Only the account-scoped lookup answers; ZONE_OWNER fakes another account's zone.
    case "$q" in *"&account.id=$STUB_ACCT") ;; *) echo '{"success":false}'; exit 0 ;; esac
    case "$n" in *.page) id="$PAGEZ" ;; *) id="$APPZ" ;; esac
    ok "[{\\"id\\":\\"$id\\",\\"name\\":\\"$n\\",\\"account\\":{\\"id\\":\\"\${ZONE_OWNER:-$STUB_ACCT}\\"}}]" ;;
  /zones/*/dns_records\\?name=*)
    z="\${path#/zones/}"; z="\${z%%/*}"; ok "$(cat "$STATE/wild-$z.json" 2>/dev/null || echo '[]')" ;;
  /zones/*/dns_records)
    z="\${path#/zones/}"; z="\${z%%/*}"
    [ "$DROP" = dns ] || echo '[{"type":"AAAA","content":"100::","proxied":true}]' > "$STATE/wild-$z.json"
    ok '{}' ;;
  /zones/*/settings/*)
    z="\${path#/zones/}"; z="\${z%%/*}"; k="\${path##*/}"
    if [ "$m" = PATCH ]; then v="\${body#*:}"; v="\${v%\\}}"
      [ "$DROP" = setting ] || printf '%s' "$v" > "$STATE/setting-$z-$k.json"; ok "{\\"value\\":$v}"
    else ok "{\\"value\\":$(cat "$STATE/setting-$z-$k.json" 2>/dev/null || echo '"off"')}"; fi ;;
  /zones/*/workers/routes)
    z="\${path#/zones/}"; z="\${z%%/*}"
    f="$STATE/routes-$z.json"
    if [ "$m" = POST ]; then
      [ "$DROP" = route ] || { [ -f "$f" ] || echo '[]' > "$f"; jq -c --argjson r "$body" '. + [$r]' "$f" > "$f.new" && mv "$f.new" "$f"; }
      ok '{}'
    else ok "$(cat "$f" 2>/dev/null || echo '[]')"; fi ;;
  *) echo '{"success":false,"errors":[{"message":"unexpected path"}]}' ;;
esac`;

const WILD = '[{"type":"AAAA","content":"100::","proxied":true}]';
const DONE: Record<string, string> = {
  [`wild-${APPZ}.json`]: WILD,
  [`wild-${PAGEZ}.json`]: WILD,
  [`routes-${APPZ}.json`]: JSON.stringify([
    { pattern: "auth.open-artifacts.app/*", script: "oa-p-auth-broker" },
    {
      pattern: "directory.open-artifacts.app/*",
      script: "oa-p-directory-broker",
    },
    { pattern: "*.open-artifacts.app/*", script: "oa-p-dispatch" },
    { pattern: "admin.open-artifacts.app/*", script: "oa-p-provisioning" },
    { pattern: "api.open-artifacts.app/*", script: "oa-p-provisioning" },
  ]),
  [`routes-${PAGEZ}.json`]: JSON.stringify([
    { pattern: "*.open-artifacts.page/*", script: "oa-p-dispatch" },
  ]),
};
for (const z of [APPZ, PAGEZ]) {
  DONE[`setting-${z}-ssl.json`] = '"strict"';
  DONE[`setting-${z}-always_use_https.json`] = '"on"';
  DONE[`setting-${z}-min_tls_version.json`] = '"1.2"';
}

const setup = (
  files: Record<string, string> = {},
  workers = [
    "oa-p-dispatch",
    "oa-p-auth-broker",
    "oa-p-directory-broker",
    "oa-p-provisioning",
  ],
) => {
  const sb = sandbox({ curl });
  const state = join(sb.dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "workers"), `${workers.join("\n")}\n`);
  for (const [f, v] of Object.entries(files)) writeFileSync(join(state, f), v);
  const summary = join(sb.dir, "summary.md");
  writeFileSync(summary, "");
  const run = (
    mode: string,
    env = "prod",
    extra: Record<string, string> = {},
  ) => {
    const r = sb.run(["bash", SCRIPT, env, mode], {
      env: {
        STATE: state,
        CLOUDFLARE_API_TOKEN: TOK,
        TOK_EXPECT: TOK,
        CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
        STUB_ACCT: "26ac346086d4405f7a976d48747a2a75",
        APPZ,
        PAGEZ,
        GITHUB_STEP_SUMMARY: summary,
        DROP: "",
        ...extra,
      },
    });
    const log = sb.log();
    return {
      ...r,
      log,
      writes: log.filter((l) => l.startsWith("WRITE")),
      summary: readFileSync(summary, "utf8"),
    };
  };
  return { run };
};
const clean = (r: {
  out: string;
  err: string;
  log: string[];
  summary: string;
}) => {
  expect([r.out, r.err, r.summary, ...r.log].join("\n")).not.toContain(TOK);
};

describe("hosted-zones.sh", () => {
  it("plan on fresh zones lists every change, writes nothing, and fills the summary", () => {
    const r = setup().run("plan");
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    for (const line of [
      "open-artifacts.app: create AAAA * -> 100:: (proxied)",
      'open-artifacts.page: set ssl "off" -> "strict"',
      "route *.open-artifacts.page/* -> oa-p-dispatch: add",
      "route auth.open-artifacts.app/* -> oa-p-auth-broker: add",
      "route admin.open-artifacts.app/* -> oa-p-provisioning: add",
      "route api.open-artifacts.app/* -> oa-p-provisioning: add",
      "plan only: nothing changed",
    ]) {
      expect(r.out).toContain(line);
      expect(r.summary).toContain(line);
    }
    // Prod keeps signup.<app> on dispatch (#40: the route is staging only).
    expect(r.out).not.toContain("signup.");
    clean(r);
  });
  it("apply makes exactly the planned writes: 2 records, 6 settings, 6 routes", () => {
    const r = setup().run("apply");
    expect(r.code).toBe(0);
    expect(r.writes.filter((w) => w.includes("/dns_records "))).toHaveLength(2);
    expect(
      r.writes.filter(
        (w) => w.startsWith("WRITE PATCH") && w.includes("/settings/"),
      ),
    ).toHaveLength(6);
    expect(r.writes.filter((w) => w.includes("/workers/routes "))).toHaveLength(
      6,
    );
    expect(r.writes.join("\n")).toContain(
      '{"type":"AAAA","name":"*","content":"100::","proxied":true}',
    );
    expect(r.out).toContain("applied and read back: matches the expected set");
    expect(r.summary).toContain("applied and read back");
    clean(r);
  });
  it("apply fails when the read-back differs from what the API said it did", () => {
    for (const drop of ["dns", "setting", "route"]) {
      const r = setup().run("apply", "prod", { DROP: drop });
      expect(r.code, drop).toBe(1);
      expect(r.err, drop).toContain("after apply, still not as expected");
      expect(r.out, drop).not.toContain("applied and read back");
    }
  });
  it("refuses a foreign route our patterns match, before any write, in both modes", () => {
    const routes = JSON.parse(DONE[`routes-${APPZ}.json`] as string);
    for (const mode of ["plan", "apply"]) {
      const r = setup({
        [`routes-${APPZ}.json`]: JSON.stringify([
          ...routes,
          { pattern: "x.open-artifacts.app/*", script: "someone-else" },
        ]),
      }).run(mode);
      expect(r.code, mode).toBe(1);
      expect(r.err).toContain(
        "route x.open-artifacts.app/* is not ours but matches *.open-artifacts.app/*",
      );
      expect(r.writes, mode).toEqual([]);
    }
  });
  it("leaves alone a foreign route our patterns don't match", () => {
    const r = setup({
      ...DONE,
      [`routes-${APPZ}.json`]: JSON.stringify([
        ...JSON.parse(DONE[`routes-${APPZ}.json`] as string),
        { pattern: "open-artifacts.app/robots.txt", script: "someone-else" },
      ]),
    }).run("apply");
    expect(r.code, r.err).toBe(0);
    expect(r.writes).toEqual([]);
  });
  it("on wired zones both modes report ok and write nothing", () => {
    for (const mode of ["plan", "apply"]) {
      const r = setup(DONE).run(mode);
      expect(r.code, mode).toBe(0);
      expect(r.writes, mode).toEqual([]);
      expect(r.out).not.toMatch(/: (create|set|add)\b/);
    }
  });
  it("refuses a different * record or a route on another Worker, before writing either", () => {
    for (const [f, v] of [
      [
        `wild-${APPZ}.json`,
        '[{"type":"A","content":"192.0.2.1","proxied":true}]',
      ],
      [
        `routes-${PAGEZ}.json`,
        JSON.stringify([
          { pattern: "*.open-artifacts.page/*", script: "someone-else" },
        ]),
      ],
    ] as const) {
      for (const base of [DONE, {}]) {
        const r = setup({ ...base, [f]: v }).run("apply");
        expect(r.code, f).toBe(1);
        expect(r.writes, f).toEqual([]);
      }
    }
  });
  it("refuses until the target Workers exist, and on a bad env or mode", () => {
    const r = setup({}, ["oa-p-dispatch"]).run("apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("oa-p-auth-broker does not exist");
    expect(r.writes).toEqual([]);
    // The provisioning Worker too: its two routes need it.
    const np = setup({}, [
      "oa-p-dispatch",
      "oa-p-auth-broker",
      "oa-p-directory-broker",
    ]).run("plan");
    expect(np.code).toBe(1);
    expect(np.err).toContain("oa-p-provisioning does not exist");
    expect(setup().run("plan", "dev").code).toBe(2);
    expect(setup().run("destroy").code).toBe(2);
  });
  it("finds each zone on the hosted account only, refusing a same-named zone elsewhere", () => {
    const r = setup().run("plan", "prod", { ZONE_OWNER: "f".repeat(32) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not found \(or not unique\)/);
    expect(r.writes).toEqual([]);
    clean(r);
  });

  it("staging uses the staging zones and oa-s Workers", () => {
    const r = setup({}, [
      "oa-s-dispatch",
      "oa-s-auth-broker",
      "oa-s-directory-broker",
      "oa-s-provisioning",
    ]).run("plan", "staging");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "route auth.open-artifacts-staging.app/* -> oa-s-auth-broker: add",
    );
    expect(r.out).toContain(
      "route *.open-artifacts-staging.page/* -> oa-s-dispatch: add",
    );
    expect(r.out).toContain(
      "route admin.open-artifacts-staging.app/* -> oa-s-provisioning: add",
    );
    expect(r.out).toContain(
      "route api.open-artifacts-staging.app/* -> oa-s-provisioning: add",
    );
    expect(r.out).toContain(
      "route signup.open-artifacts-staging.app/* -> oa-s-provisioning: add",
    );
  });

  describe("billing's webhook route (staging only, state-based, #1568)", () => {
    const BASE = [
      "oa-s-dispatch",
      "oa-s-auth-broker",
      "oa-s-directory-broker",
      "oa-s-provisioning",
    ];
    const STG = [...BASE, "oa-s-billing"];
    const ROUTE = "billing.open-artifacts-staging.app/stripe/webhook";
    const billingLookups = (log: string[]) =>
      log.filter((l) => l.includes("/workers/scripts/oa-s-billing/settings"));

    it("oa-s-billing exists: plan and apply carry exactly one more route, an exact path to it", () => {
      const plan = setup({}, STG).run("plan", "staging");
      expect(plan.code, plan.err).toBe(0);
      expect(plan.out).toContain(`route ${ROUTE} -> oa-s-billing: add`);
      expect(plan.writes).toEqual([]);
      const apply = setup({}, STG).run("apply", "staging");
      expect(apply.code, apply.err).toBe(0);
      const routes = apply.writes.filter((w) => w.includes("/workers/routes "));
      expect(routes).toHaveLength(8);
      expect(routes.filter((w) => w.includes("billing"))).toEqual([
        `WRITE POST /zones/${APPZ}/workers/routes {"pattern":"${ROUTE}","script":"oa-s-billing"}`,
      ]);
      expect(
        apply.writes.filter((w) => w.includes("/dns_records ")),
      ).toHaveLength(2);
      expect(apply.out).toContain(
        "applied and read back: matches the expected set",
      );
    });

    it("oa-s-billing does not exist: the route is left out, the plan and summary say so, and the run does not refuse", () => {
      for (const mode of ["plan", "apply"]) {
        const r = setup({}, BASE).run(mode, "staging");
        expect(r.code, `${mode} ${r.err}`).toBe(0);
        const line =
          "oa-s-billing does not exist yet: its webhook route (billing.open-artifacts-staging.app/stripe/webhook) is left out";
        expect(r.out, mode).toContain(line);
        expect(r.summary, mode).toContain(line);
        expect(r.out).not.toContain("-> oa-s-billing");
        expect(
          r.writes.filter((w) => w.includes("billing")),
          mode,
        ).toEqual([]);
        if (mode === "apply")
          expect(
            r.writes.filter((w) => w.includes("/workers/routes ")),
          ).toHaveLength(7);
      }
    });

    it("a later run keeps the route: with the Worker up and the route live both modes write nothing, and it is not seen as foreign", () => {
      const wired = {
        ...DONE,
        [`routes-${APPZ}.json`]: JSON.stringify([
          ...JSON.parse(DONE[`routes-${APPZ}.json`] as string).map(
            (r: { pattern: string; script: string }) => ({
              pattern: r.pattern.replace(
                "open-artifacts.app",
                "open-artifacts-staging.app",
              ),
              script: r.script.replace("oa-p-", "oa-s-"),
            }),
          ),
          {
            pattern: "signup.open-artifacts-staging.app/*",
            script: "oa-s-provisioning",
          },
          { pattern: ROUTE, script: "oa-s-billing" },
        ]),
        [`routes-${PAGEZ}.json`]: JSON.stringify([
          {
            pattern: "*.open-artifacts-staging.page/*",
            script: "oa-s-dispatch",
          },
        ]),
      };
      for (const mode of ["plan", "apply"]) {
        const r = setup(wired, STG).run(mode, "staging");
        expect(r.code, `${mode} ${r.err}`).toBe(0);
        expect(r.out).toContain(`route ${ROUTE} -> oa-s-billing ok`);
        expect(
          r.writes.filter((w) => w.includes("/workers/routes ")),
          mode,
        ).toEqual([]);
      }
      // The Worker gone but its route still live: that route is a foreign one
      // our wildcard matches, so the run refuses rather than hiding it.
      const gone = setup(wired, BASE).run("plan", "staging");
      expect(gone.code).toBe(1);
      expect(gone.err).toContain(
        `route ${ROUTE} is not ours but matches *.open-artifacts-staging.app/*`,
      );
    });

    it("a lookup that fails is not 'does not exist': another API error, a network error or an unparsable answer fails the run, writing nothing", () => {
      for (const mode of ["plan", "apply"]) {
        for (const [why, file] of [
          ["api error", "fail-oa-s-billing"],
          ["network error", "neterr-oa-s-billing"],
        ] as const) {
          const r = setup({ [file]: "" }, BASE).run(mode, "staging");
          expect(r.code, `${mode} ${why}`).toBe(1);
          expect(r.err, why).toContain("look up oa-s-billing failed");
          expect(r.writes, why).toEqual([]);
          expect(r.out, why).not.toContain("left out");
        }
      }
    });

    it("prod never looks: no lookup of oa-p-billing, no billing route, even if that Worker exists", () => {
      for (const workers of [
        undefined,
        [
          "oa-p-dispatch",
          "oa-p-auth-broker",
          "oa-p-directory-broker",
          "oa-p-provisioning",
          "oa-p-billing",
        ],
      ]) {
        const r = setup({}, workers).run("apply", "prod");
        expect(r.code, r.err).toBe(0);
        expect(r.log.filter((l) => l.includes("billing"))).toEqual([]);
        expect(r.out).not.toContain("billing");
        expect(
          r.writes.filter((w) => w.includes("/workers/routes ")),
        ).toHaveLength(6);
      }
    });

    it("a billing route that already points at another Worker is refused, in plan and apply", () => {
      for (const mode of ["plan", "apply"]) {
        const r = setup(
          {
            [`routes-${APPZ}.json`]: JSON.stringify([
              { pattern: ROUTE, script: "someone-else" },
            ]),
          },
          STG,
        ).run(mode, "staging");
        expect(r.code, mode).toBe(1);
        expect(r.err).toContain(
          `route ${ROUTE} points at someone-else, not oa-s-billing`,
        );
        expect(r.writes, mode).toEqual([]);
      }
    });

    it("a foreign route on the billing host is refused like any our patterns match, before any write", () => {
      for (const mode of ["plan", "apply"]) {
        const r = setup(
          {
            [`routes-${APPZ}.json`]: JSON.stringify([
              {
                pattern: "billing.open-artifacts-staging.app/stripe/*",
                script: "x",
              },
            ]),
          },
          STG,
        ).run(mode, "staging");
        expect(r.code, mode).toBe(1);
        expect(r.err).toContain(
          "route billing.open-artifacts-staging.app/stripe/* is not ours but matches *.open-artifacts-staging.app/*",
        );
        expect(r.writes, mode).toEqual([]);
      }
    });
  });
});
