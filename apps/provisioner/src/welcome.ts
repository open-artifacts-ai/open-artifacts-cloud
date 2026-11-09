// The one welcome email of a signup: HTML (light and dark) plus a plain-text
// part with the same words. Design 7CxwnXWcrSa9m51S, section 2, option A.
// Every link points at the install's own app host and carries no token or
// secret; the owner signs in on the install's own sign-in page.

export interface Welcome {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Dec 9" (UTC), or null for a missing or invalid date. */
function trialEndLabel(d: Date | number | undefined): string | null {
  if (d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Strips control characters (CR/LF included) so a value can't inject headers. */
const oneLine = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").trim();

export function welcomeEmail(o: {
  from: string;
  to: string;
  appHost: string;
  /** End of the Solo trial. Absent until the trial is wired: no date is named. */
  trialEndsAt?: Date | number;
}): Welcome {
  const url = new URL(`https://${o.appHost}/`);
  if (url.host !== o.appHost.toLowerCase()) throw new Error("invalid app host");
  const host = url.host;
  const origin = url.origin;
  const to = oneLine(o.to);
  const end = trialEndLabel(o.trialEndsAt);

  const lines = {
    title: "Your Open Artifacts is ready",
    intro: `${host} is set up and you're its owner. Sign in with the Google account you used to create it, ${to}.`,
    button: `Open ${host}`,
    connect: "Then connect your agent.",
    paste: "Paste this into Claude Code, Cursor or any AI agent:",
    prompt: [
      `Set up Open Artifacts for me: follow ${origin}/llms.txt`,
      "Sign in through the browser. Never ask me to paste a token into this chat.",
    ],
    plan: end
      ? `You're on Solo: free until ${end}, then $1/month or $12/year. No card on file; we'll remind you a week before.`
      : "You're on Solo: free for your first month, then $1/month or $12/year. No card on file; we'll remind you a week before.",
    why: `You got this because you created ${host}.`,
  };

  const text = [
    lines.title,
    "",
    lines.intro,
    "",
    `${lines.button}: ${origin}/`,
    "",
    `${lines.connect} ${lines.paste}`,
    "",
    ...lines.prompt.map((l) => `  ${l}`),
    "",
    lines.plan,
    "",
    lines.why,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(lines.title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:24px 12px;background:#eef0f3;color:#15181c}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #bec4cd;border-radius:8px;padding:24px 28px}
.t2{color:#454c56}.muted{color:#5f6670}
.btn{display:inline-block;background:#15181c;color:#fff!important;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px}
.pre{background:#eceef1;border:1px solid #e0e3e8;border-radius:6px;padding:10px 12px;color:#15181c}
.rule{border:0;border-top:1px solid #e0e3e8;margin:16px 0 12px}
@media (prefers-color-scheme: dark){
body{background:#131518!important;color:#e9ebee!important}
.card{background:#1c1f23!important;border-color:#3b414a!important}
.t2{color:#b7bdc6!important}.muted{color:#9097a1!important}
.btn{background:#e9ebee!important;color:#131518!important}
.pre{background:#181a1e!important;border-color:#2c3037!important;color:#e9ebee!important}
.rule{border-top-color:#2c3037!important}
}
</style></head>
<body style="margin:0;padding:24px 12px;background:#eef0f3;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div class="card" style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #bec4cd;border-radius:8px;padding:24px 28px">
<p style="margin:0 0 22px;font-weight:700;font-size:15px"><img src="${esc(`${origin}/email/logo@2x.png`)}" alt="" width="18" height="18" style="vertical-align:-3px;margin-right:8px">Open Artifacts</p>
<h1 style="font-size:19px;line-height:1.35;margin:0 0 10px">${esc(lines.title)}</h1>
<p class="t2" style="margin:0 0 10px">${esc(lines.intro)}</p>
<p style="margin:6px 0 18px"><a class="btn" href="${esc(`${origin}/`)}" style="display:inline-block;background:#15181c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">${esc(lines.button)}</a></p>
<p class="t2" style="margin:0 0 10px"><strong>${esc(lines.connect)}</strong> ${esc(lines.paste)}</p>
<pre class="pre" style="white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eceef1;border:1px solid #e0e3e8;border-radius:6px;padding:10px 12px;margin:6px 0 14px">${lines.prompt.map(esc).join("\n")}</pre>
<hr class="rule" style="border:0;border-top:1px solid #e0e3e8;margin:16px 0 12px">
<p class="muted" style="margin:0 0 10px;font-size:12.5px">${esc(lines.plan)}</p>
<p class="muted" style="margin:0;font-size:12.5px">${esc(lines.why)}</p>
</div>
</body></html>
`;

  return {
    from: o.from,
    to: o.to,
    subject: `${host} is ready`,
    text,
    html,
  };
}
