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
  parseCreateLog,
  parseDeleteLog,
  SEAL_INFO,
  startFixtureBus,
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

describe("startFixtureBus", () => {
  it("pins @open-artifacts/bus from /llms.txt, approves in browser, starts daemon, and checks status", async () => {
    const dockerCalls: string[][] = [];
    const spawnCalls: string[][] = [];
    const approveCalls: string[] = [];
    const llms = 'p.version==="0.15.0"&&p.integrity==="sha512-XYZ=="';
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
              stdout.write(
                "Open https://t-bus.open-artifacts-staging.app/bus/approve and type this code to approve this machine: AB12-CD34\n",
              );
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
      image: "oa-staging-bus:0.15.0",
      version: "0.15.0",
    });
    expect(approveCalls).toEqual(["AB12-CD34"]);
    expect(dockerCalls[0]).toEqual(
      expect.arrayContaining([
        "build",
        "--build-arg",
        "BUS_VERSION=0.15.0",
        "--build-arg",
        "BUS_INTEGRITY=sha512-XYZ==",
        "-t",
        "oa-staging-bus:0.15.0",
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
    const docker = vi.fn(async () => "");
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
    expect(docker).toHaveBeenCalledWith("rm", "-f", "oa-bus-t-demo");
    expect(docker).toHaveBeenCalledWith(
      "volume",
      "rm",
      "-f",
      "oa-bus-home-t-demo",
    );
  });
});
