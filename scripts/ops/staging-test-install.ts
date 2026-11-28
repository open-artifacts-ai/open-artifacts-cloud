#!/usr/bin/env node
// Create or delete+purge a disposable staging test install (t-*):
//   node scripts/ops/staging-test-install.ts --slug t-<name> [--version X.Y.Z] [--bus] [--delete]
// Staging only. Uses .github/workflows/staging-test-install.yml (OIDC) so no
// person hands over credentials.
import {
  execFile as execFileCb,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  approveFixtureBusInBrowser,
  FIXTURE_OWNER_EMAIL,
  FIXTURE_TEST_DOMAIN,
  type FixtureBrowser,
  fixtureHost,
  fixtureMemberState,
  parseBusPinFromLlms,
} from "./staging-fixture-session.ts";
import { openSealedNode } from "./staging-test-admin.ts";
import { prepareMcpDir } from "./staging-test-member.ts";

const execFile = promisify(execFileCb);
const REPO = "open-artifacts-ai/open-artifacts-cloud";
export const WORKFLOW = "staging-test-install.yml";
/** R26's HKDF info (apps/provisioner/src/seal.ts SEAL_INFO.redlineCreds). */
export const SEAL_INFO = "oa-redline-creds-v1";
/** Where fixture receipts live (0700, outside any git work tree). */
export const RECEIPT_BASE = join(homedir(), ".oa-redline", "fixtures");
export const BUS_CONTAINER_PREFIX = "oa-bus-";
export const BUS_VOLUME_PREFIX = "oa-bus-home-";
export const BUS_IMAGE_PREFIX = "oa-staging-bus:";
const VERSION_RE = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/;
const INSTALL_ID_RE = /^i[a-z0-9]{11}$/;
const JOB_ID_RE = "[A-Za-z0-9_-]{1,64}";
const DELETE_PROOF_DOMAIN = "oa-fixture-delete-v1";
const DELETE_PROOF_TTL_MS = 25 * 60_000;
const OPS_DIR = dirname(fileURLToPath(import.meta.url));
const BUS_DOCKERFILE = join(OPS_DIR, "staging-test-bus.Dockerfile");
const BUS_HOME_IN_CONTAINER = "/home/node/.oa-bus";
const BUS_CONNECT_TIMEOUT_MS = 30_000;

export const HELP = `Usage: node scripts/ops/staging-test-install.ts --slug t-<name> [--version X.Y.Z] [--bus]
       node scripts/ops/staging-test-install.ts --slug t-<name> --delete [--install-id <id>]

Creates or deletes+purges a disposable staging test install (t-* with test
hooks, ${FIXTURE_TEST_DOMAIN}, email + domain codes) via ${WORKFLOW} on main.

  --slug t-<name>    disposable staging install slug (required)
  --version X.Y.Z    exact release version on create (default: staging's current release)
  --bus              also build & run the released @open-artifacts/bus in Docker
                     against the install and approve the machine in the browser
                     as ${FIXTURE_OWNER_EMAIL}
  --delete           delete AND purge the original install (and stop/remove any
                     Docker bus container/volume for this slug)
  --install-id <id>  with --delete only: override the saved fixture receipt's install ID
  --help             this text

Staging only. Needs gh (signed in); --bus also needs Docker.`;

export type FixtureCreateRequest = {
  action: "create";
  slug: string;
  host: string;
  bus: boolean;
  version?: string;
  body: {
    requestId: string;
    slug: string;
    ownerEmail: string;
    tier: "team";
    testHooks: true;
    auth: { providers: ["email"]; domains: [string]; domainCodes: true };
    version?: string;
  };
};

export type FixtureDeleteRequest = {
  action: "delete";
  slug: string;
  host: string;
  installId?: string;
  body: { requestId: string; confirmSlug: string };
};

export type FixtureHelpRequest = { action: "help" };

export type FixtureRequest =
  | FixtureCreateRequest
  | FixtureDeleteRequest
  | FixtureHelpRequest;

export function fixtureRequest(
  argv: readonly string[],
  requestId: string,
): FixtureCreateRequest | FixtureDeleteRequest;
export function fixtureRequest(
  argv: readonly string[],
  requestId: string,
  allowHelp: true,
): FixtureRequest;
export function fixtureRequest(
  argv: readonly string[],
  requestId: string,
  allowHelp?: boolean,
): FixtureRequest {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      slug: { type: "string" },
      version: { type: "string" },
      bus: { type: "boolean" },
      delete: { type: "boolean" },
      "install-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help && allowHelp) return { action: "help" };
  const slug = values.slug ?? "";
  const host = fixtureHost(slug);
  if (values.delete) {
    if (values.version !== undefined || values.bus)
      throw new Error("--delete takes only --slug and optional --install-id");
    const installId = values["install-id"];
    if (installId !== undefined && !INSTALL_ID_RE.test(installId))
      throw new Error("--install-id is not a valid install ID");
    return {
      action: "delete",
      slug,
      host,
      ...(installId === undefined ? {} : { installId }),
      body: { requestId, confirmSlug: slug },
    };
  }
  if (values["install-id"] !== undefined)
    throw new Error("--install-id is only valid with --delete");
  if (values.version !== undefined && !VERSION_RE.test(values.version))
    throw new Error("--version expects an exact X.Y.Z release");
  return {
    action: "create",
    slug,
    host,
    bus: values.bus === true,
    ...(values.version === undefined ? {} : { version: values.version }),
    body: {
      requestId,
      slug,
      ownerEmail: FIXTURE_OWNER_EMAIL,
      tier: "team",
      testHooks: true,
      auth: {
        providers: ["email"],
        domains: [FIXTURE_TEST_DOMAIN],
        domainCodes: true,
      },
      ...(values.version === undefined ? {} : { version: values.version }),
    },
  };
}

export type FixtureOwnerKey = {
  /** Raw 32-byte Ed25519 public key, base64url without padding. */
  publicKey: string;
  /** PKCS#8 DER Ed25519 private key, base64url; stored only in 0600 receipts. */
  privateKeyPkcs8: string;
};

// The receipt is written before dispatch and updated as IDs and purge state
// become known so interrupted create/mint/watch/log/cleanup steps remain recoverable.
export type FixtureReceipt = {
  slug: string;
  installId: string | null;
  repositoryId: string | null;
  runId?: string | null;
  requestId: string;
  ownerKey: FixtureOwnerKey;
  host?: string;
  version?: string;
  createdAt?: number;
  bus?: FixtureBusInfo;
  remotePurged?: boolean;
};

export function generateOwnerKey(): FixtureOwnerKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "jwk" }).x as string,
    privateKeyPkcs8: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}

export function signOwnerDeleteProof(
  privateKeyPkcs8: string,
  input: { repositoryId: string; installId: string; expiresAt: number },
): string {
  const payload = `${DELETE_PROOF_DOMAIN}\n${input.repositoryId}\n${input.installId}\n${input.expiresAt}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const sig = signBytes(null, Buffer.from(payload, "utf8"), key).toString(
    "base64url",
  );
  return `${input.installId}.${input.expiresAt}.${sig}`;
}

export type FixtureBusInfo = {
  container: string;
  volume: string;
  image: string;
  version: string;
};

type CleanupStep = "delete" | "purge";
type CleanupInstall = {
  id: string;
  slug: string;
  appHost: string;
  testHooks: boolean;
  state: string;
  activeJobId: string | null;
};
type CleanupJob = {
  id: string;
  installId: string;
  kind: string;
  status: string;
};
type CleanupClient = {
  read(id: string): Promise<CleanupInstall>;
  start(
    id: string,
    kind: CleanupStep,
    body: { requestId: string; confirmSlug: string },
  ): Promise<CleanupJob>;
  jobEnd(id: string): Promise<CleanupJob>;
};

export async function cleanupFixture(
  receipt: { slug: string; installId: string; requestId: string },
  client: CleanupClient,
): Promise<void> {
  const { slug, installId, requestId } = receipt;
  const host = fixtureHost(slug);
  const read = async () => {
    const target = await client.read(installId);
    if (
      target.id !== installId ||
      target.slug !== slug ||
      target.appHost !== host ||
      !target.testHooks
    )
      throw new Error("staging fixture cleanup identity mismatch");
    return target;
  };
  async function finish(kind: CleanupStep, target: CleanupInstall) {
    const jobId =
      target.activeJobId ??
      (
        await client.start(installId, kind, {
          confirmSlug: slug,
          requestId: createHash("sha256")
            .update(JSON.stringify([installId, requestId, kind]))
            .digest("hex"),
        })
      ).id;
    const job = await client.jobEnd(jobId);
    if (
      job.id !== jobId ||
      job.installId !== installId ||
      job.kind !== kind ||
      job.status !== "done"
    )
      throw new Error(`fixture ${kind} did not complete`);
    return job.id;
  }
  let target = await read();
  if (target.state === "deleted") return;
  if (target.state === "active" || target.state === "suspended") {
    await finish("delete", target);
    target = await read();
  }
  if (target.state !== "deleting")
    throw new Error("fixture is not ready for purge");
  await finish("purge", target);
}

const ANSI_CSI_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
  "g",
);
const stripAnsi = (s: string) => s.replace(ANSI_CSI_RE, "");

function markerValue(
  log: string,
  marker: string,
  value: string,
): string | null {
  const clean = stripAnsi(log);
  const re = new RegExp(
    `(?:^|\\s)test-install-${marker}: (${value})(?=\\s|$)`,
    "gm",
  );
  const found = new Set(Array.from(clean.matchAll(re), (m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}

export type PartialCreateLog = {
  installId: string | null;
  repositoryId: string | null;
};

/** Early markers printed immediately after R4 202, before job waits or R26. */
export function parsePartialCreateLog(log: string): PartialCreateLog {
  return {
    installId: markerValue(log, "id", "i[a-z0-9]{11}"),
    repositoryId: markerValue(log, "repo-id", "[0-9]{1,32}"),
  };
}

export type CreateLog = {
  installId: string;
  repositoryId: string;
  slug: string;
  host: string;
  version: string;
  createJob: string;
  credsJob: string;
  sealed: string;
};

/** Parsed markers from a create run's log, or null. */
export function parseCreateLog(
  log: string,
  expectedSlug: string,
): CreateLog | null {
  const expectedHost = fixtureHost(expectedSlug);
  const installId = markerValue(log, "id", "i[a-z0-9]{11}");
  const repositoryId = markerValue(log, "repo-id", "[0-9]{1,32}");
  const slug = markerValue(log, "slug", "[a-z0-9-]+");
  const host = markerValue(log, "app-host", "[a-z0-9.-]+");
  const version = markerValue(log, "version", "[0-9]+\\.[0-9]+\\.[0-9]+");
  const createJob = markerValue(log, "create-job", JOB_ID_RE);
  const credsJob = markerValue(log, "creds-job", JOB_ID_RE);
  const sealed = markerValue(log, "sealed", "oa-seal-v1\\.[A-Za-z0-9_.-]+");
  if (
    !installId ||
    !repositoryId ||
    slug !== expectedSlug ||
    host !== expectedHost ||
    !version ||
    !createJob ||
    !credsJob ||
    !sealed
  )
    return null;
  return {
    installId,
    repositoryId,
    slug,
    host,
    version,
    createJob,
    credsJob,
    sealed,
  };
}

/** True when a delete run's log confirms the exact install was purged. */
export function parseDeleteLog(
  log: string,
  expectedSlug: string,
  expectedInstallId: string,
): boolean {
  return (
    markerValue(log, "id", "i[a-z0-9]{11}") === expectedInstallId &&
    markerValue(log, "slug", "[a-z0-9-]+") === expectedSlug &&
    markerValue(log, "purged", "true") === "true"
  );
}

/** Opened R26 hookKeyOnly payload: hookKey required, admin PAT forbidden. */
export function hookKeyOnlyOf(plain: string): string {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new Error("the sealed credentials are not JSON");
  }
  const o = v as { hookKey?: unknown; pat?: unknown } | null;
  if (!o || typeof o !== "object")
    throw new Error("the sealed credentials are not an object");
  if ("pat" in o && o.pat !== undefined && o.pat !== null)
    throw new Error("disposable fixtures refuse sealed admin PATs");
  if (typeof o.hookKey !== "string" || o.hookKey === "")
    throw new Error("the sealed credentials have no hook key");
  return o.hookKey;
}

export const busNames = (slug: string) => ({
  container: `${BUS_CONTAINER_PREFIX}${fixtureHost(slug).split(".")[0]}`,
  volume: `${BUS_VOLUME_PREFIX}${fixtureHost(slug).split(".")[0]}`,
});

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Node script executed inside the bus container to watch `events.log` via
 * fs.watch until `hub_connect` is written (zero polling/sleeps).
 */
const WATCH_HUB_CONNECT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.argv[1];
const logsDir = path.join(home, "logs");
const logFile = path.join(logsDir, "events.log");
const hasConnect = () => {
  try {
    return fs.readFileSync(logFile, "utf8").includes(" hub_connect");
  } catch {
    return false;
  }
};
if (hasConnect()) process.exit(0);
const watchers = [];
const done = (code) => {
  for (const w of watchers) w.close();
  process.exit(code);
};
let watchingLogs = false;
const watchLogs = () => {
  if (watchingLogs || !fs.existsSync(logsDir)) return;
  watchingLogs = true;
  watchers.push(fs.watch(logsDir, () => { if (hasConnect()) done(0); }));
  if (hasConnect()) done(0);
};
watchers.push(fs.watch(home, () => { watchLogs(); if (hasConnect()) done(0); }));
watchLogs();
`;

export type BusRunner = {
  docker: (...args: string[]) => Promise<string>;
  spawnDocker: (
    args: string[],
    options?: SpawnOptionsWithoutStdio,
  ) => ReturnType<typeof spawn>;
  approveBus: typeof approveFixtureBusInBrowser;
};

function dockerErrorText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const parts = [
      typeof e.stderr === "string" ? e.stderr.trim() : "",
      typeof e.message === "string" ? e.message.trim() : "",
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(": ");
  }
  return String(error);
}

function isDockerNotFound(
  error: unknown,
  kind: "container" | "volume",
): boolean {
  const text = dockerErrorText(error);
  return kind === "container"
    ? /no such container/i.test(text)
    : /no such volume/i.test(text);
}

/**
 * Extracts the XXXX-XXXX approval code from `oa-bus login --no-open` stdout,
 * requiring the exact fixture approval URL `<origin>/bus/approve`. Supports
 * both the released multi-line boxed transcript (UTF-8 or ASCII, with or
 * without ANSI escapes) and the plain single-line login fallback.
 */
export function parseBusLoginApproval(
  output: string,
  origin: string,
): string | null {
  const clean = stripAnsi(output);
  const approveUrl = `${origin}/bus/approve`;
  const legacy = new RegExp(
    `Open ${escapeRegExp(approveUrl)} and type this code to approve this machine: ([A-Z0-9]{4}-[A-Z0-9]{4})(?=\\s|$)`,
  ).exec(clean);
  if (legacy?.[1]) return legacy[1];
  const urlMatch = new RegExp(
    `(?:^|\\s)${escapeRegExp(approveUrl)}(?=\\s|$)`,
    "m",
  ).exec(clean);
  if (!urlMatch) return null;
  const afterUrl = clean.slice(urlMatch.index + urlMatch[0].length);
  const boxMatch = /[|│]\s+([A-Z0-9]{4}-[A-Z0-9]{4})\s+[|│]/.exec(afterUrl);
  return boxMatch?.[1] ?? null;
}

export async function stopFixtureBus(
  slug: string,
  docker: (...args: string[]) => Promise<string>,
): Promise<void> {
  const { container, volume } = busNames(slug);
  try {
    await docker("rm", "-f", container);
  } catch (e) {
    if (!isDockerNotFound(e, "container"))
      throw new Error(
        `failed to remove Docker container ${container}: ${dockerErrorText(e)}`,
      );
  }
  try {
    await docker("volume", "rm", "-f", volume);
  } catch (e) {
    if (!isDockerNotFound(e, "volume"))
      throw new Error(
        `failed to remove Docker volume ${volume}: ${dockerErrorText(e)}`,
      );
  }
}

export async function startFixtureBus(
  opts: {
    slug: string;
    installId: string;
    hookKey: string;
    fetcher: typeof fetch;
    launch?: () => Promise<FixtureBrowser>;
  },
  runner: BusRunner,
): Promise<FixtureBusInfo> {
  const host = fixtureHost(opts.slug);
  const origin = `https://${host}`;
  const llmsRes = await opts.fetcher(`${origin}/llms.txt`, {
    redirect: "error",
  });
  if (!llmsRes.ok)
    throw new Error(`fixture /llms.txt failed: HTTP ${llmsRes.status}`);
  const pin = parseBusPinFromLlms(await llmsRes.text());
  const image = `${BUS_IMAGE_PREFIX}${pin.version}`;
  const { container, volume } = busNames(opts.slug);

  await runner.docker(
    "build",
    "-f",
    BUS_DOCKERFILE,
    "--build-arg",
    `BUS_VERSION=${pin.version}`,
    "--build-arg",
    `BUS_INTEGRITY=${pin.integrity}`,
    "-t",
    image,
    OPS_DIR,
  );

  await stopFixtureBus(opts.slug, runner.docker);
  await runner.docker("volume", "create", volume);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = runner.spawnDocker([
        "run",
        "--rm",
        "-v",
        `${volume}:${BUS_HOME_IN_CONTAINER}`,
        image,
        "oa-bus",
        "login",
        "--no-color",
        "--instance",
        origin,
        "--no-open",
        "--home",
        BUS_HOME_IN_CONTAINER,
      ]);
      let out = "";
      let err = "";
      let approvalStarted = false;
      let approvalPromise: Promise<void> | null = null;
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(e);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        out += chunk.toString();
        if (approvalStarted) return;
        const code = parseBusLoginApproval(out, origin);
        if (!code) return;
        approvalStarted = true;
        approvalPromise = runner
          .approveBus(
            opts.slug,
            opts.installId,
            opts.hookKey,
            code,
            opts.fetcher,
            opts.launch,
          )
          .catch((e: unknown) => {
            fail(e instanceof Error ? e : new Error(String(e)));
          });
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        err += chunk.toString();
      });
      child.once("error", (e) => fail(e));
      child.once("close", (code) => {
        if (settled) return;
        const finish = () => {
          if (settled) return;
          if (!approvalStarted) {
            settled = true;
            reject(
              new Error(
                `oa-bus login exited (${String(code)}) before printing approval code${err ? `: ${err.trim()}` : ""}`,
              ),
            );
            return;
          }
          if (code !== 0) {
            settled = true;
            reject(
              new Error(
                `oa-bus login failed with exit ${String(code)}${err ? `: ${err.trim()}` : ""}`,
              ),
            );
            return;
          }
          settled = true;
          resolve();
        };
        if (approvalPromise) void approvalPromise.then(finish);
        else finish();
      });
    });

    await runner.docker(
      "run",
      "-d",
      "--name",
      container,
      "-v",
      `${volume}:${BUS_HOME_IN_CONTAINER}`,
      image,
      "oa-bus",
      "daemon",
      "--home",
      BUS_HOME_IN_CONTAINER,
    );

    await new Promise<void>((resolve, reject) => {
      const watch = runner.spawnDocker(
        [
          "exec",
          container,
          "node",
          "-e",
          WATCH_HUB_CONNECT_SCRIPT,
          BUS_HOME_IN_CONTAINER,
        ],
        { signal: AbortSignal.timeout(BUS_CONNECT_TIMEOUT_MS) },
      );
      let err = "";
      watch.stderr?.on("data", (c: Buffer | string) => {
        err += c.toString();
      });
      watch.once("error", (e) => reject(e));
      watch.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `oa-bus daemon did not connect in time (exit ${String(code)})${err ? `: ${err.trim()}` : ""}`,
            ),
          );
      });
    });

    await runner.docker(
      "exec",
      container,
      "oa-bus",
      "status",
      "--home",
      BUS_HOME_IN_CONTAINER,
    );

    return { container, volume, image, version: pin.version };
  } catch (e) {
    let cleanupErr: unknown;
    try {
      await stopFixtureBus(opts.slug, runner.docker);
    } catch (ce) {
      cleanupErr = ce;
    }
    if (cleanupErr) {
      const msg = e instanceof Error ? e.message : String(e);
      const cmsg =
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      throw new Error(`${msg} (bus cleanup also failed: ${cmsg})`);
    }
    throw e;
  }
}

function receiptPath(dir: string, slug: string): string {
  fixtureHost(slug);
  return join(dir, `${slug}.json`);
}

function readReceipt(dir: string, slug: string): FixtureReceipt | null {
  const file = receiptPath(dir, slug);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(
    readFileSync(file, "utf8"),
  ) as Partial<FixtureReceipt>;
  const validInstallId =
    parsed.installId === null ||
    (typeof parsed.installId === "string" &&
      INSTALL_ID_RE.test(parsed.installId));
  const validRepoId =
    parsed.repositoryId === null ||
    (typeof parsed.repositoryId === "string" &&
      /^\d{1,32}$/.test(parsed.repositoryId));
  const validRunId =
    parsed.runId === undefined ||
    parsed.runId === null ||
    (typeof parsed.runId === "string" && /^\d+$/.test(parsed.runId));
  const validRemotePurged =
    parsed.remotePurged === undefined ||
    typeof parsed.remotePurged === "boolean";
  if (
    parsed.slug !== slug ||
    !validInstallId ||
    !validRepoId ||
    !validRunId ||
    !validRemotePurged ||
    typeof parsed.requestId !== "string" ||
    parsed.requestId === "" ||
    typeof parsed.ownerKey?.publicKey !== "string" ||
    typeof parsed.ownerKey?.privateKeyPkcs8 !== "string"
  )
    throw new Error(`corrupt fixture receipt for ${slug}`);
  return parsed as FixtureReceipt;
}

function writeReceipt(dir: string, receipt: FixtureReceipt): string {
  const file = receiptPath(dir, receipt.slug);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  return file;
}

export type Deps = {
  gh: (...args: string[]) => Promise<string>;
  docker: (...args: string[]) => Promise<string>;
  spawnDocker: (
    args: string[],
    options?: SpawnOptionsWithoutStdio,
  ) => ReturnType<typeof spawn>;
  fetch: typeof fetch;
  now: () => number;
  requestId: () => string;
  tmp: string;
  receiptBase: string;
  log: (line: string) => void;
  memberState?: typeof fixtureMemberState;
  approveBus?: typeof approveFixtureBusInBrowser;
  launch?: () => Promise<FixtureBrowser>;
};

async function dispatchWorkflow(
  d: Deps,
  fields: Record<string, string>,
): Promise<string> {
  const id = (
    await d.gh(
      "api",
      "--method",
      "POST",
      `repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "-f",
      "ref=main",
      ...Object.entries(fields).flatMap(([name, value]) => [
        "-f",
        `inputs[${name}]=${value}`,
      ]),
      "--jq",
      ".workflow_run_id // empty",
    )
  ).trim();
  if (!/^\d+$/.test(id))
    throw new Error("the dispatched run's id is not a number");
  return id;
}

async function dispatchAndWait(
  d: Deps,
  fields: Record<string, string>,
): Promise<{ id: string; log: string }> {
  const id = await dispatchWorkflow(d, fields);
  await d.gh("run", "watch", id, "-R", REPO, "--exit-status");
  return { id, log: await d.gh("run", "view", id, "-R", REPO, "--log") };
}

export async function main(argv: readonly string[], d: Deps): Promise<number> {
  const rid = d.requestId();
  let req: FixtureRequest;
  try {
    req = fixtureRequest(argv, rid, true);
  } catch (e) {
    d.log(`${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    return 2;
  }
  if (req.action === "help") {
    d.log(HELP);
    return 0;
  }
  const receiptDir = prepareMcpDir(d.receiptBase);
  if (req.action === "delete") {
    const saved = readReceipt(receiptDir, req.slug);
    if (!saved)
      throw new Error(
        `no saved receipt with owner key for ${req.slug}; cannot sign authenticated cleanup proof`,
      );
    let receipt: FixtureReceipt = saved;
    if (
      req.installId &&
      receipt.installId &&
      receipt.installId !== req.installId
    )
      throw new Error(
        `--install-id ${req.installId} does not match saved receipt ${receipt.installId} for ${req.slug}`,
      );
    let deleteRunId: string | undefined;
    if (!receipt.remotePurged) {
      let installId = receipt.installId;
      let repositoryId = receipt.repositoryId;
      if ((!installId || !repositoryId) && receipt.runId) {
        const createLog = await d.gh(
          "run",
          "view",
          receipt.runId,
          "-R",
          REPO,
          "--log",
        );
        const recovered = parsePartialCreateLog(createLog);
        installId = installId ?? recovered.installId;
        repositoryId = repositoryId ?? recovered.repositoryId;
      }
      if (!installId && req.installId) installId = req.installId;
      if (installId && !repositoryId) {
        const fetchedRepoId = (
          await d.gh("api", `repos/${REPO}`, "--jq", ".id")
        ).trim();
        if (/^\d{1,32}$/.test(fetchedRepoId)) repositoryId = fetchedRepoId;
      }
      if (!installId || !repositoryId)
        throw new Error(
          `cannot recover install ID for ${req.slug} from create run ${receipt.runId ?? "unknown"}; wait for the run log or pass --install-id <id>`,
        );
      if (
        installId !== receipt.installId ||
        repositoryId !== receipt.repositoryId
      ) {
        receipt = { ...receipt, installId, repositoryId };
        writeReceipt(receiptDir, receipt);
      }
      if (req.installId && installId !== req.installId)
        throw new Error(
          `--install-id ${req.installId} does not match saved receipt ${installId} for ${req.slug}`,
        );
      const deleteProof = signOwnerDeleteProof(
        receipt.ownerKey.privateKeyPkcs8,
        {
          repositoryId,
          installId,
          expiresAt: d.now() + DELETE_PROOF_TTL_MS,
        },
      );
      const run = await dispatchAndWait(d, {
        action: "delete",
        slug: req.slug,
        owner_key: receipt.ownerKey.publicKey,
        install_id: installId,
        delete_proof: deleteProof,
        request_id: rid,
      });
      if (!parseDeleteLog(run.log, req.slug, installId))
        throw new Error(`run ${run.id}: purge confirmation missing from log`);
      deleteRunId = run.id;
      // Record remote purge before local Docker cleanup so a volume/container
      // removal error retains state for retrying local cleanup without re-purging.
      receipt = { ...receipt, remotePurged: true };
      writeReceipt(receiptDir, receipt);
    }
    await stopFixtureBus(req.slug, d.docker);
    rmSync(receiptPath(receiptDir, req.slug), { force: true });
    d.log(
      JSON.stringify({
        deleted: req.slug,
        purged: true,
        installId: receipt.installId,
        ...(deleteRunId ? { run: deleteRunId } : {}),
      }),
    );
    return 0;
  }

  if (existsSync(receiptPath(receiptDir, req.slug)))
    throw new Error(
      `fixture receipt already exists for ${req.slug}; run --slug ${req.slug} --delete first`,
    );

  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const ownerKey = generateOwnerKey();
  // Save owner key BEFORE dispatch so an interrupted dispatch, watch, mint,
  // or log read never strands a created staging fixture.
  let receipt: FixtureReceipt = {
    slug: req.slug,
    installId: null,
    repositoryId: null,
    runId: null,
    ownerKey,
    host: req.host,
    ...(req.version === undefined ? {} : { version: req.version }),
    requestId: rid,
    createdAt: d.now(),
  };
  writeReceipt(receiptDir, receipt);

  const runId = await dispatchWorkflow(d, {
    action: "create",
    slug: req.slug,
    owner_key: ownerKey.publicKey,
    recipient_key: pub,
    request_id: rid,
    ...(req.version === undefined ? {} : { version: req.version }),
  });
  receipt = { ...receipt, runId };
  writeReceipt(receiptDir, receipt);

  let watchErr: unknown;
  try {
    await d.gh("run", "watch", runId, "-R", REPO, "--exit-status");
  } catch (e) {
    watchErr = e;
  }

  let log = "";
  try {
    log = await d.gh("run", "view", runId, "-R", REPO, "--log");
  } catch (logErr) {
    if (watchErr) throw watchErr;
    throw logErr;
  }
  const partial = parsePartialCreateLog(log);
  if (partial.installId || partial.repositoryId) {
    receipt = {
      ...receipt,
      installId: partial.installId ?? receipt.installId,
      repositoryId: partial.repositoryId ?? receipt.repositoryId,
    };
    writeReceipt(receiptDir, receipt);
  }
  if (watchErr) throw watchErr;

  const got = parseCreateLog(log, req.slug);
  if (!got)
    throw new Error(`run ${runId}: fixture create output missing from log`);
  const hookKey = hookKeyOnlyOf(
    openSealedNode(privateKey, got.sealed, SEAL_INFO),
  );
  receipt = {
    ...receipt,
    slug: got.slug,
    installId: got.installId,
    repositoryId: got.repositoryId,
    host: got.host,
    version: got.version,
  };
  writeReceipt(receiptDir, receipt);

  const memberStateFn = d.memberState ?? fixtureMemberState;
  const storageState = await memberStateFn(
    got.slug,
    got.installId,
    hookKey,
    d.tmp,
    d.fetch,
    d.launch,
  );
  let bus: FixtureBusInfo | undefined;
  if (req.bus) {
    bus = await startFixtureBus(
      {
        slug: got.slug,
        installId: got.installId,
        hookKey,
        fetcher: d.fetch,
        launch: d.launch,
      },
      {
        docker: d.docker,
        spawnDocker: d.spawnDocker,
        approveBus: d.approveBus ?? approveFixtureBusInBrowser,
      },
    );
    writeReceipt(receiptDir, { ...receipt, bus });
  }
  d.log(
    JSON.stringify({
      slug: got.slug,
      installId: got.installId,
      host: got.host,
      version: got.version,
      run: runId,
      sealedHookKey: got.sealed,
      storageState,
      ...(bus ? { bus } : {}),
    }),
  );
  return 0;
}

const execCmd =
  (bin: string) =>
  async (...args: string[]) =>
    (await execFile(bin, args, { maxBuffer: 16 << 20 })).stdout;

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv.slice(2), {
    gh: execCmd("gh"),
    docker: execCmd("docker"),
    spawnDocker: (args, options) => spawn("docker", args, options),
    fetch: globalThis.fetch,
    now: Date.now,
    requestId: () => `fixture-${randomUUID()}`,
    tmp: tmpdir(),
    receiptBase: RECEIPT_BASE,
    log: (l) => console.log(l),
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
