import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOSTED_TOOL_NAMES } from "../src/provisioning.ts";

const src = (rel: string) =>
  readFileSync(
    new URL(`../../../apps/provisioning/src/${rel}`, import.meta.url),
    "utf8",
  );

describe("HOSTED_TOOL_NAMES", () => {
  it("matches the names in apps/provisioning HOSTED_TOOLS", () => {
    const tools = src("hosted-tools.ts");
    const body = tools.slice(tools.indexOf("export const HOSTED_TOOLS"));
    const consts = new Map(
      [
        ...src("routes/set-tier.ts").matchAll(
          /export const (\w+_TOOL) = "([^"]+)"/g,
        ),
      ].map((m) => [m[1], m[2]] as const),
    );
    const names = [...body.matchAll(/^ {4}name: (?:"([^"]+)"|(\w+)),/gm)].map(
      (m) => m[1] ?? consts.get(m[2] as string),
    );
    expect(names.length).toBeGreaterThan(0);
    expect([...HOSTED_TOOL_NAMES].sort()).toEqual([...names].sort());
  });
});
