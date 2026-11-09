// The trial-ending reminder: HTML (light and dark) plus a plain-text part with
// the same words, in the Outlook-safe layout of design/emails/README.md (table
// layout, inline styles, 560px card, hidden preheader, bulletproof button with
// a VML fallback, dark-mode overrides in the one <style> block). The link
// points at the install's own plan page and carries no token or secret.

export interface TrialReminder {
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

const FONT =
  "Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function trialReminderEmail(o: {
  from: string;
  to: string;
  appHost: string;
  /** End of the Solo trial, epoch ms. */
  trialEndsAt: number;
}): TrialReminder {
  const url = new URL(`https://${o.appHost}/`);
  if (url.host !== o.appHost.toLowerCase()) throw new Error("invalid app host");
  const end = new Date(o.trialEndsAt);
  if (Number.isNaN(end.getTime())) throw new Error("invalid trial end");
  const host = url.host;
  const planUrl = `${url.origin}/settings/plan`;
  const date = `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`;

  // The approved line (OA Design audit #8), for both the 7-day and the
  // last-day email.
  const title = `Your free month ends on ${date}. Keep Solo for $1/month.`;
  const intro = `Your Solo trial for ${host} ends on ${date}, and there is no card on file yet.`;
  const consequence =
    "Add a card before then to keep publishing. If you do nothing, your workspace turns read-only when the trial ends. Nothing is deleted.";
  const button = "Add a card";
  const preheader = `Your free month ends on ${date}. Add a card to keep Solo for $1/month.`;
  const why = `You got this because you created ${host}. We send one a week before the free month ends and one on its last day.`;
  const to = oneLine(o.to);

  const text = [
    title,
    "",
    intro,
    "",
    consequence,
    "",
    `${button}:`,
    planUrl,
    "",
    "--",
    "",
    why,
  ].join("\n");

  const logo = esc(`${url.origin}/email/logo@2x.png`);
  const href = esc(planUrl);
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .oa-bg { background-color: #131518 !important; }
    .oa-card { background-color: #1C1F23 !important; border-color: #3B414A !important; }
    .oa-text { color: #E9EBEE !important; }
    .oa-text-2 { color: #B7BDC6 !important; }
    .oa-muted { color: #9097A1 !important; }
    .oa-rule { border-color: #2C3037 !important; }
    .oa-btn { background-color: #E9EBEE !important; }
    .oa-btn a { color: #131518 !important; }
    .oa-link { color: #7F9CFF !important; }
  }
  [data-ogsc] .oa-text { color: #E9EBEE !important; }
  [data-ogsc] .oa-text-2 { color: #B7BDC6 !important; }
  [data-ogsc] .oa-muted { color: #9097A1 !important; }
  [data-ogsc] .oa-link { color: #7F9CFF !important; }
  [data-ogsb] .oa-bg { background-color: #131518 !important; }
  [data-ogsb] .oa-card { background-color: #1C1F23 !important; }
  @media (max-width: 600px) {
    .oa-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .oa-outer { padding-left: 12px !important; padding-right: 12px !important; }
  }
</style>
</head>
<body class="oa-bg" style="margin:0;padding:0;width:100%;background-color:#EEF0F3;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#EEF0F3;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="oa-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;">
  <tr>
    <td class="oa-outer" align="center" style="padding:40px 16px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" class="oa-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #BEC4CD;border-radius:8px;">
        <tr>
          <td class="oa-pad" style="padding:32px 40px 0 40px;">
            <img src="${logo}" width="156" height="44" alt="Open Artifacts" style="display:block;width:156px;height:44px;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:32px 40px 0 40px;font-family:${FONT};">
            <h1 class="oa-text" style="margin:0;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:#15181C;">${esc(title)}</h1>
            <p class="oa-text-2" style="margin:16px 0 0 0;font-size:15px;line-height:24px;color:#454C56;">${esc(intro)}</p>
            <p class="oa-text-2" style="margin:12px 0 0 0;font-size:15px;line-height:24px;color:#454C56;">${esc(consequence)}</p>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:28px 40px 0 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="oa-btn" align="center" bgcolor="#15181C" style="border-radius:6px;background-color:#15181C;">
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="14%" stroke="f" fillcolor="#15181C"><v:textbox inset="0,0,0,0"><center style="color:#FFFFFF;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600;">${esc(button)}</center></v:textbox></v:roundrect><![endif]-->
                  <!--[if !mso]><!-->
                  <a href="${href}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">${esc(button)}</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:20px 40px 32px 40px;font-family:${FONT};">
            <p class="oa-muted" style="margin:0;font-size:13px;line-height:20px;color:#5F6670;">If the button doesn't work, paste this link into your browser:<br><a href="${href}" target="_blank" class="oa-link" style="color:#2350D0;text-decoration:underline;word-break:break-all;">${href}</a></p>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-rule" style="border-top:1px solid #E0E3E8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:20px 40px 32px 40px;font-family:${FONT};">
            <p class="oa-muted" style="margin:0;font-size:13px;line-height:20px;color:#5F6670;">${esc(why)}</p>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>
`;

  return { from: o.from, to, subject: title, text, html };
}
