import { expect, it, vi } from "vitest";
import {
  approveFixtureBusInBrowser,
  fixtureHost,
  fixtureMemberState,
  parseBusPinFromLlms,
} from "./staging-fixture-session.ts";

it.each(["rl-agents", "rl-a", "t-a.example", "t-X", "t-a/b", "t-"])(
  "rejects non-fixture slug %s before a request",
  (slug) => {
    expect(() => fixtureHost(slug)).toThrow();
  },
);

it.each([
  { testHooks: false, installId: "mine" },
  { testHooks: true, installId: "another" },
])(
  "checks the provisioned identity before sending credentials",
  async (target) => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, ...target }));
    await expect(
      fixtureMemberState("t-new", "mine", "key", "unused", fetcher),
    ).rejects.toThrow("fixture identity mismatch");
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://t-new.open-artifacts-staging.app/healthz",
      { redirect: "error" },
    );
  },
);

it("parses the exact bus release version and integrity from /llms.txt", () => {
  const llms = [
    "```sh",
    'tmp=$(mktemp -d) && cd "$tmp" &&',
    "npm install --ignore-scripts --registry https://registry.npmjs.org @open-artifacts/bus@0.12.3 &&",
    'node -e \'const l=require("./package-lock.json").packages||{};const k=Object.keys(l).filter(x=>x!=="");const p=l["node_modules/@open-artifacts/bus"];const ok=k.length===1&&p&&p.version==="0.12.3"&&p.integrity==="sha512-abcDEF123+/==";process.exit(ok?0:1)\'',
    "```",
  ].join("\n");
  expect(parseBusPinFromLlms(llms)).toEqual({
    version: "0.12.3",
    integrity: "sha512-abcDEF123+/==",
  });
  expect(() => parseBusPinFromLlms("no verified release")).toThrow(
    "no verified @open-artifacts/bus pin",
  );
});

it("refuses malformed bus approval codes before any network call", async () => {
  const fetcher = vi.fn();
  for (const bad of ["", "abcd-1234", "ABCD1234", "ABCD-12345"])
    await expect(
      approveFixtureBusInBrowser("t-new", "mine", "key", bad, fetcher),
    ).rejects.toThrow("XXXX-XXXX");
  expect(fetcher).not.toHaveBeenCalled();
});
