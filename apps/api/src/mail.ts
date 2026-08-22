import nodemailer from "nodemailer";
import { config } from "./config.js";
import { actionEmail } from "./mail-template.js";

export const smtpEnabled = Boolean(config.SMTP_HOST);
const auth =
  config.SMTP_USER && config.SMTP_PASSWORD
    ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    : undefined;
const transport = config.SMTP_HOST
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth,
    })
  : null;

export async function sendActionEmail({
  to,
  subject,
  intro,
  action,
  url,
}: {
  to: string;
  subject: string;
  intro: string;
  action: string;
  url: string;
}) {
  if (!transport || !config.SMTP_FROM)
    throw new Error("SMTP is not configured");

  await transport.sendMail({
    from: config.SMTP_FROM,
    to,
    subject,
    ...actionEmail({ title: subject, intro, action, url }),
  });
}
