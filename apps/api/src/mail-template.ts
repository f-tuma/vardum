// The marketing site's palette, inlined: email clients ignore stylesheets.
const color = {
  page: "#07070a",
  panel: "#0d0d12",
  line: "#22222b",
  text: "#ededf2",
  body: "#a3a3b2",
  quiet: "#7c7c8d",
  violet: "#755de8",
  violetBright: "#a99cff",
};
const sans = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const mono = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function actionEmail({
  title,
  intro,
  action,
  url,
}: {
  title: string;
  intro: string;
  action: string;
  url: string;
}) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character] ?? character,
    );
  const ignore = "If you did not request this, you can ignore this email.";

  return {
    text: `VARDUM\n------\n\n${title}\n\n${intro}\n\n${action}: ${url}\n\n${ignore}`,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>${escape(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${color.page};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.page};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
            <tr>
              <td style="padding:0 0 16px;font:600 12px/1 ${mono};letter-spacing:0.18em;color:${color.text};">
                <span style="color:${color.violetBright};">/\\</span>&nbsp;&nbsp;VARDUM
              </td>
            </tr>
            <tr>
              <td style="border:1px solid ${color.line};border-radius:4px;background:${color.panel};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:10px 20px;border-bottom:1px dashed ${color.line};font:12px/1.4 ${mono};color:${color.quiet};">account/</td>
                  </tr>
                  <tr>
                    <td style="padding:24px 20px 8px;">
                      <h1 style="margin:0 0 12px;font:600 20px/1.3 ${sans};letter-spacing:-0.01em;color:${color.text};">${escape(title)}</h1>
                      <p style="margin:0;font:14px/1.6 ${sans};color:${color.body};">${escape(intro)}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:20px 20px 24px;">
                      <a href="${escape(url)}" style="display:inline-block;padding:10px 16px;border-radius:4px;background:${color.violet};font:500 14px/1 ${sans};color:#ffffff;text-decoration:none;">${escape(action)}</a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px 20px 16px;border-top:1px dashed ${color.line};">
                      <p style="margin:0 0 6px;font:12px/1.5 ${sans};color:${color.quiet};">Or paste this link into your browser:</p>
                      <p style="margin:0;font:12px/1.5 ${mono};color:${color.violetBright};word-break:break-all;">${escape(url)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 0 0;font:12px/1.5 ${sans};color:${color.quiet};">${ignore}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}
