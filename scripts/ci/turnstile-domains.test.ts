// turnstile-domains.sh: a read-only check that the env's one Turnstile widget
// covers the sign-up host. Prints only name, mode and domains.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const TOK = "cfut_TS_token_never_printed_0123";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const SECRET = "0xSECRET_never_printed_secret_value";
const SITEKEY = "0xSITEKEY_never_printed";
const curl = `cfg=""
for ((i = 1; i <= $#; i++)); do
  if [ "\${!i}" = -K ]; then j=$((i + 1)); cfg="$(cat "\${!j}")"; fi
done
echo "url: \${@: -1}" >> "$STUB_LOG"
echo "cfg: $cfg" >> "$STUB_LOG"
case "$cfg" in *"Authorization: Bearer $TOK_EXPECT"*) ;; *) printf '{"success":false}\\n401'; exit 0 ;; esac
cat "$STATE/widgets"`;
const widget = (name: string, domains: string[], mode = "managed") => ({
  name,
  mode,
  domains,
  secret: SECRET,
  sitekey: SITEKEY,
  region: "world",
});
const list = (ws: unknown[]) =>
  `${JSON.stringify({ success: true, result: ws })}\n200`;

describe("turnstile-domains.sh", () => {
  const run = (
    env: "prod" | "staging",
    answer: string,
    opts: { curl?: string; zone?: string } = {},
  ) => {
    const sb = sandbox({ curl: opts.curl ?? curl });
    writeFileSync(join(sb.dir, "widgets"), answer);
    const hosted = join(sb.dir, "hosted");
    sb.run(["mkdir", hosted]);
    writeFileSync(
      join(hosted, `${env}.json`),
      JSON.stringify({
        account_id: ACCT,
        app_zone:
          opts.zone ??
          (env === "prod"
            ? "open-artifacts.app"
            : "open-artifacts-staging.app"),
      }),
    );
    const r = sb.run(["bash", script("turnstile-domains.sh"), env], {
      env: { STATE: sb.dir, TOKEN: TOK, TOK_EXPECT: TOK, HOSTED_DIR: hosted },
    });
    const all = [r.out, r.err, ...sb.log()].join("\n");
    for (const s of [SECRET, SITEKEY]) expect(all).not.toContain(s);
    expect(r.out + r.err).not.toContain(TOK);
    for (const l of sb.log().filter((x) => x.startsWith("curl ")))
      expect(l).not.toContain(TOK);
    return { ...r, log: sb.log() };
  };

  it("prod: prints name, mode and domains of the one oa-p-turnstile widget, GET only", () => {
    const r = run(
      "prod",
      list([
        widget("oa-s-turnstile", ["open-artifacts-staging.app"]),
        widget("oa-p-turnstile", ["open-artifacts.app"]),
      ]),
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      "name=oa-p-turnstile mode=managed domains=open-artifacts.app\n",
    );
    expect(
      r.log.some((l) =>
        l.endsWith(`/accounts/${ACCT}/challenges/widgets?per_page=100`),
      ),
    ).toBe(true);
    const bad =
      /(^|\s)(-X|--request|-d|--data[a-z-]*|-F|--form[a-z-]*|-T|--upload-file|--json)(\s|=|$)/;
    for (const l of r.log.filter((x) => x.startsWith("curl ")))
      expect(l).not.toMatch(bad);
  });

  it("passes on signup.<app domain> alone", () => {
    const r = run(
      "prod",
      list([widget("oa-p-turnstile", ["signup.open-artifacts.app"])]),
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      "name=oa-p-turnstile mode=managed domains=signup.open-artifacts.app\n",
    );
  });

  it("staging checks oa-s-turnstile against the staging app domain", () => {
    const ok = run(
      "staging",
      list([
        widget("oa-s-turnstile", ["open-artifacts-staging.app"], "invisible"),
      ]),
    );
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toBe(
      "name=oa-s-turnstile mode=invisible domains=open-artifacts-staging.app\n",
    );
    const wrong = run(
      "staging",
      list([widget("oa-s-turnstile", ["open-artifacts.app"])]),
    );
    expect(wrong.code).toBe(1);
  });

  it("fails when no widget has the name, or two do, printing no widget", () => {
    const none = run(
      "prod",
      list([widget("oa-s-turnstile", ["open-artifacts.app"])]),
    );
    expect(none.code).toBe(1);
    expect(none.out).toBe("");
    expect(none.err).toContain("found 0");
    const two = run(
      "prod",
      list([
        widget("oa-p-turnstile", ["open-artifacts.app"]),
        widget("oa-p-turnstile", ["open-artifacts.app"]),
      ]),
    );
    expect(two.code).toBe(1);
    expect(two.out).toBe("");
    expect(two.err).toContain("found 2");
  });

  it("fails when the domains cover neither the app domain nor signup.<app domain>", () => {
    const r = run(
      "prod",
      list([widget("oa-p-turnstile", ["example.com", "other.app"])]),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "does not cover open-artifacts.app or signup.open-artifacts.app",
    );
  });

  it("fails closed on an auth error or a curl failure, never echoing the body", () => {
    const a = run("prod", '{"success":false,"errors":[{"code":10000}]}\n403');
    expect(a.code).toBe(1);
    expect(a.err).toContain("http=403");
    const c = run("prod", "", { curl: "exit 28" });
    expect(c.code).toBe(1);
    expect(c.err).toContain("http=000");
  });

  it("refuses an unknown env or a bad zone", () => {
    const sb = sandbox({ curl });
    expect(sb.run(["bash", script("turnstile-domains.sh"), "dev"]).code).toBe(
      2,
    );
    const r = run("prod", list([]), { zone: "x y" });
    expect(r.code).toBe(1);
  });
});
