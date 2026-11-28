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
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
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
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID_RE = "[A-Za-z0-9_-]{1,64}";
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

// The receipt comes from this fixture's successful create. Use its immutable
// install ID for both jobs, including retries after a soft delete.
export type FixtureReceipt = {
  slug: string;
  installId: string;
  requestId: string;
  host?: string;
  version?: string;
  createdAt?: number;
  bus?: FixtureBusInfo;
};

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
  receipt: Pick<FixtureReceipt, "slug" | "installId" | "requestId">,
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

function markerValue(
  log: string,
  marker: string,
  value: string,
): string | null {
  const re = new RegExp(
    `(?:^|\\s)test-install-${marker}: (${value})(?=\\s|$)`,
    "gm",
  );
  const found = new Set(Array.from(log.matchAll(re), (m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}

export type CreateLog = {
  installId: string;
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
  const installId = markerValue(log, "id", JOB_ID_RE);
  const slug = markerValue(log, "slug", "[a-z0-9-]+");
  const host = markerValue(log, "app-host", "[a-z0-9.-]+");
  const version = markerValue(log, "version", "[0-9]+\\.[0-9]+\\.[0-9]+");
  const createJob = markerValue(log, "create-job", JOB_ID_RE);
  const credsJob = markerValue(log, "creds-job", JOB_ID_RE);
  const sealed = markerValue(log, "sealed", "oa-seal-v1\\.[A-Za-z0-9_.-]+");
  if (
    !installId ||
    slug !== expectedSlug ||
    host !== expectedHost ||
    !version ||
    !createJob ||
    !credsJob ||
    !sealed
  )
    return null;
  return { installId, slug, host, version, createJob, credsJob, sealed };
}

/** True when a delete run's log confirms the exact install was purged. */
export function parseDeleteLog(
  log: string,
  expectedSlug: string,
  expectedInstallId: string,
): boolean {
  return (
    markerValue(log, "id", JOB_ID_RE) === expectedInstallId &&
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

export async function stopFixtureBus(
  slug: string,
  docker: (...args: string[]) => Promise<string>,
): Promise<void> {
  const { container, volume } = busNames(slug);
  await docker("rm", "-f", container).catch(() => "");
  await docker("volume", "rm", "-f", volume).catch(() => "");
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
    const codeRe = new RegExp(
      `Open ${escapeRegExp(origin)}/bus/approve and type this code to approve this machine: ([A-Z0-9]{4}-[A-Z0-9]{4})`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = runner.spawnDocker([
        "run",
        "--rm",
        "-v",
        `${volume}:${BUS_HOME_IN_CONTAINER}`,
        image,
        "oa-bus",
        "login",
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
        const m = codeRe.exec(out);
        if (!m?.[1]) return;
        approvalStarted = true;
        approvalPromise = runner
          .approveBus(
            opts.slug,
            opts.installId,
            opts.hookKey,
            m[1],
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
    await stopFixtureBus(opts.slug, runner.docker);
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
  if (
    parsed.slug !== slug ||
    typeof parsed.installId !== "string" ||
    !INSTALL_ID_RE.test(parsed.installId)
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

async function dispatchAndWait(
  d: Deps,
  fields: Record<string, string>,
): Promise<{ id: string; log: string }> {
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
    if (saved && req.installId && saved.installId !== req.installId)
      throw new Error(
        `--install-id ${req.installId} does not match saved receipt ${saved.installId} for ${req.slug}`,
      );
    const installId = req.installId ?? saved?.installId;
    if (!installId)
      throw new Error(
        `no saved receipt for ${req.slug}; pass --install-id <id> to delete and purge it`,
      );
    await stopFixtureBus(req.slug, d.docker);
    const run = await dispatchAndWait(d, {
      action: "delete",
      slug: req.slug,
      install_id: installId,
      request_id: rid,
    });
    if (!parseDeleteLog(run.log, req.slug, installId))
      throw new Error(`run ${run.id}: purge confirmation missing from log`);
    if (saved) rmSync(receiptPath(receiptDir, req.slug), { force: true });
    d.log(
      JSON.stringify({
        deleted: req.slug,
        purged: true,
        installId,
        run: run.id,
      }),
    );
    return 0;
  }

  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const run = await dispatchAndWait(d, {
    action: "create",
    slug: req.slug,
    recipient_key: pub,
    request_id: rid,
    ...(req.version === undefined ? {} : { version: req.version }),
  });
  const got = parseCreateLog(run.log, req.slug);
  if (!got)
    throw new Error(`run ${run.id}: fixture create output missing from log`);
  const hookKey = hookKeyOnlyOf(
    openSealedNode(privateKey, got.sealed, SEAL_INFO),
  );
  // Save receipt before browser/bus steps so a partial failure can still be
  // cleaned up with --delete without losing the immutable install ID.
  const receipt: FixtureReceipt = {
    slug: got.slug,
    installId: got.installId,
    host: got.host,
    version: got.version,
    requestId: rid,
    createdAt: d.now(),
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
      run: run.id,
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
