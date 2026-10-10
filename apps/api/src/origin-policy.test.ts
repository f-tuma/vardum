import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const completionMarker = "VARD-58 origin policy checks complete";

// Better Auth reads NODE_ENV on import and skips origin/CSRF checks in test mode
// (including TEST=true). Fresh processes must exercise real startup in each mode.
// Keep only runtime path/temp settings: no ambient auth aliases, trusted origins,
// secrets, NODE_OPTIONS, SMTP or database configuration can affect these probes.
function childEnvironment(nodeEnv: string, webUrl: string | undefined) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgres://origin_test:origin_test@127.0.0.1:1/origin_test",
    BETTER_AUTH_SECRET: "origin-regression-auth-secret-0123456789abcdef",
    TRANSFORM_SECRET: "origin-regression-transform-secret-abcdef0123456789",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_TELEMETRY: "false",
  });
  if (webUrl !== undefined) env.WEB_URL = webUrl;
  return env;
}

const probe = String.raw`
  import assert from "node:assert/strict";
  import { writeSync } from "node:fs";
  import { buildApp } from "./src/app.ts";
  import { closeDatabase } from "./src/db/index.ts";

  const webOrigin = process.env.WEB_URL ?? "http://localhost:5173";
  const wrongScheme = new URL(webOrigin);
  wrongScheme.protocol = wrongScheme.protocol === "https:" ? "http:" : "https:";
  const wrongPort = new URL(webOrigin);
  wrongPort.port = "5174";
  const deceptiveHost = new URL(webOrigin);
  deceptiveHost.hostname += ".attacker.invalid";
  const deniedOrigins = [...new Set([
    "https://vite.f-tuma.dev",
    "https://unrelated.example.invalid",
    "http://localhost:5173",
    wrongScheme.origin,
    wrongPort.origin,
    deceptiveHost.origin,
  ])].filter((origin) => origin !== webOrigin);

  let app;
  try {
    app = await buildApp();
    if (process.argv[1] === "cors") {
      for (const origin of [webOrigin, ...deniedOrigins]) {
        const responses = [
          await app.inject({ method: "GET", url: "/health", headers: { origin } }),
          await app.inject({
            method: "OPTIONS",
            url: "/api/auth/sign-out",
            headers: {
              origin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            },
          }),
        ];
        assert.equal(responses[0].statusCode, 200, "GET /health: " + origin);
        assert.deepEqual(responses[0].json(), { status: "ok" });
        assert.equal(responses[1].statusCode, 204, "auth preflight: " + origin);
        for (const response of responses) {
          assert.equal(
            response.headers["access-control-allow-origin"],
            origin === webOrigin ? webOrigin : undefined,
            "CORS origin: " + origin,
          );
          if (origin === webOrigin) {
            assert.equal(response.headers["access-control-allow-credentials"], "true");
          }
        }
      }
    } else {
      const signOut = (origin) => app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        // A harmless cookie triggers CSRF checking without an actual session or
        // any database lookup. Do not send Referer as a missing-Origin fallback.
        headers: { cookie: "origin-regression=1", ...(origin === undefined ? {} : { origin }) },
        payload: {},
      });
      const allowed = await signOut(webOrigin);
      assert.equal(allowed.statusCode, 200, "configured auth origin: " + webOrigin);
      assert.deepEqual(allowed.json(), { success: true });
      assert.equal(allowed.headers["access-control-allow-origin"], webOrigin);
      assert.equal(allowed.headers["access-control-allow-credentials"], "true");
      for (const origin of deniedOrigins) {
        const response = await signOut(origin);
        assert.equal(response.statusCode, 403, "denied auth origin: " + origin);
        assert.equal(response.json().code, "INVALID_ORIGIN", "auth error: " + origin);
      }
      for (const origin of [undefined, "null"]) {
        const response = await signOut(origin);
        assert.equal(response.statusCode, 403, "missing/null auth origin: " + origin);
        assert.equal(response.json().code, "MISSING_OR_NULL_ORIGIN");
      }
    }
  } finally {
    try { await app?.close(); }
    finally { await closeDatabase(); }
  }
  writeSync(1, "VARD-58 origin policy checks complete\n");
`;

const origins = [
  ["default localhost", undefined],
  ["explicit remote", "https://dev.example.invalid:4443"],
  ["explicit former development domain", "https://vite.f-tuma.dev"],
] as const;

for (const nodeEnv of ["development", "production"]) {
  for (const [name, webUrl] of origins) {
    for (const policy of ["cors", "auth"]) {
      test(`${nodeEnv} ${name}: ${policy} enforces the configured frontend origin`, {
        timeout: 20_000,
      }, async () => {
        const { stdout } = await run(process.execPath, [
          "--import", "tsx", "--input-type=module", "-e", probe, policy,
        ], {
          cwd: apiDirectory,
          env: childEnvironment(nodeEnv, webUrl),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        // Development/production logging is enabled; stdout is not pure JSON.
        assert.ok(stdout.split(/\r?\n/).includes(completionMarker));
      });
    }
  }
}
