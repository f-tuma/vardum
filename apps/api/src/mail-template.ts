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

  return {
    text: `${title}\n\n${intro}\n\n${action}: ${url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px;background:#090b0e;color:#e7e7ea;font:14px monospace">
    <main style="max-width:560px;margin:auto;border:1px solid #292d35;background:#0d1014">
      <header style="padding:20px;border-bottom:1px solid #292d35;color:#bb74f0">VARDUM // ACCOUNT</header>
      <section style="padding:20px">
        <h1 style="margin:0 0 16px;font-size:22px">${escape(title)}</h1>
        <p style="color:#9a9fa8;line-height:1.6">${escape(intro)}</p>
        <p style="margin:24px 0"><a href="${escape(url)}" style="display:inline-block;padding:12px 16px;background:#7c22aa;color:#fff;text-decoration:none">${escape(action)} →</a></p>
        <p style="margin:0;color:#686d76;font-size:12px;line-height:1.5">If you did not request this, you can ignore this email.</p>
      </section>
    </main>
  </body>
</html>`,
  };
}
