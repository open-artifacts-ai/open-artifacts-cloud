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
  /**
   * True only for a self-serve signup (Google sign-in, Solo). Anything else,
   * e.g. an admin create with any auth or tier, gets neutral copy: no sign-in
   * method, no plan, no price.
   */
  selfServe?: boolean;
}): Welcome {
  const url = new URL(`https://${o.appHost}/`);
  if (url.host !== o.appHost.toLowerCase()) throw new Error("invalid app host");
  const host = url.host;
  const origin = url.origin;
  const to = oneLine(o.to);
  const end = trialEndLabel(o.trialEndsAt);
  const selfServe = o.selfServe === true;

  const lines = {
    title: "Your Open Artifacts is ready",
    preheader: `${host} is set up. Sign in to start publishing.`,
    intro: selfServe
      ? `${host} is set up and you're its owner. Sign in with the Google account you used to create it, ${to}.`
      : `${host} is set up and you're its owner. Sign in with the account you signed up with, ${to}.`,
    button: `Open ${host}`,
    connect: "Then connect your agent.",
    paste: "Paste this into Claude Code, Cursor or any AI agent:",
    prompt: [
      `Set up Open Artifacts for me: follow ${origin}/llms.txt`,
      "Sign in through the browser. Never ask me to paste a token into this chat.",
    ],
    plan: !selfServe
      ? null
      : end
        ? `You're on Solo: free until ${end}, then $1/month or $12/year. No card on file; we'll remind you a week before.`
        : "You're on Solo: free for your first month, then $1/month or $12/year. No card on file; we'll remind you a week before.",
    why: selfServe
      ? `You got this because you signed up and created ${host}.`
      : "You got this because you signed up for Open Artifacts.",
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
    ...(lines.plan ? [lines.plan, ""] : []),
    lines.why,
  ].join("\n");

  const FONT =
    "Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const homeUrl = esc(`${origin}/`);
  const btnW = Math.min(480, Math.max(240, lines.button.length * 9 + 48));
  // The hostname never breaks (nowrap on the host alone, so the rest of a long
  // line can still wrap); <wbr> after "https://" and before "/llms.txt" gives
  // clients a break point that is not inside the host.
  const nowrapHost = (h: string): string =>
    `<span style="white-space:nowrap;">${h}</span>`;
  const promptHtml = lines.prompt
    .map((l) =>
      esc(l).replace(
        esc(`${origin}/llms.txt`),
        () => `https://<wbr>${nowrapHost(esc(host))}<wbr>/llms.txt`,
      ),
    )
    .join("<br>");
  const whyHtml = esc(lines.why).replace(esc(host), () =>
    nowrapHost(esc(host)),
  );

  // Table layout per design/emails/README.md (the invite's template): inline
  // styles, 560px card, hidden preheader, VML button for Outlook, one <style>
  // block holding only the dark-mode and mobile overrides.
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(lines.title)}</title>
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
    .oa-pre { background-color: #181A1E !important; border-color: #2C3037 !important; color: #E9EBEE !important; }
  }
  [data-ogsc] .oa-text { color: #E9EBEE !important; }
  [data-ogsc] .oa-text-2 { color: #B7BDC6 !important; }
  [data-ogsc] .oa-muted { color: #9097A1 !important; }
  [data-ogsc] .oa-pre { color: #E9EBEE !important; }
  [data-ogsb] .oa-bg { background-color: #131518 !important; }
  [data-ogsb] .oa-card { background-color: #1C1F23 !important; }
  [data-ogsb] .oa-pre { background-color: #181A1E !important; }
  @media (max-width: 600px) {
    .oa-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .oa-outer { padding-left: 12px !important; padding-right: 12px !important; }
    .oa-pre { font-size: 11px !important; padding-left: 10px !important; padding-right: 10px !important; }
  }
</style>
</head>
<body class="oa-bg" style="margin:0;padding:0;width:100%;background-color:#EEF0F3;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#EEF0F3;">${esc(lines.preheader)}</div>
<table role="presentation" class="oa-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;">
  <tr>
    <td class="oa-outer" align="center" style="padding:40px 16px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" class="oa-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #BEC4CD;border-radius:8px;">
        <tr>
          <td class="oa-pad" style="padding:32px 40px 0 40px;">
            <img src="${esc(`${origin}/email/logo@2x.png`)}" width="156" height="44" alt="Open Artifacts" style="display:block;width:156px;height:44px;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:32px 40px 0 40px;font-family:${FONT};">
            <h1 class="oa-text" style="margin:0;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:#15181C;">${esc(lines.title)}</h1>
            <p class="oa-text-2" style="margin:16px 0 0 0;font-size:15px;line-height:24px;color:#454C56;">${esc(lines.intro)}</p>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:28px 40px 0 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="oa-btn" align="center" bgcolor="#15181C" style="border-radius:6px;background-color:#15181C;">
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${homeUrl}" style="height:44px;v-text-anchor:middle;width:${btnW}px;" arcsize="14%" stroke="f" fillcolor="#15181C"><v:textbox inset="0,0,0,0"><center style="color:#FFFFFF;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600;">${esc(lines.button)}</center></v:textbox></v:roundrect><![endif]-->
                  <!--[if !mso]><!-->
                  <a href="${homeUrl}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">${esc(lines.button)}</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:28px 40px 0 40px;font-family:${FONT};">
            <p class="oa-text-2" style="margin:0;font-size:15px;line-height:24px;color:#454C56;"><strong class="oa-text" style="color:#15181C;">${esc(lines.connect)}</strong> ${esc(lines.paste)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0 0;">
              <tr>
                <td class="oa-pre" bgcolor="#ECEEF1" style="background-color:#ECEEF1;border:1px solid #E0E3E8;border-radius:6px;padding:12px 14px;font-family:${MONO};font-size:12.5px;line-height:20px;color:#15181C;">${promptHtml}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:28px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="oa-rule" style="border-top:1px solid #E0E3E8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
          </td>
        </tr>
        <tr>
          <td class="oa-pad" style="padding:20px 40px 32px 40px;font-family:${FONT};">
${lines.plan ? `            <p class="oa-muted" style="margin:0 0 8px 0;font-size:13px;line-height:20px;color:#5F6670;">${esc(lines.plan)}</p>\n` : ""}            <p class="oa-muted" style="margin:0;font-size:13px;line-height:20px;color:#5F6670;">${whyHtml}</p>
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

  return {
    from: o.from,
    to: o.to,
    subject: `${host} is ready`,
    text,
    html,
  };
}
