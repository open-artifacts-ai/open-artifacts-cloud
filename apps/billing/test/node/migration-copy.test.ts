import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("the tier store's migration", () => {
  it("packages/billing-core's test copy of each migration is byte-identical to the app's (L2)", () => {
    const files = readdirSync(join(app, "migrations")).sort();
    expect(
      readdirSync(
        join(app, "../../packages/billing-core/test/migrations"),
      ).sort(),
    ).toEqual(files);
    for (const f of files) {
      const real = readFileSync(join(app, "migrations", f));
      const copy = readFileSync(
        join(app, "../../packages/billing-core/test/migrations", f),
      );
      expect(copy.equals(real), f).toBe(true);
    }
  });
});
