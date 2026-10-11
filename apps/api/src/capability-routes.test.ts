import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("public capabilities expose exactly the supported actions with and without email delivery", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? "configured" : "unconfigured", async () => {
      // Separate processes exercise the real startup configuration in both states.
      // These requests never connect to the configured SMTP host or a database.
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
      for (const key of ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_SECURE"])
        delete env[key];
      if (enabled) Object.assign(env, {
        SMTP_HOST: "smtp.example.invalid",
        SMTP_FROM: "Private sender <private@example.invalid>",
        SMTP_USER: "private-user",
        SMTP_PASSWORD: "private-password",
      });
      const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { buildApp } from "./src/app.ts";
        const app = await buildApp();
        try {
          const response = await app.inject({ method: "GET", url: "/api/capabilities" });
          console.log(JSON.stringify({ status: response.statusCode, cache: response.headers["cache-control"], body: response.json() }));
        } finally { await app.close(); }
      `], { env });
      assert.deepEqual(JSON.parse(stdout), {
        status: 200,
        cache: "no-store",
        body: { passwordRecovery: enabled, emailChange: enabled, invitations: enabled, folderUploadResume: 1, folderVardImport: 1, vardEditRevision: 1 },
      });
    });
  }
});
