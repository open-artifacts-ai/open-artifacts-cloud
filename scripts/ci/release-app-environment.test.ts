// #302: the release App key lives in the main-only Environment `release-app`.
// Every job that mints the App token declares it; no other job reads the secrets.
// The one exception (cloud #264): pin-bump.yml's land job mints its own App's
// token (PIN_LAND_APP_*, Environment `pin-land`), the only bypass actor on main.
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

  const LAND = "pin-bump.yml:land";

  it("every job minting the token declares environment: release-app", () => {
    for (const j of all.filter(
      (j) => j.b.includes("create-github-app-token") && j.id !== LAND,
    ))
      expect(j.b, j.id).toMatch(/^ {4}environment: release-app\s*$/m);
  });

  it("no other job references the RELEASE_APP_* secrets", () => {
    for (const j of all.filter(
      (j) => !j.b.includes("create-github-app-token") || j.id === LAND,
    ))
      expect(j.b, j.id).not.toMatch(/RELEASE_APP_/);
  });

  it("land mints only the land App, in Environment pin-land, and no other job sees it", () => {
    const land = all.find((j) => j.id === LAND);
    expect(land?.b).toMatch(/^ {4}environment: pin-land\s*$/m);
    expect(land?.b).toContain("secrets.PIN_LAND_APP_ID");
    expect(land?.b).toContain("secrets.PIN_LAND_APP_PRIVATE_KEY");
    for (const j of all.filter((j) => j.id !== LAND)) {
      expect(j.b, j.id).not.toMatch(/PIN_LAND_APP_/);
      expect(j.b, j.id).not.toMatch(/^ {4}environment: pin-land\s*$/m);
    }
  });

  it("no workflow reads them outside a job", () => {
    for (const f of files) {
      const head = readFileSync(join(dir, f), "utf8").split(/^jobs:\s*$/m)[0];
      expect(head, f).not.toMatch(/RELEASE_APP_|secrets\.PIN_LAND_APP_/);
    }
  });
});
