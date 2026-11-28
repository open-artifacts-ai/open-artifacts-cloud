import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify as verifyBytes,
} from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  busNames,
  cleanupFixture,
  type Deps,
  fixtureRequest,
  HELP,
  hookKeyOnlyOf,
  main,
  parseBusLoginApproval,
  parseCreateLog,
  parseDeleteLog,
  parsePartialCreateLog,
  SEAL_INFO,
  startFixtureBus,
  stopFixtureBus,
  WORKFLOW,
} from "./staging-test-install.ts";

const root = join(import.meta.dirname, "../..");
const wfText = readFileSync(join(root, ".github/workflows", WORKFLOW), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
const w: any = parse(wfText);
const job = w.jobs.fixture;
const step = job.steps[0];
const run = step.run as string;

function sealFor(pubB64u: string, plaintext: string): string {
  const ep = generateKeyPairSync("x25519");
  const epkB64u = ep.publicKey.export({ format: "jwk" }).x as string;
  const shared = diffieHellman({
    privateKey: ep.privateKey,
    publicKey: createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: pubB64u },
      format: "jwk",
    }),
  });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([
        Buffer.from(epkB64u, "base64url"),
        Buffer.from(pubB64u, "base64url"),
      ]),
      SEAL_INFO,
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `oa-seal-v1.${epkB64u}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

describe("staging-test-install.yml", () => {
  it("is dispatch only, in redline-staging, with id-token on the job only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "action",
      "slug",
      "version",
      "owner_key",
      "recipient_key",
      "install_id",
      "delete_proof",
      "request_id",
    ]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("redline-staging");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.steps).toHaveLength(1);
    expect(w.concurrency).toEqual({
      group: `staging-test-install-${"$"}{{ inputs.slug }}`,
      "cancel-in-progress": false,
    });
  });

  it("reads no secrets, checks out nothing, passes inputs via env, and targets staging only", () => {
    expect(wfText).not.toMatch(/\$\{\{\s*secrets\./);
    expect(wfText).not.toContain("actions/checkout");
    expect(run).not.toContain("${{");
    expect(step.env.AUDIENCE).toBe("https://api.open-artifacts-staging.app");
    expect(step.env.TEST_DOMAIN).toBe("oa-redline-a.fyi");
    expect(run).not.toMatch(/Authorization: Bearer \$jwt/);
    expect(run).toContain("hookKeyOnly: true");
    expect(run).toContain("x-oa-fixture-owner-key");
    expect(run).toContain("x-oa-fixture-delete-proof");
    expect(run).not.toContain("x-oa-fixture-install-id");
    expect(run).toContain("#504");
    expect(run).toContain("?wait=");
    expect(run).not.toMatch(/\bsleep\b/);
  });

  it("probes R15 held reads (#504) before creating and uses ?wait=25000 with zero sleeps", () => {
    const bin = mkdtempSync(join(tmpdir(), "oa-ti-held-"));
    try {
      const pauseLog = join(bin, "pauses");
      const reqLog = join(bin, "reqs");
      const createPollCount = join(bin, "create-reads");
      const probeMode = join(bin, "probe-mode");
      writeFileSync(
        join(bin, "sleep"),
        `#!/bin/sh\necho "$1" >> "${pauseLog}"\nexit 0\n`,
      );
      chmodSync(join(bin, "sleep"), 0o755);
      writeFileSync(
        join(bin, "curl"),
        `#!/bin/bash
out=""
write_code=0
url=""
method="GET"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write_code=1; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H|--data|-K|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *"fake.invalid"* ]]; then
  printf '{"value":"fake-jwt"}'
  exit 0
fi
echo "$method $url" >> "${reqLog}"
case "$method $url" in
  "GET https://api.open-artifacts-staging.app/v1/jobs/01000000000000000000000000?wait=invalid")
    if [ "$(cat "${probeMode}")" = "unsupported" ]; then
      printf '{"error":{"code":"not_found"}}' > "$out"
      code=404
    else
      printf '{"error":{"code":"invalid_input","details":{"fields":["query.wait"]}}}' > "$out"
      code=400
    fi
    ;;
  "POST https://api.open-artifacts-staging.app/v1/installs")
    printf '{"job":{"id":"job-create-1","installId":"iabcdefgh234"}}' > "$out"
    code=202
    ;;
  "GET https://api.open-artifacts-staging.app/v1/jobs/job-create-1?wait="*)
    n=0
    [ -f "${createPollCount}" ] && n="$(cat "${createPollCount}")"
    n=$((n + 1))
    printf '%s' "$n" > "${createPollCount}"
    if [ "$n" -eq 1 ]; then
      printf '{"id":"job-create-1","status":"running"}' > "$out"
    else
      printf '{"id":"job-create-1","status":"done"}' > "$out"
    fi
    code=200
    ;;
  "GET https://api.open-artifacts-staging.app/v1/installs/iabcdefgh234")
    printf '{"id":"iabcdefgh234","slug":"t-abc","appHost":"t-abc.open-artifacts-staging.app","testHooks":true,"state":"active","version":"0.272.1"}' > "$out"
    code=200
    ;;
  "POST https://api.open-artifacts-staging.app/v1/installs/iabcdefgh234/redline-creds")
    printf '{"job":{"id":"job-creds-1"}}' > "$out"
    code=202
    ;;
  "GET https://api.open-artifacts-staging.app/v1/jobs/job-creds-1?wait="*)
    printf '{"id":"job-creds-1","status":"done","sealed":"oa-seal-v1.abc.def.ghi"}' > "$out"
    code=200
    ;;
  *)
    echo "unexpected $method $url" >&2
    exit 99
    ;;
esac
[ "$write_code" = 1 ] && printf '%s' "$code"
`,
      );
      chmodSync(join(bin, "curl"), 0o755);
      const baseEnv = {
        PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://fake.invalid/?x=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-request-token",
        ...step.env,
        REF: "refs/heads/main",
        ACTION: "create",
        SLUG: "t-abc",
        VERSION: "",
        OWNER_KEY: `${"B".repeat(42)}A`,
        RECIPIENT_KEY: `${"A".repeat(42)}A`,
        INSTALL_ID: "",
        DELETE_PROOF: "",
        REQUEST_ID: "",
        REPOSITORY_ID: "4242",
        RUN_ID: "1",
        RUN_ATTEMPT: "1",
      };

      // Refuses before R4 when staging provisioning lacks #504 held reads.
      writeFileSync(probeMode, "unsupported");
      const unsupported = spawnSync("bash", ["-c", run], {
        env: baseEnv,
        encoding: "utf8",
      });
      expect(unsupported.status).toBe(1);
      expect(unsupported.stdout).toContain("#504");
      expect(readFileSync(reqLog, "utf8")).not.toContain("/v1/installs");

      // With #504 live: holds on ?wait=25000, re-sends on unfinished, zero sleeps.
      rmSync(reqLog, { force: true });
      writeFileSync(probeMode, "supported");
      const res = spawnSync("bash", ["-c", run], {
        env: baseEnv,
        encoding: "utf8",
      });
      expect(res.status, res.stderr || res.stdout).toBe(0);
      expect(existsSync(pauseLog)).toBe(false);
      const reqs = readFileSync(reqLog, "utf8");
      expect(reqs).toContain(
        "GET https://api.open-artifacts-staging.app/v1/jobs/job-create-1?wait=25000",
      );
      expect(reqs).toContain(
        "GET https://api.open-artifacts-staging.app/v1/jobs/job-creds-1?wait=25000",
      );
      expect(parseCreateLog(res.stdout, "t-abc")).toEqual({
        installId: "iabcdefgh234",
        repositoryId: "4242",
        slug: "t-abc",
        host: "t-abc.open-artifacts-staging.app",
        version: "0.272.1",
        createJob: "job-create-1",
        credsJob: "job-creds-1",
        sealed: "oa-seal-v1.abc.def.ghi",
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  describe("workflow guards refuse invalid inputs before any network call", () => {
    let bin: string;
    const validProof = `iabcdefgh234.1700000000000.${"A".repeat(85)}A`;
    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), "oa-ti-wf-"));
      writeFileSync(
        join(bin, "curl"),
        `#!/bin/sh\ntouch "${bin}/reached"\nexit 99\n`,
      );
      chmodSync(join(bin, "curl"), 0o755);
    });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));

    const sh = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", run], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://fake.invalid/?x=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-request-token",
          ...step.env,
          REF: "refs/heads/main",
          ACTION: "create",
          SLUG: "t-abc",
          VERSION: "",
          OWNER_KEY: `${"B".repeat(42)}A`,
          RECIPIENT_KEY: `${"A".repeat(42)}A`,
          INSTALL_ID: "",
          DELETE_PROOF: "",
          REQUEST_ID: "",
          REPOSITORY_ID: "4242",
          RUN_ID: "1",
          RUN_ATTEMPT: "1",
          ...env,
        },
        encoding: "utf8",
      });

    it("refuses non-main refs, non-t- slugs, bad keys, bad versions, and missing/mismatched delete proof", () => {
      expect(sh({ REF: "refs/heads/feature" }).status).toBe(1);
      expect(sh({ SLUG: "rl-agents" }).status).toBe(1);
      expect(sh({ SLUG: "customer1" }).status).toBe(1);
      expect(sh({ OWNER_KEY: "bad" }).status).toBe(1);
      expect(sh({ RECIPIENT_KEY: "bad" }).status).toBe(1);
      expect(sh({ VERSION: "v0.1.2" }).status).toBe(1);
      expect(sh({ INSTALL_ID: "iabcdefgh234" }).status).toBe(1);
      expect(sh({ DELETE_PROOF: validProof }).status).toBe(1);
      expect(
        sh({
          ACTION: "delete",
          RECIPIENT_KEY: "",
          INSTALL_ID: "",
          DELETE_PROOF: validProof,
        }).status,
      ).toBe(1);
      expect(
        sh({
          ACTION: "delete",
          RECIPIENT_KEY: "",
          INSTALL_ID: "iabcdefgh234",
          DELETE_PROOF: "",
        }).status,
      ).toBe(1);
      expect(
        sh({
          ACTION: "delete",
          RECIPIENT_KEY: "",
          INSTALL_ID: "iabcdefgh235",
          DELETE_PROOF: validProof,
        }).status,
      ).toBe(1);
      expect(existsSync(join(bin, "reached"))).toBe(false);
    });

    it("reaches the network on valid main create and delete inputs", () => {
      expect(sh({}).status).not.toBe(0);
      expect(existsSync(join(bin, "reached"))).toBe(true);
      rmSync(join(bin, "reached"), { force: true });
      expect(
        sh({
          ACTION: "delete",
          RECIPIENT_KEY: "",
          INSTALL_ID: "iabcdefgh234",
          DELETE_PROOF: validProof,
        }).status,
      ).not.toBe(0);
      expect(existsSync(join(bin, "reached"))).toBe(true);
    });
  });
});

describe("fixtureRequest", () => {
  it("passes the exact version to staging and enables Docker only when requested", () => {
    expect(
      fixtureRequest(
        ["--slug", "t-abc", "--version", "0.268.0", "--bus"],
        "id",
      ),
    ).toMatchObject({
      action: "create",
      host: "t-abc.open-artifacts-staging.app",
      bus: true,
      version: "0.268.0",
      body: {
        version: "0.268.0",
        testHooks: true,
        auth: {
          providers: ["email"],
          domains: ["oa-redline-a.fyi"],
          domainCodes: true,
        },
      },
    });
    const plain = fixtureRequest(["--slug", "t-abc"], "id");
    expect(plain.body).not.toHaveProperty("version");
    expect(plain).toMatchObject({ bus: false });
  });

  it.each(["v0.1.2", "1.2", "latest", "1.2.3-rc.1", "01.2.3", "1.2.3+other"])(
    "refuses ambiguous release %s",
    (version) => {
      expect(() =>
        fixtureRequest(["--slug", "t-case", "--version", version], "id"),
      ).toThrow("--version");
    },
  );

  it("keeps delete specific to a single fixture", () => {
    expect(fixtureRequest(["--slug", "t-abc", "--delete"], "id").body).toEqual({
      requestId: "id",
      confirmSlug: "t-abc",
    });
    expect(
      fixtureRequest(
        ["--slug", "t-abc", "--delete", "--install-id", "iabcdefgh234"],
        "id",
      ),
    ).toMatchObject({
      action: "delete",
      slug: "t-abc",
      installId: "iabcdefgh234",
    });
    expect(() =>
      fixtureRequest(["--slug", "t-abc", "--delete", "--bus"], "id"),
    ).toThrow();
    expect(() =>
      fixtureRequest(["--slug", "t-abc", "--install-id", "iabcdefgh234"], "id"),
    ).toThrow("--install-id");
    expect(() =>
      fixtureRequest(["--slug", "rl-agents", "--delete"], "id"),
    ).toThrow();
  });
});

describe("cleanupFixture", () => {
  const receipt = {
    slug: "t-abc",
    installId: "fixture-original",
    requestId: "fixture-create-123",
  };
  const target = {
    id: receipt.installId,
    slug: receipt.slug,
    appHost: "t-abc.open-artifacts-staging.app",
    testHooks: true,
    state: "active",
    activeJobId: null,
  };
  function cleanupClient() {
    const jobOf = (kind: string) => ({
      id: kind,
      installId: receipt.installId,
      kind,
      status: "done",
    });
    return {
      read: vi
        .fn()
        .mockResolvedValueOnce(target)
        .mockResolvedValue({ ...target, state: "deleting" }),
      start: vi.fn(
        async (
          _id: string,
          kind: string,
          _body: { requestId: string; confirmSlug: string },
        ) => jobOf(kind),
      ),
      jobEnd: vi.fn(async (id: string) => jobOf(id)),
    };
  }

  it("purges the original install after delete completes with a separate idempotency key", async () => {
    const c = cleanupClient();
    await cleanupFixture(receipt, c);
    expect(c.start.mock.calls).toEqual(
      ["delete", "purge"].map((kind) => [
        receipt.installId,
        kind,
        {
          confirmSlug: receipt.slug,
          requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]),
    );
    expect(c.start.mock.calls[0]?.[2]).not.toEqual(c.start.mock.calls[1]?.[2]);
    expect(c.jobEnd.mock.calls).toEqual([["delete"], ["purge"]]);
  });

  it.each([
    { id: "replacement" },
    { slug: "rl-agents" },
    { appHost: "t-abc.open-artifacts.app" },
    { testHooks: false },
  ])("refuses mismatched fixture before cleanup", async (change) => {
    const c = cleanupClient();
    c.read.mockReset().mockResolvedValue({ ...target, ...change });
    await expect(cleanupFixture(receipt, c)).rejects.toThrow(
      "identity mismatch",
    );
    expect(c.start).not.toHaveBeenCalled();
  });

  it("stops after a failed delete and resumes a completed delete directly at purge", async () => {
    const c = cleanupClient();
    c.jobEnd.mockResolvedValueOnce({
      id: "delete",
      kind: "delete",
      installId: receipt.installId,
      status: "failed",
    });
    await expect(cleanupFixture(receipt, c)).rejects.toThrow(
      "delete did not complete",
    );
    expect(c.start).toHaveBeenCalledTimes(1);
    await cleanupFixture(receipt, c);
    expect(c.start.mock.calls.map((call) => call[1])).toEqual([
      "delete",
      "purge",
    ]);
  });
});

describe("log parsing and hookKeyOnlyOf", () => {
  it("parses create and delete markers and refuses PATs in hookKeyOnly payloads", () => {
    const createLog = [
      'echo "test-install-id: $id"',
      "2026-11-28T00:00:00Z test-install-id: iabcdefgh234",
      "2026-11-28T00:00:00Z test-install-repo-id: 4242",
      "2026-11-28T00:00:00Z test-install-slug: t-demo",
      "2026-11-28T00:00:00Z test-install-app-host: t-demo.open-artifacts-staging.app",
      "2026-11-28T00:00:00Z test-install-version: 0.271.1",
      "2026-11-28T00:00:00Z test-install-create-job: job-c1",
      "2026-11-28T00:00:00Z test-install-creds-job: job-k1",
      "2026-11-28T00:00:00Z test-install-sealed: oa-seal-v1.abc.def.ghi",
    ].join("\n");
    expect(parseCreateLog(createLog, "t-demo")).toEqual({
      installId: "iabcdefgh234",
      repositoryId: "4242",
      slug: "t-demo",
      host: "t-demo.open-artifacts-staging.app",
      version: "0.271.1",
      createJob: "job-c1",
      credsJob: "job-k1",
      sealed: "oa-seal-v1.abc.def.ghi",
    });
    expect(parseCreateLog(createLog, "t-other")).toBeNull();
    const deleteLog = [
      "test-install-id: iabcdefgh234",
      "test-install-slug: t-demo",
      "test-install-purged: true",
    ].join("\n");
    expect(parseDeleteLog(deleteLog, "t-demo", "iabcdefgh234")).toBe(true);
    expect(parseDeleteLog(deleteLog, "t-demo", "iabcdefgh235")).toBe(false);
    expect(hookKeyOnlyOf(JSON.stringify({ hookKey: "hk-1" }))).toBe("hk-1");
    expect(() =>
      hookKeyOnlyOf(JSON.stringify({ hookKey: "hk-1", pat: "oa_pat_x" })),
    ).toThrow("refuse sealed admin PATs");
  });
});

describe("parseBusLoginApproval and startFixtureBus", () => {
  const origin = "https://t-bus.open-artifacts-staging.app";
  const utf8Transcript = [
    "oa-bus 0.272.1",
    "",
    "→  Open this URL on any machine:",
    `   ${origin}/bus/approve`,
    "",
    "   ╭─────────────╮",
    "   │  AB12-CD34  │  Your code. Type it on the approval page.",
    "   ╰─────────────╯  Valid 10 minutes.",
    "",
    "Waiting for approval (up to 10 minutes)…",
    "",
  ].join("\n");
  const asciiTranscript = [
    "oa-bus 0.272.1",
    "",
    ">  Open this URL on any machine:",
    `   ${origin}/bus/approve`,
    "",
    "   +-------------+",
    "   |  ZX98-CV76  |  Your code. Type it on the approval page.",
    "   +-------------+  Valid 10 minutes.",
    "",
    "Waiting for approval (up to 10 minutes)...",
    "",
  ].join("\n");

  it("parses released multi-line UTF-8, ASCII, and ANSI transcripts and refuses wrong origins", () => {
    expect(parseBusLoginApproval(utf8Transcript, origin)).toBe("AB12-CD34");
    expect(parseBusLoginApproval(asciiTranscript, origin)).toBe("ZX98-CV76");
    const colored = utf8Transcript
      .replace(`${origin}/bus/approve`, `\x1b[36m${origin}/bus/approve\x1b[39m`)
      .replace("AB12-CD34", "\x1b[38;2;90;150;255mAB12-CD34\x1b[39m");
    expect(parseBusLoginApproval(colored, origin)).toBe("AB12-CD34");
    expect(
      parseBusLoginApproval(
        utf8Transcript.replace(origin, "https://evil.example"),
        origin,
      ),
    ).toBeNull();
  });

  it("pins @open-artifacts/bus from /llms.txt, approves released multi-line transcript in browser, starts daemon, and checks status", async () => {
    const dockerCalls: string[][] = [];
    const spawnCalls: string[][] = [];
    const approveCalls: string[] = [];
    const llms = 'p.version==="0.272.1"&&p.integrity==="sha512-XYZ=="';
    const fetcher = vi.fn(async () => new Response(llms, { status: 200 }));
    const bus = await startFixtureBus(
      {
        slug: "t-bus",
        installId: "inst-bus1",
        hookKey: "hk-secret",
        fetcher,
      },
      {
        docker: async (...args) => {
          dockerCalls.push(args);
          return "";
        },
        spawnDocker: (args) => {
          spawnCalls.push(args);
          const proc = new EventEmitter() as ReturnType<Deps["spawnDocker"]>;
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          Object.assign(proc, { stdout, stderr, kill: vi.fn() });
          queueMicrotask(() => {
            if (args.includes("login")) {
              // Emit URL and code box in separate chunks, as the released CLI does.
              const splitAt = utf8Transcript.indexOf("╭");
              stdout.write(utf8Transcript.slice(0, splitAt));
              stdout.write(utf8Transcript.slice(splitAt));
            }
            proc.emit("close", 0);
          });
          return proc;
        },
        approveBus: async (_slug, _id, _hk, code) => {
          approveCalls.push(code);
        },
      },
    );
    expect(bus).toEqual({
      ...busNames("t-bus"),
      image: "oa-staging-bus:0.272.1",
      version: "0.272.1",
    });
    expect(approveCalls).toEqual(["AB12-CD34"]);
    expect(spawnCalls[0]).toEqual(
      expect.arrayContaining(["login", "--no-color"]),
    );
    expect(dockerCalls[0]).toEqual(
      expect.arrayContaining([
        "build",
        "--build-arg",
        "BUS_VERSION=0.272.1",
        "--build-arg",
        "BUS_INTEGRITY=sha512-XYZ==",
        "-t",
        "oa-staging-bus:0.272.1",
      ]),
    );
    expect(dockerCalls.at(-1)).toEqual([
      "exec",
      "oa-bus-t-bus",
      "oa-bus",
      "status",
      "--home",
      "/home/node/.oa-bus",
    ]);
    expect(spawnCalls).toHaveLength(2);
  });

  it("refuses to approve when login prints a mismatched origin", async () => {
    const approveBus = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response('p.version==="0.272.1"&&p.integrity==="sha512-XYZ=="', {
          status: 200,
        }),
    );
    await expect(
      startFixtureBus(
        {
          slug: "t-bus",
          installId: "inst-bus1",
          hookKey: "hk-secret",
          fetcher,
        },
        {
          docker: async () => "",
          spawnDocker: () => {
            const proc = new EventEmitter() as ReturnType<Deps["spawnDocker"]>;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(proc, { stdout, stderr, kill: vi.fn() });
            queueMicrotask(() => {
              stdout.write(
                utf8Transcript.replace(origin, "https://other.example"),
              );
              proc.emit("close", 0);
            });
            return proc;
          },
          approveBus,
        },
      ),
    ).rejects.toThrow("before printing approval code");
    expect(approveBus).not.toHaveBeenCalled();
  });

  it("stopFixtureBus ignores already-absent resources and fails loudly on real Docker errors", async () => {
    const absent = vi.fn(async (...args: string[]) => {
      if (args[0] === "rm")
        throw Object.assign(new Error("exit 1"), {
          stderr: "Error response from daemon: No such container: oa-bus-t-a",
        });
      throw Object.assign(new Error("exit 1"), {
        stderr:
          "Error response from daemon: get oa-bus-home-t-a: no such volume",
      });
    });
    await expect(stopFixtureBus("t-a", absent)).resolves.toBeUndefined();

    const inUse = vi.fn(async (...args: string[]) => {
      if (args[0] === "volume")
        throw Object.assign(new Error("exit 1"), {
          stderr:
            "Error response from daemon: remove oa-bus-home-t-a: volume is in use",
        });
      return "";
    });
    await expect(stopFixtureBus("t-a", inUse)).rejects.toThrow(
      "volume is in use",
    );
  });
});

describe("main", () => {
  let tmp: string;
  let receiptBase: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oa-ti-tmp-"));
    receiptBase = join(tmp, "receipts");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("prints help cleanly", async () => {
    const lines: string[] = [];
    const code = await main(["--help"], {
      gh: vi.fn(),
      docker: vi.fn(),
      spawnDocker: vi.fn(),
      fetch: vi.fn(),
      now: () => 1000,
      requestId: () => "rid-1",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines[0]).toBe(HELP);
  });

  it("creates a fixture, writes a 0600 receipt with Ed25519 owner key, returns sealed hook key + storageState, then signs delete proof to delete+purge", async () => {
    const lines: string[] = [];
    let sealedOut = "";
    let createdOwnerPub = "";
    let deleteOwnerPub = "";
    let deleteProof = "";
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        const owner = args.find((a) => a.startsWith("inputs[owner_key]="));
        const rec = args.find((a) => a.startsWith("inputs[recipient_key]="));
        const proof = args.find((a) => a.startsWith("inputs[delete_proof]="));
        if (rec) {
          createdOwnerPub = owner?.slice("inputs[owner_key]=".length) ?? "";
          const pub = rec.slice("inputs[recipient_key]=".length);
          sealedOut = sealFor(pub, JSON.stringify({ hookKey: "plain-hk-99" }));
        } else if (proof) {
          deleteOwnerPub = owner?.slice("inputs[owner_key]=".length) ?? "";
          deleteProof = proof.slice("inputs[delete_proof]=".length);
        }
        return "99001\n";
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view") {
        if (sealedOut) {
          const log = [
            "test-install-id: iabcdefgh234",
            "test-install-repo-id: 4242",
            "test-install-slug: t-demo",
            "test-install-app-host: t-demo.open-artifacts-staging.app",
            "test-install-version: 0.271.1",
            "test-install-create-job: job-c1",
            "test-install-creds-job: job-k1",
            `test-install-sealed: ${sealedOut}`,
          ].join("\n");
          sealedOut = "";
          return log;
        }
        return [
          "test-install-id: iabcdefgh234",
          "test-install-slug: t-demo",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const docker = vi.fn(async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });
    const memberState = vi.fn(async (_slug, _id, hk) => {
      expect(hk).toBe("plain-hk-99");
      return "/tmp/fake-storage-state.json";
    });
    const deps: Deps = {
      gh,
      docker,
      spawnDocker: vi.fn(),
      fetch: vi.fn(),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-test-1",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
      memberState,
    };

    expect(await main(["--slug", "t-demo"], deps)).toBe(0);
    const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(created).toEqual({
      slug: "t-demo",
      installId: "iabcdefgh234",
      host: "t-demo.open-artifacts-staging.app",
      version: "0.271.1",
      run: "99001",
      sealedHookKey: expect.stringMatching(/^oa-seal-v1\./),
      storageState: "/tmp/fake-storage-state.json",
    });
    // Plaintext hook key and owner private key are never printed.
    expect(lines[0]).not.toContain("plain-hk-99");
    expect(lines[0]).not.toContain("privateKeyPkcs8");
    const receiptFile = join(receiptBase, "t-demo.json");
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(receiptFile, "utf8")).not.toContain("plain-hk-99");

    // Delete signs a verifiable Ed25519 proof with the saved owner key, stops Docker bus,
    // dispatches delete+purge, and removes the receipt.
    expect(await main(["--slug", "t-demo", "--delete"], deps)).toBe(0);
    expect(deleteOwnerPub).toBe(createdOwnerPub);
    const [pId, pExp, pSig] = deleteProof.split(".");
    expect(pId).toBe("iabcdefgh234");
    expect(Number(pExp)).toBe(1_700_000_000_000 + 25 * 60_000);
    const edPub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: createdOwnerPub },
      format: "jwk",
    });
    expect(
      verifyBytes(
        null,
        Buffer.from(`oa-fixture-delete-v1\n4242\niabcdefgh234\n${pExp}`),
        edPub,
        Buffer.from(pSig ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({
      deleted: "t-demo",
      purged: true,
      installId: "iabcdefgh234",
      run: "99001",
    });
    expect(existsSync(receiptFile)).toBe(false);
    // No-bus fixture cleanup never requires Docker.
    expect(docker).not.toHaveBeenCalled();
  });

  it("persists ownership before dispatch and recovers immutable installId for --delete after watch and log-read failures", async () => {
    const lines: string[] = [];
    const receiptFile = join(receiptBase, "t-drop.json");
    let receiptSeenAtDispatch = false;
    let createOwnerPub = "";
    let deleteOwnerPub = "";
    let deleteProof = "";
    let logReadAttempts = 0;
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        const action = args.find((a) => a.startsWith("inputs[action]="));
        const owner = args.find((a) => a.startsWith("inputs[owner_key]="));
        const proof = args.find((a) => a.startsWith("inputs[delete_proof]="));
        if (action === "inputs[action]=create") {
          receiptSeenAtDispatch = existsSync(receiptFile);
          createOwnerPub = owner?.slice("inputs[owner_key]=".length) ?? "";
          return "77101\n";
        }
        deleteOwnerPub = owner?.slice("inputs[owner_key]=".length) ?? "";
        deleteProof = proof?.slice("inputs[delete_proof]=".length) ?? "";
        return "77102\n";
      }
      if (args[0] === "run" && args[1] === "watch") {
        if (args[2] === "77101") throw new Error("watch interrupted");
        return "";
      }
      if (args[0] === "run" && args[1] === "view") {
        if (args[2] === "77101") {
          logReadAttempts++;
          if (logReadAttempts === 1) throw new Error("log not ready yet");
          return [
            "test-install-id: irecover1234",
            "test-install-repo-id: 4242",
          ].join("\n");
        }
        return [
          "test-install-id: irecover1234",
          "test-install-slug: t-drop",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const deps: Deps = {
      gh,
      docker: vi.fn(async () => ""),
      spawnDocker: vi.fn(),
      fetch: vi.fn(),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-drop",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
      memberState: vi.fn(),
    };

    await expect(main(["--slug", "t-drop"], deps)).rejects.toThrow(
      "watch interrupted",
    );
    expect(receiptSeenAtDispatch).toBe(true);
    expect(existsSync(receiptFile)).toBe(true);
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
    const partial = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(partial.runId).toBe("77101");
    expect(partial.installId).toBeNull();
    expect(parsePartialCreateLog("test-install-id: irecover1234")).toEqual({
      installId: "irecover1234",
      repositoryId: null,
    });

    // A duplicate create must refuse instead of overwriting the saved owner key.
    await expect(main(["--slug", "t-drop"], deps)).rejects.toThrow(
      "receipt already exists",
    );

    // Later --delete recovers installId + repoId from run 77101's log and purges.
    expect(await main(["--slug", "t-drop", "--delete"], deps)).toBe(0);
    expect(deleteOwnerPub).toBe(createOwnerPub);
    expect(deleteProof.startsWith("irecover1234.")).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      deleted: "t-drop",
      purged: true,
      installId: "irecover1234",
      run: "77102",
    });
    expect(existsSync(receiptFile)).toBe(false);
  });

  it("retains purge state when Docker volume removal fails on a --bus fixture and finishes local cleanup on retry without re-purging", async () => {
    const lines: string[] = [];
    const receiptFile = join(receiptBase, "t-vol.json");
    let sealedOut = "";
    let deleteDispatches = 0;
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        const rec = args.find((a) => a.startsWith("inputs[recipient_key]="));
        if (rec) {
          sealedOut = sealFor(
            rec.slice("inputs[recipient_key]=".length),
            JSON.stringify({ hookKey: "plain-hk-vol" }),
          );
          return "88001\n";
        }
        deleteDispatches++;
        return "88002\n";
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view") {
        if (args[2] === "88001") {
          return [
            "test-install-id: ivolume12345",
            "test-install-repo-id: 4242",
            "test-install-slug: t-vol",
            "test-install-app-host: t-vol.open-artifacts-staging.app",
            "test-install-version: 0.272.1",
            "test-install-create-job: job-c1",
            "test-install-creds-job: job-k1",
            `test-install-sealed: ${sealedOut}`,
          ].join("\n");
        }
        return [
          "test-install-id: ivolume12345",
          "test-install-slug: t-vol",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    let volumeBusy = false;
    const docker = vi.fn(async (...args: string[]) => {
      if (args[0] === "volume" && args[1] === "rm" && volumeBusy)
        throw Object.assign(new Error("exit 1"), {
          stderr:
            "Error response from daemon: remove oa-bus-home-t-vol: volume is in use",
        });
      return "";
    });
    const spawnDocker = vi.fn((args: string[]) => {
      const proc = new EventEmitter() as ReturnType<Deps["spawnDocker"]>;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(proc, { stdout, stderr, kill: vi.fn() });
      queueMicrotask(() => {
        if (args.includes("login")) {
          stdout.write(
            [
              "oa-bus 0.272.1",
              "→  Open this URL on any machine:",
              "   https://t-vol.open-artifacts-staging.app/bus/approve",
              "   │  AB12-CD34  │  Your code. Type it on the approval page.",
            ].join("\n"),
          );
        }
        proc.emit("close", 0);
      });
      return proc;
    });
    const deps: Deps = {
      gh,
      docker,
      spawnDocker,
      fetch: vi.fn(
        async () =>
          new Response('p.version==="0.272.1"&&p.integrity==="sha512-XYZ=="', {
            status: 200,
          }),
      ),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-vol",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
      memberState: vi.fn(async () => "/tmp/state.json"),
      approveBus: vi.fn(async () => {}),
    };

    expect(await main(["--slug", "t-vol", "--bus"], deps)).toBe(0);
    volumeBusy = true;

    // First --delete: remote purge succeeds, volume removal fails loudly, receipt retained.
    await expect(main(["--slug", "t-vol", "--delete"], deps)).rejects.toThrow(
      "volume is in use",
    );
    expect(deleteDispatches).toBe(1);
    expect(existsSync(receiptFile)).toBe(true);
    expect(
      (JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>)
        .remotePurged,
    ).toBe(true);

    // Retry --delete once volume is free: skips remote purge, removes volume + receipt.
    volumeBusy = false;
    expect(await main(["--slug", "t-vol", "--delete"], deps)).toBe(0);
    expect(deleteDispatches).toBe(1);
    expect(existsSync(receiptFile)).toBe(false);
    expect(docker).toHaveBeenCalledWith("rm", "-f", "oa-bus-t-vol");
    expect(docker).toHaveBeenCalledWith(
      "volume",
      "rm",
      "-f",
      "oa-bus-home-t-vol",
    );
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({
      deleted: "t-vol",
      purged: true,
      installId: "ivolume12345",
    });
  });

  it("exclusively reserves the receipt across 6 concurrent creates so only one dispatches", async () => {
    const receiptFile = join(receiptBase, "t-race.json");
    let dispatches = 0;
    let dispatchedOwner = "";
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        dispatches++;
        const owner = args.find((a) => a.startsWith("inputs[owner_key]="));
        const rec = args.find((a) => a.startsWith("inputs[recipient_key]="));
        dispatchedOwner = owner?.slice("inputs[owner_key]=".length) ?? "";
        const sealed = sealFor(
          rec?.slice("inputs[recipient_key]=".length) ?? "",
          JSON.stringify({ hookKey: "plain-hk-race" }),
        );
        // Stash sealed on closure by returning run id.
        sealedByRun.set(String(dispatches), sealed);
        return `${90000 + dispatches}\n`;
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view") {
        const idx = String(Number(args[2]) - 90000);
        return [
          "test-install-id: irace0001234",
          "test-install-repo-id: 4242",
          "test-install-slug: t-race",
          "test-install-app-host: t-race.open-artifacts-staging.app",
          "test-install-version: 0.272.1",
          "test-install-create-job: job-c1",
          "test-install-creds-job: job-k1",
          `test-install-sealed: ${sealedByRun.get(idx) ?? ""}`,
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const sealedByRun = new Map<string, string>();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        main(["--slug", "t-race"], {
          gh,
          docker: vi.fn(async () => ""),
          spawnDocker: vi.fn(),
          fetch: vi.fn(),
          now: () => 1_700_000_000_000,
          requestId: () => `rid-race-${i}`,
          tmp,
          receiptBase,
          log: () => {},
          memberState: vi.fn(async () => "/tmp/state.json"),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(dispatches).toBe(1);
    const saved = JSON.parse(readFileSync(receiptFile, "utf8")) as {
      ownerKey: { publicKey: string };
      runId: string;
    };
    expect(saved.ownerKey.publicKey).toBe(dispatchedOwner);
    expect(saved.runId).toBe("90001");
  });

  it("falls back to explicit --install-id and repo metadata when create logs are expired, while preserving mismatch checks", async () => {
    const receiptFile = join(receiptBase, "t-exp.json");
    const lines: string[] = [];
    let logReadable = false;
    let deleteDispatches = 0;
    let repoLookups = 0;
    const gh = vi.fn(async (...args: string[]) => {
      if (
        args[0] === "api" &&
        args[1] === "repos/open-artifacts-ai/open-artifacts-cloud"
      ) {
        repoLookups++;
        return "4242\n";
      }
      if (args[0] === "api") {
        const action = args.find((a) => a.startsWith("inputs[action]="));
        if (action === "inputs[action]=create") return "77501\n";
        deleteDispatches++;
        return "77502\n";
      }
      if (args[0] === "run" && args[1] === "watch") {
        if (args[2] === "77501") throw new Error("watch interrupted");
        return "";
      }
      if (args[0] === "run" && args[1] === "view") {
        if (args[2] === "77501") {
          if (!logReadable) throw new Error("HTTP 410: log expired");
          return [
            "test-install-id: ireal0001234",
            "test-install-repo-id: 4242",
          ].join("\n");
        }
        return [
          "test-install-id: iexp00001234",
          "test-install-slug: t-exp",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const deps: Deps = {
      gh,
      docker: vi.fn(async () => {
        throw Object.assign(new Error("spawn docker ENOENT"), {
          code: "ENOENT",
        });
      }),
      spawnDocker: vi.fn(),
      fetch: vi.fn(),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-exp",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
      memberState: vi.fn(),
    };

    await expect(main(["--slug", "t-exp"], deps)).rejects.toThrow(
      "watch interrupted",
    );
    // When log is readable, a mismatched --install-id is refused before dispatch.
    logReadable = true;
    await expect(
      main(
        ["--slug", "t-exp", "--delete", "--install-id", "iwrong001234"],
        deps,
      ),
    ).rejects.toThrow("does not match saved receipt");
    expect(deleteDispatches).toBe(0);

    // When log is expired/unavailable, --delete --install-id uses repo metadata and purges.
    logReadable = false;
    expect(
      await main(
        ["--slug", "t-exp", "--delete", "--install-id", "iexp00001234"],
        deps,
      ),
    ).toBe(0);
    expect(repoLookups).toBe(1);
    expect(deleteDispatches).toBe(1);
    expect(existsSync(receiptFile)).toBe(false);
  });

  it("cleans up Docker on --delete when --bus failed partway through startup", async () => {
    const receiptFile = join(receiptBase, "t-busfail.json");
    let sealedOut = "";
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        const rec = args.find((a) => a.startsWith("inputs[recipient_key]="));
        if (rec) {
          sealedOut = sealFor(
            rec.slice("inputs[recipient_key]=".length),
            JSON.stringify({ hookKey: "plain-hk-bf" }),
          );
          return "88501\n";
        }
        return "88502\n";
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view") {
        if (args[2] === "88501")
          return [
            "test-install-id: ibusf0001234",
            "test-install-repo-id: 4242",
            "test-install-slug: t-busfail",
            "test-install-app-host: t-busfail.open-artifacts-staging.app",
            "test-install-version: 0.272.1",
            "test-install-create-job: job-c1",
            "test-install-creds-job: job-k1",
            `test-install-sealed: ${sealedOut}`,
          ].join("\n");
        return [
          "test-install-id: ibusf0001234",
          "test-install-slug: t-busfail",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const docker = vi.fn(async () => "");
    const deps: Deps = {
      gh,
      docker,
      spawnDocker: vi.fn(),
      fetch: vi.fn(async () => new Response("down", { status: 503 })),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-bf",
      tmp,
      receiptBase,
      log: () => {},
      memberState: vi.fn(async () => "/tmp/state.json"),
    };

    await expect(main(["--slug", "t-busfail", "--bus"], deps)).rejects.toThrow(
      "/llms.txt failed",
    );
    expect(
      (JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>)
        .busRequested,
    ).toBe(true);
    expect(await main(["--slug", "t-busfail", "--delete"], deps)).toBe(0);
    expect(docker).toHaveBeenCalledWith("rm", "-f", "oa-bus-t-busfail");
    expect(docker).toHaveBeenCalledWith(
      "volume",
      "rm",
      "-f",
      "oa-bus-home-t-busfail",
    );
    expect(existsSync(receiptFile)).toBe(false);
  });

  it("saves installId before failing on incomplete R26 output and supports --delete --install-id after pre-runId dispatch failure", async () => {
    const receiptFile = join(receiptBase, "t-r26.json");
    const lines: string[] = [];
    let viewCount = 0;
    const gh = vi.fn(async (...args: string[]) => {
      if (args[0] === "api") {
        const action = args.find((a) => a.startsWith("inputs[action]="));
        return action === "inputs[action]=create" ? "66101\n" : "66102\n";
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view") {
        viewCount++;
        if (args[2] === "66101")
          return [
            "test-install-id: ipartial1234",
            "test-install-repo-id: 4242",
          ].join("\n");
        return [
          "test-install-id: ipartial1234",
          "test-install-slug: t-r26",
          "test-install-purged: true",
        ].join("\n");
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const deps: Deps = {
      gh,
      docker: vi.fn(async () => ""),
      spawnDocker: vi.fn(),
      fetch: vi.fn(),
      now: () => 1_700_000_000_000,
      requestId: () => "rid-r26",
      tmp,
      receiptBase,
      log: (l) => lines.push(l),
      memberState: vi.fn(),
    };

    await expect(main(["--slug", "t-r26"], deps)).rejects.toThrow(
      "fixture create output missing from log",
    );
    const saved = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.installId).toBe("ipartial1234");
    expect(saved.repositoryId).toBe("4242");

    // --delete uses already-persisted installId without re-reading run 66101's log.
    expect(await main(["--slug", "t-r26", "--delete"], deps)).toBe(0);
    expect(viewCount).toBe(2);
    expect(existsSync(receiptFile)).toBe(false);

    // Pre-runId dispatch failure: owner key is preserved; --delete --install-id recovers repoId and purges.
    const gh2 = vi.fn(async (...args: string[]) => {
      if (
        args[0] === "api" &&
        args[1] === "repos/open-artifacts-ai/open-artifacts-cloud"
      )
        return "4242\n";
      if (args[0] === "api") {
        const action = args.find((a) => a.startsWith("inputs[action]="));
        if (action === "inputs[action]=create")
          throw new Error("dispatch response dropped");
        return "66202\n";
      }
      if (args[0] === "run" && args[1] === "watch") return "";
      if (args[0] === "run" && args[1] === "view")
        return [
          "test-install-id: idrop0001234",
          "test-install-slug: t-r26",
          "test-install-purged: true",
        ].join("\n");
      throw new Error(`unexpected gh: ${args.join(" ")}`);
    });
    const deps2: Deps = { ...deps, gh: gh2 };
    await expect(main(["--slug", "t-r26"], deps2)).rejects.toThrow(
      "dispatch response dropped",
    );
    expect(existsSync(receiptFile)).toBe(true);
    expect(
      await main(
        ["--slug", "t-r26", "--delete", "--install-id", "idrop0001234"],
        deps2,
      ),
    ).toBe(0);
    expect(existsSync(receiptFile)).toBe(false);
  });
});
