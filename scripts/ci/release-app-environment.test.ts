// #302: the release App key lives in the main-only Environment `release-app`.
// Every job that mints the App token declares it; no other job reads the secrets.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github/workflows",
);

// Split a workflow into its jobs by the two-space-indented keys under `jobs:`.
function jobs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.split(/^jobs:\s*$/m)[1] ?? "";
  let name = "";
  for (const line of body.split("\n")) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      name = m[1] as string;
      out.set(name, "");
    } else if (name) out.set(name, `${out.get(name)}${line}\n`);
  }
  return out;
}

describe("release App key environment", () => {
  // Public-repo workflows present in the overlay; they belong to the public
  // repo's own secrets, not this one.
  const PUBLIC_ONLY = ["release-cadence.yml", "release-please.yml"];
  const files = readdirSync(dir).filter(
    (f) => /\.ya?ml$/.test(f) && !PUBLIC_ONLY.includes(f),
  );
  const all = files.flatMap((f) =>
    [...jobs(readFileSync(join(dir, f), "utf8"))].map(([n, b]) => ({
      id: `${f}:${n}`,
      b,
    })),
  );

  it("finds the minting jobs", () => {
    expect(
      all.filter((j) => j.b.includes("create-github-app-token")).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("every job minting the token declares environment: release-app", () => {
    for (const j of all.filter((j) => j.b.includes("create-github-app-token")))
      expect(j.b, j.id).toMatch(/^ {4}environment: release-app\s*$/m);
  });

  it("no other job references the RELEASE_APP_* secrets", () => {
    for (const j of all.filter((j) => !j.b.includes("create-github-app-token")))
      expect(j.b, j.id).not.toMatch(/RELEASE_APP_/);
  });

  it("no workflow reads them outside a job", () => {
    for (const f of files) {
      const head = readFileSync(join(dir, f), "utf8").split(/^jobs:\s*$/m)[0];
      expect(head, f).not.toMatch(/RELEASE_APP_/);
    }
  });
});
