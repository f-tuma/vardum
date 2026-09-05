import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { workspaceKeyRateLimit } from "./api-key-policy.js";
import { config } from "./config.js";
import { db, schema } from "./db/index.js";
import { sendActionEmail, smtpEnabled } from "./mail.js";
import { canCreateOrganization } from "./organization-policy.js";
import { access, roles } from "./permissions.js";

export const auth = betterAuth({
  appName: "Vardum",
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [
    config.WEB_URL,
    ...(config.NODE_ENV === "development" ? ["https://vite.f-tuma.dev"] : []),
  ],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailVerification: smtpEnabled
    ? {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) =>
          sendActionEmail({
            to: user.email,
            subject: "Verify your Vardum email",
            intro: `Hi ${user.name}, confirm this email address to finish setting up your account.`,
            action: "Verify email",
            url,
          }),
      }
    : undefined,
  emailAndPassword: {
    enabled: true,
    sendResetPassword: smtpEnabled
      ? async ({ user, url }) =>
          sendActionEmail({
            to: user.email,
            subject: "Reset your Vardum password",
            intro: `Hi ${user.name}, use this secure link to choose a new password.`,
            action: "Reset password",
            url,
          })
      : undefined,
  },
  user: {
    changeEmail: smtpEnabled
      ? {
          enabled: true,
          sendChangeEmailConfirmation: async ({ user, newEmail, url }) =>
            sendActionEmail({
              to: user.email,
              subject: "Confirm your Vardum email change",
              intro: `Hi ${user.name}, approve changing your account email to ${newEmail}.`,
              action: "Confirm email change",
              url,
            }),
        }
      : { enabled: false },
  },
  plugins: [
    organization({
      ac: access,
      roles,
      creatorRole: "owner",
      disableOrganizationDeletion: true,
      allowUserToCreateOrganization: ({ email }) =>
        canCreateOrganization(email),
      sendInvitationEmail: smtpEnabled
        ? async ({ id, email, organization, inviter, role }) => {
            const url = new URL("/accept-invitation", config.WEB_URL);
            url.searchParams.set("id", id);
            await sendActionEmail({
              to: email,
              subject: `Join ${organization.name} on Vardum`,
              intro: `${inviter.user.name} invited you to join ${organization.name} as ${role}.`,
              action: "Accept invitation",
              url: url.toString(),
            });
          }
        : undefined,
    }),
    apiKey([
      {
        configId: "workspace",
        defaultPrefix: "varda_",
        references: "organization",
        rateLimit: workspaceKeyRateLimit,
      },
    ]),
  ],
});
