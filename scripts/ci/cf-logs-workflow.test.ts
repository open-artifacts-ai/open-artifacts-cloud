// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// cf-logs.yml: one Worker's logs as counts, by hand, from the read-only token.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const text = readFileSync(join(root, ".github/workflows/cf-logs.yml"), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.logs;

describe("cf-logs.yml", () => {
	it("runs on dispatch only, with no permissions, in cf-read", () => {
		expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
		expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
			"worker",
			"since",
			"minutes",
			"filter",
		]);
		expect(w.on.workflow_dispatch.inputs.filter.options).toEqual([
			"errors",
			"status5xx",
			"all",
		]);
		expect(w.permissions).toEqual({});
		expect(job.environment).toBe("cf-read");
		expect(job["timeout-minutes"]).toBeLessThanOrEqual(5);
		expect(text).not.toContain("actions/checkout");
	});

	it("fails closed: bash, pipefail, every run step", () => {
		for (const s of job.steps) {
			expect(s.shell).toBe("bash");
			expect(s.run.startsWith("set -euo pipefail\n")).toBe(true);
		}
	});

	it("refuses a multi-line worker input", () => {
		const run = (worker: string) =>
			spawnSync("bash", ["-c", job.steps[0].run], {
				env: {
					PATH: process.env.PATH,
					WORKER: worker,
					SINCE: "2026-11-18T10:00:00Z",
					MINUTES: "30",
				},
			}).status;
		expect(run("oa-p-x")).toBe(0);
		expect(run("oa-p-x\nevil")).not.toBe(0);
		expect(run("evil\noa-p-x")).not.toBe(0);
		expect(run("oa-p-x\n")).not.toBe(0);
	});

	it("allowlists the worker and bounds minutes", () => {
		expect(text).toContain(
			"^(oa-[ps]-[a-z0-9-]+|open-artifacts-(prod|staging))$",
		);
		expect(text).toContain("<= 120");
	});

	it("passes inputs through env, never into the script text", () => {
		for (const s of job.steps) expect(s.run).not.toMatch(/\$\{\{/);
	});

	it("redacts before printing and names the failing call", () => {
		expect(text).toContain("redact()");
		expect(text).toContain("<email>");
		expect(text).toContain("<tok>");
		expect(text).toContain("<ip>");
		expect(text).toContain("?<q>");
		expect(text).toContain("Cloudflare error code");
		expect(text).not.toMatch(/cat resp\.json|jq \. resp\.json/);
	});
});
