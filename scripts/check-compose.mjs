import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Only checked-in examples and synthetic overrides. Do not read .env, inherit
// deployment variables or print rendered environments/POST signatures.
const repository = fileURLToPath(new URL("../", import.meta.url));
const cleanEnvironment = { PATH: process.env.PATH };
const applicationProbe = String.raw`
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  import { createRequire } from 'node:module';
  const { services, expectedOrigin } = JSON.parse(readFileSync(0, 'utf8'));
  const require = createRequire(new URL('./apps/api/package.json', import.meta.url));
  const { S3Client } = require('@aws-sdk/client-s3');
  const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
  const { parseConfig } = await import('./apps/api/src/config.ts');
  let upload;
  for (const name of ['api', 'worker', 'migrate']) {
    let config;
    try { config = parseConfig(services[name].environment); }
    catch (error) {
      throw new Error(name + ' configuration failed: ' + error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '));
    }
    const database = new URL(config.DATABASE_URL);
    assert.equal(database.hostname, 'postgres');
    assert.equal(database.username, name === 'migrate' ? 'varda' : 'varda_app');
    assert.equal(config.BETTER_AUTH_URL, config.WEB_URL);
    assert.equal(new URL(config.WEB_URL).pathname, '/', 'App/auth configuration must remain an origin without /app');
    assert.equal(new URL(config.WEB_URL).search, '');
    assert.equal(new URL(config.WEB_URL).hash, '');
    if (name !== 'api') continue;
    const storage = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    });
    try {
      const post = await createPresignedPost(storage, {
        Bucket: config.S3_BUCKET, Key: 'fixture/compose-check',
        Fields: { 'Content-Type': 'image/png' },
        Conditions: [['content-length-range', 1, 1024]], Expires: 60,
      });
      upload = new URL(post.url);
      assert.equal(upload.origin, expectedOrigin, 'Browser upload must use the public storage origin');
      assert.ok(post.fields.Policy && post.fields['X-Amz-Signature']);
    } finally { storage.destroy(); }
  }
  console.log(JSON.stringify({ uploadOrigin: upload.origin }));
`;

function render(file, example, project, mode) {
  const args = ["compose", "--env-file", example, "-p", project];
  if (mode === "rustfs") args.push("--profile", "rustfs");
  args.push("-f", file, "config", "--format", "json");
  const overrides = mode === "aws"
    ? { S3_ENDPOINT: "", S3_PUBLIC_ENDPOINT: "", S3_REGION: "eu-central-1", S3_FORCE_PATH_STYLE: "false", VITE_UPLOAD_ORIGINS: "https://vardum-assets.s3.eu-central-1.amazonaws.com" }
    : mode === "rustfs"
      ? { S3_ENDPOINT: "http://rustfs:9000", S3_PUBLIC_ENDPOINT: "https://storage.example.com", S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true" }
      : {};
  const result = spawnSync("docker", args, {
    cwd: repository, env: { ...cleanEnvironment, ...overrides },
    encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 ** 2,
  });
  assert.equal(result.status, 0, `${file}/${mode}: Compose config failed (${result.error?.message ?? result.stderr})`);
  return JSON.parse(result.stdout);
}

for (const file of ["compose.production.yml", "compose.dokploy.yml", "compose.dokploy.dev.yml"]) {
  const dokploy = file.includes("dokploy");
  const example = dokploy ? ".env.dokploy.example" : ".env.production.example";
  for (const mode of ["external", "aws", "rustfs"]) {
    const model = render(file, example, "vardum-config-a", mode);
    const services = model.services;
    const admin = new URL(services.migrate.environment.DATABASE_URL);
    const runtime = new URL(services.api.environment.DATABASE_URL);
    assert.notEqual(admin.password, runtime.password, "Runtime must not use administrator credentials");
    assert.equal(services.worker.environment.DATABASE_URL, runtime.href);
    for (const name of ["api", "worker"]) {
      assert.equal(services[name].depends_on.migrate.condition, "service_completed_successfully");
      assert.equal(services[name].environment.POSTGRES_PASSWORD, undefined);
      assert.equal(services[name].environment.POSTGRES_APP_PASSWORD, undefined);
      assert.ok(services[name].cap_drop.includes("ALL"));
      assert.ok(services[name].security_opt.includes("no-new-privileges:true"));
    }
    assert.equal(services.gateway.depends_on.api.condition, "service_healthy");
    assert.deepEqual(services.gateway.healthcheck.test, ["CMD", "wget", "-q", "--spider", "http://127.0.0.1/app/"], "Health must inspect the canonical app independently of marketing");
    if (dokploy) {
      for (const name of ["postgres", "migrate", "api", "worker"]) {
        assert.ok(!services[name].networks["dokploy-network"], `${name} must stay on the project network`);
        assert.ok(!services[name].ports?.length, `${name} must not publish host ports`);
      }
      assert.ok(services.gateway.networks["dokploy-network"]);
      assert.ok(!services.gateway.ports?.length);
      assert.ok(!services.rustfs?.ports?.length);
    }
    if (file === "compose.dokploy.yml") {
      assert.equal(services.gateway.build.target, "dokploy");
      assert.equal(services.gateway.environment.API_UPSTREAM, "vardum-api-internal:3000");
      assert.equal(services.gateway.environment.MARKETING_UPSTREAM, "127.0.0.1:8080");
      assert.ok(services.api.networks.default.aliases.includes("vardum-api-internal"));
      assert.ok(!services.gateway.volumes?.length, "Gateway config must come from its image");
      assert.equal(services.migrate.image, services.api.image);
      assert.equal(services.worker.image, services.api.image);
      assert.ok(services.api.image.startsWith("vardum-config-a-api:"));
      const other = render(file, example, "vardum-config-b", mode);
      assert.notEqual(other.services.api.image, services.api.image);
      assert.notEqual(other.services.gateway.image, services.gateway.image);
    } else {
      assert.ok(!services.gateway.build.target || services.gateway.build.target === "runtime");
    }
    if (mode === "rustfs") {
      assert.equal(services["rustfs-init"].depends_on.rustfs.condition, "service_healthy");
      assert.equal(services.api.environment.S3_ENDPOINT, "http://rustfs:9000");
    }
    const expectedOrigin = mode === "aws"
      ? "https://vardum-assets.s3.eu-central-1.amazonaws.com"
      : mode === "rustfs" ? "https://storage.example.com" : "https://fsn1.your-objectstorage.com";
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", applicationProbe], {
      cwd: repository, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NODE_ENV: "test" },
      input: JSON.stringify({ services, expectedOrigin }), encoding: "utf8",
      timeout: 20_000, maxBuffer: 1024 ** 2,
    });
    assert.equal(result.status, 0, `${file}/${mode}: ${result.error?.message ?? result.stderr}`);
    assert.equal(JSON.parse(result.stdout).uploadOrigin, expectedOrigin);
    console.log(`${file}: ${mode} schema, database roles, routing boundary and signed upload origin passed.`);
  }
}
console.log("9 example variants passed. No provider contacted; placeholder secrets, DNS, SMTP, backups and runtime release acceptance still need operator verification.");
