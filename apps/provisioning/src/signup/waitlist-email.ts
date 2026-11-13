import {
  ADDRESS_RE,
  esc,
  NOLINK,
  REPLY_TO,
  SENDER_NAME,
  sanitizeAddress,
} from "./approval-email.js";

// The email a person gets when they join the private-beta waitlist (#2460).
// Same design B as the approval email: brand row, heading, one block, footer.
// Words are Product's, final.

export const WAITLIST_SUBJECT = "You're on the Open Artifacts waitlist";
export const WAITLIST_PREHEADER = "We'll email you when it's your turn.";
export const SELF_HOST_URL = "https://open-artifacts.com/docs/setup/";

const HEADLINE = "You're on the list";
const BODY =
  "Thanks for joining. Open Artifacts is in private beta, and we're letting people in a few at a time. We'll email you at this address when it's your turn.";
const SELF_HOST =
  "Don't want to wait? Open Artifacts is open source, and you can run it yourself today.";
const SELF_HOST_LINK = "Run it yourself";
const footer1 = (host: string): string =>
  `You're getting this because you joined the waitlist at ${host}.`;
const FOOTER2 = "If that wasn't you, you can ignore this email.";

export interface WaitlistEmail {
  from: { email: string; name: string };
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Splits the host at its first dot so mail apps don't autolink it. */
const plainHost = (host: string): string => {
  const i = host.indexOf(".");
  return i < 0
    ? esc(host)
    : `${esc(host.slice(0, i))}<span style="${NOLINK}">.</span>${esc(host.slice(i + 1))}`;
};

export function waitlistEmail(o: {
  from: string;
  to: string;
  /** The sign-up host the request came to (URL.host). */
  host: string;
}): WaitlistEmail {
  const to = sanitizeAddress(o.to);
  const text = [
    HEADLINE,
    "",
    BODY,
    "",
    SELF_HOST,
    `${SELF_HOST_LINK}: ${SELF_HOST_URL}`,
    "",
    footer1(o.host),
    FOOTER2,
  ].join("\n");
  const FONT =
    "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>${esc(WAITLIST_SUBJECT)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media only screen and (max-width: 600px) {
    .oa-outer { padding: 20px 12px !important; }
    .oa-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .oa-bg { background-color: #131518 !important; }
    .oa-card { background-color: #1C1F23 !important; border-color: #3B414A !important; }
    .oa-text { color: #E9EBEE !important; }
    .oa-t2 { color: #B7BDC6 !important; }
    .oa-muted { color: #9097A1 !important; }
    .oa-rule { border-color: #2C3037 !important; }
    .oa-soft { background-color: #22262B !important; border-color: #2C3037 !important; }
    .oa-markframe { border-color: #E9EBEE !important; }
    .oa-markfill { background-color: #7F9CFF !important; }
    .oa-link { color: #7F9CFF !important; }
  }
</style>
</head>
<body class="oa-bg" style="margin:0;padding:0;background-color:#EEF0F3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#EEF0F3;mso-hide:all;">${esc(WAITLIST_PREHEADER)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" class="oa-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;">
  <tr><td class="oa-outer" align="center" style="padding:36px 16px;">
    <table role="presentation" class="oa-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #BEC4CD;border-radius:10px;">
      <tr><td class="oa-pad" style="padding:28px 32px 0 32px;font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="padding-right:9px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-markframe" width="18" height="18" align="center" valign="middle" style="width:18px;height:18px;border:2px solid #15181C;border-radius:6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td class="oa-markfill" width="10" height="10" bgcolor="#2350D0" style="width:10px;height:10px;background-color:#2350D0;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table></td>
          <td class="oa-text" valign="middle" style="font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:#15181C;">${esc(SENDER_NAME)}</td>
        </tr></table>
        <h1 class="oa-text" style="margin:22px 0 10px 0;font-family:${FONT};font-size:26px;line-height:31px;font-weight:700;letter-spacing:-0.02em;color:#15181C;">${esc(HEADLINE)}</h1>
        <p class="oa-text" style="margin:0;font-size:15px;line-height:24px;color:#15181C;">${esc(BODY)}</p>
      </td></tr>
      <tr><td class="oa-pad" style="padding:22px 32px 0 32px;">
        <table role="presentation" class="oa-soft" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;border:1px solid #E0E3E8;border-radius:8px;border-collapse:separate;">
          <tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:21px;">
            <span class="oa-t2" style="display:block;color:#454C56;">${esc(SELF_HOST)}</span>
            <a class="oa-link" href="${esc(SELF_HOST_URL)}" target="_blank" style="display:inline-block;margin-top:6px;font-weight:600;color:#2350D0;text-decoration:underline;">${esc(SELF_HOST_LINK)}</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="oa-pad" style="padding:22px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-rule" style="border-top:1px solid #E0E3E8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table></td></tr>
      <tr><td class="oa-pad" style="padding:14px 32px 28px 32px;font-family:${FONT};">
        <p class="oa-muted" style="margin:0;font-size:12.5px;line-height:20px;color:#5F6670;">You're getting this because you joined the waitlist at ${plainHost(o.host)}.</p>
        <p class="oa-muted" style="margin:6px 0 0 0;font-size:12.5px;line-height:20px;color:#5F6670;">${esc(FOOTER2)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;
  return {
    from: { email: o.from, name: SENDER_NAME },
    replyTo: REPLY_TO,
    to,
    subject: WAITLIST_SUBJECT,
    text,
    html,
  };
}

const EMAIL_TIMEOUT_MS = 10_000;

/**
 * Best effort: sends the waitlist email and never throws. No binding, a bad
 * address, a failed or timed-out send is logged and changes nothing.
 */
export async function sendWaitlistEmail(
  env: {
    WELCOME_EMAIL?: SendEmail;
    WELCOME_FROM?: string;
  },
  to: string,
  host: string,
): Promise<void> {
  if (!env.WELCOME_EMAIL || !env.WELCOME_FROM) {
    console.warn("waitlist email: not configured");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const msg = waitlistEmail({ from: env.WELCOME_FROM, to, host });
    if (msg.to !== to || !ADDRESS_RE.test(msg.to)) {
      console.warn("waitlist email: invalid address");
      return;
    }
    await Promise.race([
      env.WELCOME_EMAIL.send(msg),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
          EMAIL_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    console.warn(
      "waitlist email: send failed",
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? code
        : "send_failed",
    );
  } finally {
    clearTimeout(timer);
  }
}
