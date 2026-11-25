// A gh call that survives a transient GitHub 5xx. Reads retry (3 attempts, 2 s
// then 5 s apart); writes run once, because a retried write may repeat itself,
// unless the caller marks the write idempotent (the same call twice ends in the
// same state, such as enabling auto-merge pinned to a head sha).
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

// gh prints "HTTP 502" from its REST client, and "non-200 OK status code: 502
// Bad Gateway" from GraphQL (as `gh pr merge` did on 11-25, run 45648881455).
const TRANSIENT =
  /HTTP 50[0234]|status code: 50[0234]|Server Error|timed? ?out|timeout|connection reset|\bEOF\b/i;

export const BACKOFF_MS = [2000, 5000];

export const sleeper = {
  sleep(ms: number): void {
    if (ms > 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

export function gh(
  exec: Exec,
  args: string[],
  opts: { write?: boolean; idempotent?: boolean } = {},
): string {
  const attempts = opts.write && !opts.idempotent ? 1 : BACKOFF_MS.length + 1;
  for (let i = 0; ; i++) {
    const r = exec("gh", args);
    if (r.code === 0) return r.stdout;
    if (i + 1 < attempts && TRANSIENT.test(r.stderr)) {
      sleeper.sleep(BACKOFF_MS[i] ?? 0);
      continue;
    }
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  }
}
