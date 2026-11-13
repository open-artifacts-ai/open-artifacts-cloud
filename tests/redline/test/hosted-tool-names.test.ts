import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOSTED_TOOL_NAMES } from "../src/provisioning.ts";

const src = (rel: string) =>
  readFileSync(
    new URL(`../../../apps/provisioning/src/${rel}`, import.meta.url),
    "utf8",
  );

/**
 * Names of the HOSTED_TOOLS entries, plus how many top-level entries the array
 * holds. An entry in a form this parser cannot name still counts in `elements`,
 * so the two disagree and the caller fails instead of skipping it.
 * `consts` maps NAME -> "value" and "OBJ.key" -> "value" for string constants.
 */
function parseHostedTools(
  source: string,
  consts: ReadonlyMap<string, string>,
): { names: string[]; elements: number } {
  const start = source.indexOf("export const HOSTED_TOOLS");
  if (start < 0) throw new Error("HOSTED_TOOLS not found");
  const rest = source.slice(start);
  const open = rest.indexOf("= [");
  const close = rest.search(/^\];/m);
  if (open < 0 || close < 0) throw new Error("HOSTED_TOOLS array not found");
  const body = rest.slice(open + 3, close);
  const resolve = (lit: string | undefined, ref: string | undefined) =>
    lit ?? (ref === undefined ? undefined : consts.get(ref));
  const names: string[] = [];
  for (const m of body.matchAll(
    /^ {2}betaTool\(\s*(?:"([^"]+)"|([\w.]+))\s*,/gm,
  )) {
    const n = resolve(m[1], m[2]);
    if (n) names.push(n);
  }
  for (const m of body.matchAll(/^ {4}name: (?:"([^"]+)"|([\w.]+)),/gm)) {
    const n = resolve(m[1], m[2]);
    if (n) names.push(n);
  }
  // Top-level elements start at the array's first indentation level.
  const elements = body
    .split("\n")
    .filter((l) => /^ {2}[^\s)}\]/]/.test(l)).length;
  return { names, elements };
}

function constsFrom(...texts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of texts) {
    for (const m of t.matchAll(/export const (\w+) = "([^"]+)"/g)) {
      out.set(m[1] as string, m[2] as string);
    }
    for (const o of t.matchAll(/export const (\w+) = \{([^}]*)\} as const/g)) {
      for (const k of (o[2] as string).matchAll(/(\w+):\s*"([^"]+)"/g)) {
        out.set(`${o[1]}.${k[1]}`, k[2] as string);
      }
    }
  }
  return out;
}

describe("HOSTED_TOOL_NAMES", () => {
  it("matches the names in apps/provisioning HOSTED_TOOLS", () => {
    const { names, elements } = parseHostedTools(
      src("hosted-tools.ts"),
      constsFrom(
        src("routes/set-tier.ts"),
        src("routes/beta.ts"),
        src("routes/business.ts"),
      ),
    );
    expect(names.length).toBeGreaterThan(0);
    // Every entry must be named: an unparsed form fails here, not silently.
    expect(names.length).toBe(elements);
    expect([...HOSTED_TOOL_NAMES].sort()).toEqual([...names].sort());
  });

  it("names betaTool entries with a literal on the next line", () => {
    const r = parseHostedTools(
      `export const HOSTED_TOOLS = [\n  betaTool(\n    "a_tool",\n    "d",\n  ),\n  {\n    name: "b_tool",\n  },\n];\n`,
      new Map(),
    );
    expect(r).toEqual({ names: ["a_tool", "b_tool"], elements: 2 });
  });

  it("fails the count check on an entry form it cannot name", () => {
    const r = parseHostedTools(
      `export const HOSTED_TOOLS = [\n  {\n    name: "b_tool",\n  },\n  otherTool(\n    "x",\n  ),\n];\n`,
      new Map(),
    );
    expect(r.names).toEqual(["b_tool"]);
    expect(r.elements).toBe(2);
    expect(r.names.length).not.toBe(r.elements);
  });
});
