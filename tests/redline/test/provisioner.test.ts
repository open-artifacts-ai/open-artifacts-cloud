import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN, PLAN_SERIAL } from "../src/lanes.ts";
import { OIDC_FILES } from "../src/oidc.ts";
import {
  createTaken,
  parseProvisionerProbe,
  pollUntil,
  provisionerClient,
  ULID_RE,
} from "../src/provisioner.ts";
import { parseManifest } from "../src/report.ts";
import liveCfg from "../vitest.live.config.ts";

const root = join(import.meta.dirname, "..");
const OK = {
  accountId: "a".repeat(32),
  platformDbId: "0123abcd-4567-89ef-0123-456789abcdef",
  signupsQueueId: "b".repeat(32),
  tokenFile: "/x/token",
  replaySignupId: "01JBQ7Z8X9Y0ABCDEFGHJKMNPQ",
};
const cfg = (v: unknown) => ({ REDLINE_STG_PROVISIONER: JSON.stringify(v) });

describe("the provisioner cases are in the gate", () => {
  const live = readFileSync(join(root, "live/provisioner.test.ts"), "utf8");
  const src = readFileSync(join(root, "src/provisioner.ts"), "utf8");
  const names = [
    "a replayed signup creates nothing new",
    "a signup for a taken slug fails cleanly",
  ];

  it("the live suite runs live/provisioner.test.ts, and the manifest lists both cases once", () => {
    expect(liveCfg.test?.include).toEqual(["live/**/*.test.ts"]);
    const m = parseManifest(
      readFileSync(join(root, "live/manifest.json"), "utf8"),
    );
    for (const n of names) {
      expect(live).toContain(`"${n}"`);
      expect(
        m.cases.filter(
          (c) =>
            c.file === "live/provisioner.test.ts" &&
            c.name === `provisioner > ${n}`,
        ),
      ).toHaveLength(1);
    }
    expect(
      m.cases.filter((c) => c.file === "live/provisioner.test.ts"),
    ).toHaveLength(names.length);
  });

  it("the file sits in exactly one lane of each plan", () => {
    for (const plan of [PLAN, PLAN_SERIAL])
      expect(
        plan.flat().filter((l) => l.files.includes("live/provisioner.test.ts")),
      ).toHaveLength(1);
  });

  it("the taken-slug case goes through R4 and asserts slug_taken with nothing written", () => {
    expect(live).toContain("createTaken(");
    expect(src).toContain("/v1/installs");
    expect(live).toContain('code: "slug_taken"');
    expect(live).toContain("FROM jobs WHERE request_id");
    // The old route: a hand-written signups row. Never again.
    expect(live).not.toContain("INSERT INTO");
    expect(src).not.toContain("INSERT INTO");
  });

  it("with no REDLINE_STG_PROVISIONER the cases are unproven-live, never pass", () => {
    expect(live).toContain('proof(ctx, "unproven-live", NOT_CONFIGURED)');
    expect(live).toContain('proof(ctx, "staging-only"');
  });
});

describe("REDLINE_STG_PROVISIONER", () => {
  it("unset is undefined; a valid one parses", () => {
    expect(parseProvisionerProbe({})).toBeUndefined();
    expect(parseProvisionerProbe(cfg(OK))).toEqual(OK);
  });

  it("refuses a malformed field", () => {
    for (const [k, v] of [
      ["accountId", "A".repeat(32)],
      ["platformDbId", "b".repeat(32)],
      ["signupsQueueId", ""],
      ["tokenFile", 1],
      ["replaySignupId", "01jbq7z8x9y0abcdefghjkmnpq"],
      ["replaySignupId", "81JBQ7Z8X9Y0ABCDEFGHJKMNPQ"],
    ] as const)
      expect(() => parseProvisionerProbe(cfg({ ...OK, [k]: v })), k).toThrow(
        new RegExp(k),
      );
    expect(() =>
      parseProvisionerProbe({ REDLINE_STG_PROVISIONER: "{" }),
    ).toThrow(/not JSON/);
  });
});

describe("the client", () => {
  const TOKEN = "cf-token-secret-value";
  const tokenFile = () => {
    const d = mkdtempSync(join(tmpdir(), "oa-rl-prov-"));
    const f = join(d, "token");
    writeFileSync(f, `${TOKEN}\n`);
    chmodSync(f, 0o600);
    return f;
  };

  it("sends exactly { signupId } to the queue, and D1 one statement with its params", async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      return Response.json({
        success: true,
        result: [{ results: [{ n: 1 }] }],
      });
    }) as unknown as typeof fetch;
    const c = provisionerClient({ ...OK, tokenFile: tokenFile() }, f);
    await c.enqueue(OK.replaySignupId);
    expect(await c.query("SELECT 1 AS n WHERE ?1", [1])).toEqual([{ n: 1 }]);
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${OK.accountId}/queues/${OK.signupsQueueId}/messages`,
        body: { body: { signupId: OK.replaySignupId } },
        auth: `Bearer ${TOKEN}`,
      },
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${OK.accountId}/d1/database/${OK.platformDbId}/query`,
        body: { sql: "SELECT 1 AS n WHERE ?1", params: [1] },
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    await expect(c.enqueue("not-a-ulid")).rejects.toThrow(/not a ULID/);
  });

  it("an error names the call and status, never the token or the body", async () => {
    const f = (async () =>
      new Response(`{"errors":[{"message":"${TOKEN}"}]}`, {
        status: 403,
      })) as unknown as typeof fetch;
    const c = provisionerClient({ ...OK, tokenFile: tokenFile() }, f);
    const e = await c.query("SELECT 1").catch((x: Error) => x);
    expect(String(e)).toMatch(/platform D1 query: Cloudflare answered 403/);
    expect(String(e)).not.toContain(TOKEN);
  });
});

describe("pollUntil", () => {
  it("stops when done holds, else at the bound with the last value", async () => {
    let t = 0;
    let n = 0;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const read = async () => ++n;
    expect(
      await pollUntil(
        read,
        (v) => v === 3,
        60_000,
        5_000,
        sleep,
        () => t,
      ),
    ).toEqual({ value: 3, met: true });
    t = 0;
    n = 0;
    expect(
      await pollUntil(
        read,
        () => false,
        20_000,
        5_000,
        sleep,
        () => t,
      ),
    ).toEqual({ value: 5, met: false });
  });
});

describe("createTaken", () => {
  const jwt = () => {
    const b = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b({ alg: "none" })}.${b({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-taken-"));
    const f = join(dir, OIDC_FILES.provisioning);
    writeFileSync(f, jwt());
    chmodSync(f, 0o600);
    return { REDLINE_TARGETS: JSON.stringify({ secretsDir: dir }) };
  };
  const body = {
    requestId: "rl1-1-taken0000",
    slug: "rl-a",
    ownerEmail: "x@oa-redline-a.fyi",
  };

  it("POSTs R4 with the OIDC bearer and returns the status and error code", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify({ error: { code: "slug_taken", message: "m" } }),
        { status: 409 },
      );
    }) as unknown as typeof fetch;
    const r = await createTaken(setup(), body, f);
    expect(r).toMatchObject({ status: 409, code: "slug_taken" });
    expect(seen[0]?.url).toBe(
      "https://api.open-artifacts-staging.app/v1/installs",
    );
    expect(seen[0]?.init.method).toBe("POST");
    expect(
      (seen[0]?.init.headers as Record<string, string>).authorization,
    ).toMatch(/^Bearer ey/);
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      slug: "rl-a",
      requestId: body.requestId,
    });
  });

  it("a 202 is not slug_taken, and a string error code reads too", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ job: {} }), {
        status: 202,
      })) as unknown as typeof fetch;
    expect(await createTaken(setup(), body, ok)).toMatchObject({
      status: 202,
      code: undefined,
    });
    const str = (async () =>
      new Response(JSON.stringify({ error: "slug_taken" }), {
        status: 409,
      })) as unknown as typeof fetch;
    expect((await createTaken(setup(), body, str)).code).toBe("slug_taken");
  });

  it("refuses without secretsDir or with a non-origin api", async () => {
    await expect(createTaken({}, body)).rejects.toThrow(/secretsDir/);
    await expect(
      createTaken({ ...setup(), REDLINE_PROV_API: "http://x" }, body),
    ).rejects.toThrow(/bare https origin/);
  });
});
