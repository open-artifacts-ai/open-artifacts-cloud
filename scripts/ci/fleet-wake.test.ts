import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// fleet-wake.sh (cloud #264): one message to the env's oa-<p>-fleet-wake once
// the platform is marked verified. The wake is the rollout's first event, so
// a wake not sent fails the step (exit 1, one ::error:: line); a failed
// listing or post is retried with a backoff first (the Prover's #492 case:
// a 503 must not exit 0).
const SCRIPT = script("fleet-wake.sh");
const TOK = "cfut_WAKE_token_never_printed_0123";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const QID = "0123456789abcdef0123456789abcdef";

// curl: the -K - config must carry the token; GET answers from queues.json,
// POST from post.json (no file: success). Posts are logged with their body.
const curl = `cfg="$(cat)"
case "$cfg" in *"Bearer $TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"code":10000}]}'; exit 0 ;; esac
[ -f "$STATE/net-fail" ] && exit 7
# fail-n: the first n calls answer 503 (a failed call), then as usual.
if [ -f "$STATE/fail-n" ]; then
  n="$(cat "$STATE/fail-n")"
  if [ "$n" -gt 0 ]; then
    echo $((n - 1)) > "$STATE/fail-n"
    echo "FAIL" >> "$STUB_LOG"
    echo '{"success":false,"errors":[{"code":503,"message":"Service Unavailable"}]}'
    exit 0
  fi
fi
m=GET; body=""
for ((i = 1; i <= $#; i++)); do
  case "\${!i}" in
    -X) j=$((i + 1)); m="\${!j}" ;;
    --data-binary) j=$((i + 1)); body="\${!j}" ;;
  esac
done
url="\${@: -1}"
if [ "$m" = POST ]; then
  echo "POST $url $body" >> "$STUB_LOG"
  cat "$STATE/post.json" 2>/dev/null || echo '{"success":true,"result":null}'
else
  page="\${url##*page=}"
  if [ -f "$STATE/queues-$page.json" ]; then cat "$STATE/queues-$page.json"; else cat "$STATE/queues.json"; fi
fi`;
const listing = (
  queues: { queue_name: string; queue_id?: string }[],
  pages = 1,
) =>
  JSON.stringify({
    success: true,
    result: queues,
    result_info: { total_count: queues.length, total_pages: pages },
  });
const WAKE = [
  { queue_name: "oa-p-signups", queue_id: "f".repeat(32) },
  { queue_name: "oa-p-fleet-wake", queue_id: QID },
  { queue_name: "oa-s-fleet-wake", queue_id: "e".repeat(32) },
];
const run = (
  o: {
    queues?: string;
    /** Page n of the listing (1-based), each its own answer. */
    pages?: readonly string[];
    post?: string;
    netFail?: boolean;
    /** The first n calls answer a 503. */
    failFirst?: number;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  } = {},
) => {
  const sb = sandbox({ curl });
  writeFileSync(join(sb.dir, "queues.json"), o.queues ?? listing(WAKE));
  for (const [i, p] of (o.pages ?? []).entries())
    writeFileSync(join(sb.dir, `queues-${i + 1}.json`), p);
  if (o.post) writeFileSync(join(sb.dir, "post.json"), o.post);
  if (o.netFail) writeFileSync(join(sb.dir, "net-fail"), "");
  if (o.failFirst) writeFileSync(join(sb.dir, "fail-n"), String(o.failFirst));
  const r = sb.run(["bash", SCRIPT, ...(o.args ?? ["prod", "v1.2.3"])], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      // The backoff's base: no real wait in a test.
      WAKE_RETRY_SLEEP: "0",
      ...o.env,
    },
  });
  const log = sb.log();
  expect([r.out, r.err, ...log].join("\n")).not.toContain(TOK);
  return { ...r, log, posts: log.filter((l) => l.startsWith("POST ")) };
};

describe("fleet-wake.sh", () => {
  it("posts one message to the env's queue, by its id, naming the env and tag", () => {
    const r = run();
    expect(r.code, r.err).toBe(0);
    expect(r.posts).toEqual([
      `POST https://api.cloudflare.com/client/v4/accounts/${ACCT}/queues/${QID}/messages {"body":{"env":"prod","tag":"v1.2.3"}}`,
    ]);
    expect(r.out).toContain("fleet wake sent to oa-p-fleet-wake for v1.2.3");
    expect(r.out).not.toContain("::warning::");
    // The listing is one page of 100, the token on stdin only.
    expect(r.log).toContain(
      `curl -sS --max-time 20 -K - https://api.cloudflare.com/client/v4/accounts/${ACCT}/queues?per_page=100&page=1`,
    );
    // Staging posts to staging's queue, never prod's.
    const s = run({ args: ["staging", "v1.2.3"] });
    expect(s.code).toBe(0);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toContain(`/queues/${"e".repeat(32)}/messages`);
  });

  it("a two-page listing (the Prover's case): reads every page and posts once, whichever page names the queue", () => {
    const other = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        queue_name: `other-${i}`,
        queue_id: i.toString(16).padStart(32, "0"),
      }));
    const mine = WAKE[1] as (typeof WAKE)[number];
    for (const [pages, where] of [
      [[listing([mine, ...other(99)], 2), listing(other(3), 2)], "page 1"],
      [[listing(other(100), 2), listing([...other(2), mine], 2)], "page 2"],
      // No total_pages: a full page means read on; a short one ends it.
      [
        [
          JSON.stringify({ success: true, result: other(100) }),
          JSON.stringify({ success: true, result: [mine] }),
        ],
        "page 2, no result_info",
      ],
    ] as const) {
      const r = run({ pages: [...pages] });
      expect(r.code, where).toBe(0);
      expect(r.out, where).not.toContain("::warning::");
      expect(r.posts, where).toEqual([
        `POST https://api.cloudflare.com/client/v4/accounts/${ACCT}/queues/${QID}/messages {"body":{"env":"prod","tag":"v1.2.3"}}`,
      ]);
      expect(
        r.log.filter((l) => l.startsWith("curl") && l.includes("/queues?")),
        where,
      ).toEqual([1, 2].map((p) => expect.stringContaining(`page=${p}`)));
    }
  });

  const warned = (r: ReturnType<typeof run>, why: string) => {
    expect(r.code, r.err).toBe(1);
    expect(r.out).toContain("::error::fleet wake not sent:");
    expect(r.out).toContain(why);
    expect(r.out).not.toContain("fleet wake sent to");
  };

  it("a post that keeps failing is retried WAKE_TRIES times, then fails the step: never exit 0", () => {
    const r = run({
      post: '{"success":false,"errors":[{"code":10001,"message":"x"}]}',
    });
    expect(r.posts).toHaveLength(5);
    warned(r, "posting to oa-p-fleet-wake failed");
    expect(r.out).toContain("(try 5 of 5)");
    warned(run({ post: "not json" }), "unparsable response");
  });

  it("a 503 then a success: the backoff's retry sends it, exit 0 (the Prover's #492 case)", () => {
    const r = run({ failFirst: 2 });
    expect(r.code, r.err).toBe(0);
    expect(r.log.filter((l) => l === "FAIL")).toHaveLength(2);
    expect(r.posts).toHaveLength(1);
    expect(r.out).toContain("try 2 of 5 in 0s");
    expect(r.out).toContain("try 3 of 5 in 0s");
    expect(r.out).toContain("fleet wake sent to oa-p-fleet-wake for v1.2.3");
  });

  it("a 503 on every call fails the step after its retries", () => {
    const r = run({ failFirst: 99 });
    expect(r.posts).toEqual([]);
    warned(r, "listing the queues failed");
    expect(r.out).toContain("(try 5 of 5)");
  });

  it("no queue yet, two of them, a paged or failed listing, or no network: posts nothing, fails the step", () => {
    for (const [o, why] of [
      [
        {
          queues: listing(
            WAKE.filter((q) => q.queue_name !== "oa-p-fleet-wake"),
          ),
        },
        "want exactly one queue oa-p-fleet-wake",
      ],
      [
        {
          queues: listing([
            ...WAKE,
            { queue_name: "oa-p-fleet-wake", queue_id: "a".repeat(32) },
          ]),
        },
        "want exactly one queue oa-p-fleet-wake",
      ],
      [
        {
          queues: listing([
            { queue_name: "oa-p-fleet-wake", queue_id: "bad id" },
          ]),
        },
        "want exactly one queue oa-p-fleet-wake",
      ],
      [
        // The same queue named on two pages is two queues.
        {
          pages: [
            listing([WAKE[1] as (typeof WAKE)[number]], 2),
            listing([WAKE[1] as (typeof WAKE)[number]], 2),
          ],
        },
        "want exactly one queue oa-p-fleet-wake",
      ],
      [
        {
          pages: [
            listing([WAKE[0] as (typeof WAKE)[number]], 2),
            '{"success":false,"errors":[{"code":10000}]}',
          ],
        },
        "listing the queues failed",
      ],
      [
        { queues: '{"success":false,"errors":[{"code":10000}]}' },
        "listing the queues failed",
      ],
      [{ netFail: true }, "listing the queues failed (network)"],
    ] as const) {
      const r = run(o);
      expect(r.posts, why).toEqual([]);
      warned(r, why);
    }
  });

  it("bad inputs fail the step before any call", () => {
    for (const [o, why] of [
      [{ args: ["dev", "v1.2.3"] }, "env must be staging or prod"],
      [{ args: ["prod", "1.2.3"] }, "the tag must be vX.Y.Z"],
      [{ args: ["prod"] }, "usage"],
      [{ env: { CLOUDFLARE_ACCOUNT_ID: "nope" } }, "CLOUDFLARE_ACCOUNT_ID"],
      [{ env: { CLOUDFLARE_API_TOKEN: "" } }, "CLOUDFLARE_API_TOKEN"],
      [{ env: { CLOUDFLARE_API_TOKEN: 'a"b' } }, "CLOUDFLARE_API_TOKEN"],
      [{ env: { WAKE_TRIES: "0" } }, "WAKE_TRIES"],
      [{ env: { WAKE_RETRY_SLEEP: "1s" } }, "WAKE_RETRY_SLEEP"],
    ] as const) {
      const r = run(o);
      expect(
        r.log.filter((l) => l.startsWith("curl")),
        why,
      ).toEqual([]);
      warned(r, why);
    }
  });
});
