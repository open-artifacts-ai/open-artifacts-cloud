// The approval email of the private beta (#2096), sent when an admin approves
// someone from the waitlist. Design B (open-artifacts#2354): brand row, "You're
// in.", one button, the paste line, three steps, footer. Words are Product's,
// final. The link carries no token.

export const REPLY_TO = "hello@open-artifacts.com";
export const SENDER_NAME = "Open Artifacts";
export const PREHEADER = "Create your Open Artifacts and connect your agent.";

export interface ApprovalEmail {
  /** Display name plus the configured address (WELCOME_FROM). */
  from: { email: string; name: string };
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const APPROVAL_SUBJECT = "You're in: Open Artifacts beta";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * An address we will send to: printable ASCII only (no controls, spaces or
 * bidi and zero-width characters), one '@', a dotted domain of letters,
 * digits and hyphens. The local part is 0x21 to 0x7E without '@', ',', ';',
 * '<', '>' and '"' (the characters that split or quote an address list).
 */
export const ADDRESS_RE = /^[!#-+\-.-:=?A-~]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * Drops control (CR/LF included), format (bidi overrides, zero-width, BOM),
 * line and paragraph separator characters, so a value can't inject headers.
 */
export const sanitizeAddress = (s: string): string =>
  s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, "").trim();

/** https://signup.<app domain>/ */
export const signupLink = (appDomain: string): string =>
  `https://signup.${appDomain}/`;

/**
 * Text that mail apps must not turn into a link (Gmail and Apple Mail
 * autolink addresses and URLs). The text stays intact for copy and paste; a
 * span splits the text node at the "@" (or after "https://"), which defeats
 * the autolinker. The document also sets the format-detection meta.
 */
const NOLINK = "color:inherit;text-decoration:none;";
const plainAddress = (s: string): string => {
  const at = s.indexOf("@");
  return at < 0
    ? esc(s)
    : `${esc(s.slice(0, at))}<span style="${NOLINK}">@</span>${esc(s.slice(at + 1))}`;
};
const plainUrl = (host: string): string =>
  `https://<span style="${NOLINK}">${esc(host)}</span>`;

const STEPS: Array<[string, string]> = [
  ["Create your Open Artifacts", "Sign in and pick its address."],
  [
    "Connect your agent",
    "One line to paste into Claude Code, Codex, Cursor or any agent that speaks MCP.",
  ],
  [
    "Ask for an artifact",
    "Your agent publishes its work as a page. You read it, comment and share the link.",
  ],
];

export function approvalEmail(o: {
  from: string;
  to: string;
  appDomain: string;
  /** True where billing is configured (the BILLING binding exists): the trial line. Else the beta line. */
  billing: boolean;
}): ApprovalEmail {
  const to = sanitizeAddress(o.to);
  const link = signupLink(o.appDomain);
  const url = new URL(link);
  if (url.origin !== link.replace(/\/$/, "")) throw new Error("invalid domain");
  const freeLine = o.billing
    ? "Your first 30 days are free."
    : "It's free during the private beta.";
  const headline = "You're in.";
  const button = "Create your Open Artifacts";
  const pasteLead = "Or paste this into your browser:";
  const pasteUrl = `https://${url.host}`;
  const footer1 = `You're getting this because you joined the Open Artifacts waitlist with ${to}.`;
  const footer2 =
    "Open Artifacts is open source. Questions? Just reply to this email.";
  const text = [
    headline,
    "",
    `You can create your Open Artifacts now. Sign in with ${to}. ${freeLine}`,
    "",
    `${button}: ${link}`,
    "",
    "What happens next",
    ...STEPS.map(([t, d], n) => `${n + 1}. ${t}: ${d}`),
    "",
    footer1,
    footer2,
  ].join("\n");
  const FONT =
    "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const stepRows = STEPS.map(([t, d], n) => {
    const last = n === STEPS.length - 1;
    return `<tr><td class="oa-rule" style="padding:12px 14px;${last ? "" : "border-bottom:1px solid #E0E3E8;"}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td width="22" valign="top" style="width:22px;padding-right:12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-circle oa-t2" width="20" height="20" align="center" valign="middle" style="width:20px;height:20px;border:1px solid #BEC4CD;border-radius:11px;background-color:#FFFFFF;font-family:${FONT};font-size:12px;line-height:20px;font-weight:600;color:#454C56;">${n + 1}</td></tr></table></td>
            <td valign="top" style="font-family:${FONT};font-size:14px;line-height:21px;"><span class="oa-text" style="display:block;font-weight:600;color:#15181C;">${esc(t)}</span><span class="oa-t2" style="color:#454C56;">${esc(d)}</span></td>
          </tr></table></td></tr>`;
  }).join("\n        ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>${esc(APPROVAL_SUBJECT)}</title>
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
    .oa-circle { background-color: #1C1F23 !important; border-color: #3B414A !important; }
    .oa-markframe { border-color: #E9EBEE !important; }
    .oa-markfill { background-color: #7F9CFF !important; }
    .oa-btn { background-color: #7F9CFF !important; }
    .oa-btn a { color: #0F1320 !important; }
  }
</style>
</head>
<body class="oa-bg" style="margin:0;padding:0;background-color:#EEF0F3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#EEF0F3;mso-hide:all;">${esc(PREHEADER)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" class="oa-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;">
  <tr><td class="oa-outer" align="center" style="padding:36px 16px;">
    <table role="presentation" class="oa-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #BEC4CD;border-radius:10px;">
      <tr><td class="oa-pad" style="padding:28px 32px 0 32px;font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="padding-right:9px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-markframe" width="18" height="18" align="center" valign="middle" style="width:18px;height:18px;border:2px solid #15181C;border-radius:6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td class="oa-markfill" width="10" height="10" bgcolor="#2350D0" style="width:10px;height:10px;background-color:#2350D0;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table></td>
          <td class="oa-text" valign="middle" style="font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:#15181C;">Open Artifacts</td>
        </tr></table>
        <h1 class="oa-text" style="margin:22px 0 10px 0;font-family:${FONT};font-size:26px;line-height:31px;font-weight:700;letter-spacing:-0.02em;color:#15181C;">${esc(headline)}</h1>
        <p class="oa-text" style="margin:0;font-size:15px;line-height:24px;color:#15181C;">You can create your Open Artifacts now. Sign in with <b style="font-weight:600;color:inherit;text-decoration:none;">${plainAddress(to)}</b>. ${esc(freeLine)}</p>
      </td></tr>
      <tr><td class="oa-pad" style="padding:18px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="oa-btn" align="center" bgcolor="#2350D0" style="border-radius:7px;background-color:#2350D0;">
            <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:7px;">${button}</a>
          </td>
        </tr></table>
        <p class="oa-muted" style="margin:10px 0 0 0;font-family:${FONT};font-size:12.5px;line-height:20px;color:#5F6670;">${pasteLead} <span class="oa-t2" style="color:#454C56;">${plainUrl(url.host)}</span></p>
      </td></tr>
      <tr><td class="oa-pad" style="padding:22px 32px 0 32px;">
        <table role="presentation" class="oa-soft" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;border:1px solid #E0E3E8;border-radius:8px;border-collapse:separate;">
        ${stepRows}
        </table>
      </td></tr>
      <tr><td class="oa-pad" style="padding:22px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-rule" style="border-top:1px solid #E0E3E8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table></td></tr>
      <tr><td class="oa-pad" style="padding:14px 32px 28px 32px;font-family:${FONT};">
        <p class="oa-muted" style="margin:0;font-size:12.5px;line-height:20px;color:#5F6670;">You're getting this because you joined the Open Artifacts waitlist with ${plainAddress(to)}.</p>
        <p class="oa-muted" style="margin:6px 0 0 0;font-size:12.5px;line-height:20px;color:#5F6670;">${esc(footer2)}</p>
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
    subject: APPROVAL_SUBJECT,
    text,
    html,
  };
}
