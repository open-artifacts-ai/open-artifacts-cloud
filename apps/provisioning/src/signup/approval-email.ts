// The approval email of the private beta (#2096), sent when an admin approves
// someone from the waitlist. Words are Product's, final: subject "You're in:
// Open Artifacts beta"; body "You can create your Open Artifacts now. Sign in
// with <email> at <sign-up link>. Your first 30 days are free." The button and
// footer are Design's (jL29NAp7gLQFqT9U). The link carries no token.

export interface ApprovalEmail {
  from: string;
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
  const body = `You can create your Open Artifacts now. Sign in with ${to} at ${link}. ${freeLine}`;
  const footer = `You're getting this because you joined the Open Artifacts waitlist with ${to}.`;
  const text = [
    body,
    "",
    `Create your Open Artifacts: ${link}`,
    "",
    footer,
  ].join("\n");
  const FONT =
    "Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const htmlBody = `You can create your Open Artifacts now. Sign in with ${esc(to)} at <a href="${esc(link)}" style="color:#1D45B8;">${esc(url.host)}</a>. ${esc(freeLine)}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(APPROVAL_SUBJECT)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .oa-bg { background-color: #131518 !important; }
    .oa-card { background-color: #1C1F23 !important; border-color: #3B414A !important; }
    .oa-text { color: #E9EBEE !important; }
    .oa-muted { color: #9097A1 !important; }
    .oa-rule { border-color: #2C3037 !important; }
    .oa-btn { background-color: #E9EBEE !important; }
    .oa-btn a { color: #131518 !important; }
    .oa-text a { color: #A3B8FF !important; }
  }
</style>
</head>
<body class="oa-bg" style="margin:0;padding:0;background-color:#EEF0F3;">
<table role="presentation" class="oa-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" class="oa-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #BEC4CD;border-radius:8px;">
      <tr><td style="padding:28px 32px 0 32px;font-family:${FONT};">
        <p class="oa-text" style="margin:0;font-size:15px;line-height:24px;color:#15181C;">${htmlBody}</p>
      </td></tr>
      <tr><td style="padding:22px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="oa-btn" align="center" bgcolor="#15181C" style="border-radius:6px;background-color:#15181C;">
            <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">Create your Open Artifacts</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-rule" style="border-top:1px solid #E0E3E8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table></td></tr>
      <tr><td style="padding:14px 32px 28px 32px;font-family:${FONT};">
        <p class="oa-muted" style="margin:0;font-size:12.5px;line-height:20px;color:#5F6670;">${esc(footer)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;
  return { from: o.from, to, subject: APPROVAL_SUBJECT, text, html };
}
