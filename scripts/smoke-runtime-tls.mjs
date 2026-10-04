import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const [api, worker, migrate, postgres, rustfs, destination, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Unexpected arguments");
for (const id of [api, worker, migrate, postgres, rustfs]) assert.match(id ?? "", /^sha256:[a-f0-9]{64}$/, "Pass immutable actual Docker image IDs");
assert.equal(api, worker, "API and worker images must match");
assert.equal(api, migrate, "API and migration images must match");
assert.ok(destination, "Usage: smoke-runtime-tls.mjs API_ID WORKER_ID MIGRATE_ID POSTGRES_ID RUSTFS_ID EMPTY_REPORT_DIRECTORY");
const output = resolve(destination);
await mkdir(output, { mode: 0o700 });
const scripts = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scripts, "..");
const owner = randomUUID();
const label = "io.vardum.runtime-tls-smoke";
const network = `vardum-runtime-tls-${owner}`;
const resources = [];
const controller = new AbortController();
let signal, cleaning = false, temporary, serial = 0, failure;
const evidence = {
  schema: 1, status: "incomplete", startedAt: new Date().toISOString(), owner, network,
  images: { api, worker, migrate, postgres, rustfs }, platform: "linux/amd64", cases: [], commands: [], cleanup: [],
  scope: "Ordinary application TLS validation against disposable services. No CVE mitigation or provider attestation; VARD55 release hold remains.",
};
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {
  signal ??= name;
  if (!cleaning) controller.abort();
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function command(binary, args, { cleanup = false, timeout = 20_000 } = {}) {
  const operation = binary === "docker" ? args.slice(0, args[0] === "network" || args[0] === "image" ? 2 : 1).join(" ") : binary;
  const record = { operation, startedAt: new Date().toISOString() };
  evidence.commands.push(record);
  try {
    const result = await execute(binary, args, { cwd: repository, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", ...(cleanup ? {} : { signal: controller.signal }) });
    record.status = "passed";
    return result.stdout + (binary === "docker" && args[0] === "logs" ? result.stderr : "");
  } catch (error) {
    record.status = "failed";
    record.code = error.code === "ABORT_ERR" ? "interrupted" : error.killed ? "timeout" : "command-failed";
    // Do not persist execFile's message/args/stderr: they may contain secrets,
    // connection URLs, SMTP content, certificate keys or application logs.
    throw new Error(`${operation}: ${record.code}`);
  } finally { record.elapsedMs = Date.now() - Date.parse(record.startedAt); }
}
const docker = (args, options) => command("docker", args, options);
async function create(name, args, image, entry = []) {
  const resource = { type: "container", name, removed: false };
  resources.push(resource); // Register before launch, including timed-out clients.
  await docker(["run", "--detach", "--name", name, "--label", `${label}=${owner}`, "--pull", "never", "--platform", "linux/amd64", "--network", network, "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=2", ...args, image, ...entry]);
  assert.equal((await docker(["inspect", "--format", "{{.Image}}", name])).trim(), image, "Launched image must match its verified ID");
  assert.deepEqual(JSON.parse(await docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", name])) ?? {}, {}, "TLS fixtures must not publish host ports");
  if (image === api) {
    const policy = JSON.parse(await docker(["inspect", "--format", '{"user":{{json .Config.User}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"networks":{{json .NetworkSettings.Networks}}}', name]));
    assert.equal(policy.user, "65532:65532");
    assert.ok(policy.capDrop?.includes("ALL"));
    assert.ok(policy.securityOpt?.some(value => /^no-new-privileges(?::true)?$/.test(value)));
    assert.equal(policy.readOnly, true);
    assert.deepEqual(Object.keys(policy.networks), [network]);
    evidence.applicationPolicy = { user: policy.user, capDrop: policy.capDrop, securityOpt: policy.securityOpt, readOnly: policy.readOnly, network };
  }
  return resource;
}
async function remove(resource, deadline = Date.now() + 10_000) {
  if (resource.removed) return;
  const result = { type: resource.type, name: resource.name };
  const timeout = Math.max(1, Math.min(3_000, deadline - Date.now()));
  try {
    const inspect = resource.type === "container"
      ? ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, resource.name]
      : ["network", "inspect", "--format", `{{index .Labels "${label}"}}`, resource.name];
    let actual;
    try { actual = (await docker(inspect, { cleanup: true, timeout })).trim(); }
    catch {
      // Confirm absence with an owned inventory instead of treating any Docker
      // error (including a disconnected daemon) as a successful cleanup.
      const inventory = await docker(resource.type === "container" ? ["ps", "-aq", "--filter", `name=^/${resource.name}$`] : ["network", "ls", "-q", "--filter", `name=^${resource.name}$`], { cleanup: true, timeout });
      assert.equal(inventory.trim(), "", "Could not confirm resource absence");
      result.absent = true;
      resource.removed = true;
      return;
    }
    assert.equal(actual, owner, "Refuse cleanup of a resource owned by another invocation");
    await docker(resource.type === "container" ? ["rm", "--force", "--volumes", resource.name] : ["network", "rm", resource.name], { cleanup: true, timeout });
    result.removed = resource.removed = true;
  } catch { result.error = "ownership-check-or-removal-failed"; throw new Error(result.error); }
  finally { evidence.cleanup.push(result); }
}
const appPolicy = ["--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--memory", "512m", "--cpus", "1", "--pids-limit", "128"];
function mounts() {
  return ["--mount", `type=bind,src=${join(temporary, "certificates")},dst=/tls,readonly`, "--mount", `type=bind,src=${join(scripts, "runtime-tls-probe.mjs")},dst=/app/runtime-tls-probe.mjs,readonly`, "--mount", `type=bind,src=${join(scripts, "runtime-tls-fixtures.mjs")},dst=/app/runtime-tls-fixtures.mjs,readonly`];
}
const adminPassword = "synthetic-admin-password";
const appPassword = "synthetic-runtime-password-at-least-24";
const storageKey = "synthetic-access-key";
const storagePassword = "synthetic-storage-password";
function database(kind, db = "fixture", role = "fixture_admin", name = "runtime_tls") {
  const url = new URL(`postgres://${role}:${role === "varda_app" ? appPassword : adminPassword}@pg-${kind}:5432/${db}`);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "/tls/trusted-ca.crt");
  url.searchParams.set("application_name", name);
  return url.href;
}
function environment(kind, path, overrides = {}) {
  return Object.entries({
    NODE_ENV: "production", HOST: "0.0.0.0", PORT: "3000", WORKER_HEALTH_PORT: "3001",
    BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters", TRANSFORM_SECRET: "synthetic-transform-secret-at-least-32-characters",
    BETTER_AUTH_URL: "http://synthetic.invalid:3000", WEB_URL: "http://synthetic.invalid:3000", ORGANIZATION_CREATION: "disabled",
    DATABASE_URL: database(kind), POSTGRES_APP_PASSWORD: appPassword, NODE_EXTRA_CA_CERTS: "/tls/trusted-ca.crt",
    S3_REGION: "us-east-1", S3_BUCKET: "runtime-tls", S3_ENDPOINT: `https://tls-${kind}:8443`, S3_FORCE_PATH_STYLE: "true", S3_ACCESS_KEY_ID: storageKey, S3_SECRET_ACCESS_KEY: storagePassword,
    SMTP_HOST: `tls-${kind}`, SMTP_PORT: path === "smtp-starttls" ? "8587" : "8465", SMTP_SECURE: path === "smtp-starttls" ? "false" : "true",
    SMTP_USER: "synthetic-user", SMTP_PASSWORD: "synthetic-smtp-password", SMTP_FROM: "sender@synthetic.invalid",
    TLS_PROBE_PATH: path, ...overrides,
  }).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}
const expectedCodes = {
  rogue: ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"],
  expired: ["CERT_HAS_EXPIRED"],
  "wrong-san": ["ERR_TLS_CERT_ALTNAME_INVALID"],
};
function certificateCodes(text) {
  // Only named certificate failures count for unmodified entrypoint processes.
  return [...new Set(Object.values(expectedCodes).flat())].filter(code => new RegExp(`\\b${code}\\b`).test(text));
}
async function probe(kind, path, overrides = {}, entry = ["node", "runtime-tls-probe.mjs"]) {
  const report = { kind, path, startedAt: new Date().toISOString(), status: "failed" };
  evidence.cases.push(report);
  const resource = await create(`${network}-probe-${++serial}`, [...appPolicy, ...mounts(), ...environment(kind, path, overrides)], api, entry);
  try {
    const exitCode = Number((await docker(["wait", resource.name], { timeout: 40_000 })).trim());
    const logs = await docker(["logs", resource.name]);
    const results = logs.split("\n").flatMap(line => { try { const parsed = JSON.parse(line); return parsed.runtimeTls === true ? [parsed] : []; } catch { return []; } });
    assert.ok(results.length <= 1, "Probe must emit at most one result");
    if (results[0]) {
      assert.equal(results[0].path, path);
      evidence.runtimeInventory ??= results[0].runtime;
      assert.deepEqual(results[0].runtime, evidence.runtimeInventory, "Every fresh probe must resolve the same installed application and pg-boss modules");
      assert.match(evidence.runtimeInventory?.pgBoss?.dbSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(evidence.runtimeInventory?.pgBoss?.version ?? "", /^\d+\.\d+\.\d+$/);
    }
    report.exitCode = exitCode;
    if (kind === "trusted") {
      assert.equal(exitCode, 0, `${path} trusted certificate must succeed`);
      if (entry[1] === "runtime-tls-probe.mjs") {
        assert.equal(results[0]?.status, "accepted", `${path} must report accepted application operation`);
        const { runtimeTls, runtime, path: _path, status, ...result } = results[0];
        report.result = result;
      }
      report.status = "passed";
    } else {
      assert.notEqual(exitCode, 0, `${path} invalid certificate must fail`);
      const codes = results[0]?.codes ?? certificateCodes(logs);
      assert.ok(codes.length > 0 && codes.every(code => expectedCodes[kind].includes(code)), `${path} requires the precise ${kind} certificate refusal`);
      report.refusal = { codes, category: kind };
      report.status = "passed";
    }
    return report;
  } finally { report.elapsedMs = Date.now() - Date.parse(report.startedAt); await remove(resource); }
}
async function control(fixture, code) {
  return JSON.parse(await docker(["exec", fixture.name, "node", "--input-type=module", "-e", code]));
}
async function metrics(fixture) {
  return control(fixture, "const r=await fetch('http://127.0.0.1:8081/metrics',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('metrics');console.log(await r.text());");
}
async function ready(check, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try { if (await check()) return; } catch { /* Still starting; outer deadline bounds every retry. */ }
    await delay(250, undefined, { signal: controller.signal });
  }
  throw new Error("Disposable fixture readiness timed out");
}
async function sql(pg, query, db = "fixture") {
  return (await docker(["exec", pg.name, "psql", "--no-psqlrc", "--username", "fixture_admin", "--dbname", db, "--host", "/var/run/postgresql", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", query])).trim();
}
async function fingerprint(pg, db = "fixture") {
  // Only digests leave the admin Unix socket; password hashes and schema/data
  // dumps are never retained. Include all roles and the sentinel, not row counts.
  return JSON.parse(await sql(pg, `SELECT json_build_object(
    'schemas', md5(coalesce((SELECT json_agg(x ORDER BY nspname)::text FROM (SELECT nspname,nspowner,nspacl FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema') x),'')),
    'objects', md5(coalesce((SELECT json_agg(x ORDER BY nspname,relname)::text FROM (SELECT n.nspname,c.relname,c.relkind,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') x),'')),
    'roles', md5((SELECT json_agg(r ORDER BY rolname)::text FROM pg_authid r)),
    'sentinel', md5((SELECT json_agg(t ORDER BY value)::text FROM tls_sentinel t)))` , db));
}
async function certificates() {
  temporary = await mkdtemp(join(tmpdir(), "vardum-runtime-tls-"));
  const directory = join(temporary, "certificates");
  await mkdir(directory, { mode: 0o755 });
  const openssl = args => command("openssl", args);
  for (const ca of ["trusted", "rogue"]) {
    await openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(directory, `${ca}-ca.key`), "-out", join(directory, `${ca}-ca.crt`), "-days", "30", "-subj", `/CN=synthetic-${ca}-ca`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  }
  const san = "DNS:tls-trusted,DNS:tls-rogue,DNS:tls-expired,DNS:tls-wrong-san,DNS:pg-trusted,DNS:pg-rogue,DNS:pg-expired,DNS:pg-wrong-san";
  for (const [index, kind] of ["trusted", "rogue", "expired", "wrong-san"].entries()) {
    const ca = kind === "rogue" ? "rogue" : "trusted";
    const ext = join(directory, `${kind}.ext`);
    await writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${kind === "wrong-san" ? "DNS:wrong.synthetic.invalid" : san}\n`);
    await openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(directory, `${kind}.key`), "-out", join(directory, `${kind}.csr`), "-subj", "/CN=synthetic-leaf"]);
    if (kind === "expired") {
      await mkdir(join(directory, "issued"));
      await writeFile(join(directory, "index"), "");
      await writeFile(join(directory, "serial"), "1000\n");
      const config = join(directory, "expired-ca.conf");
      await writeFile(config, `[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${directory}/index\nserial=${directory}/serial\nnew_certs_dir=${directory}/issued\ncertificate=${directory}/trusted-ca.crt\nprivate_key=${directory}/trusted-ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n`);
      await openssl(["ca", "-batch", "-notext", "-config", config, "-in", join(directory, `${kind}.csr`), "-out", join(directory, `${kind}.crt`), "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-extfile", ext]);
    } else {
      await openssl(["x509", "-req", "-in", join(directory, `${kind}.csr`), "-CA", join(directory, `${ca}-ca.crt`), "-CAkey", join(directory, `${ca}-ca.key`), "-set_serial", String(index + 1), "-days", "2", "-extfile", ext, "-out", join(directory, `${kind}.crt`)]);
    }
    // Parent temp directory remains private (0700). The readonly bind directory
    // must be readable by Node UID 65532; PostgreSQL copies its key as 0600.
    await chmod(join(directory, `${kind}.key`), 0o644);
  }
  evidence.certificates = {};
  for (const name of ["trusted-ca", "rogue-ca", "trusted", "rogue", "expired", "wrong-san"]) {
    const certificate = new X509Certificate(await readFile(join(directory, `${name}.crt`)));
    evidence.certificates[name] = { fingerprint256: certificate.fingerprint256, validFrom: certificate.validFrom, validTo: certificate.validTo, subjectAltName: certificate.subjectAltName ?? null };
  }
  await writeFile(join(directory, "pg_hba.conf"), "local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n");
}
async function postgresFixture(kind) {
  const pg = await create(`${network}-pg-${kind}`, ["--network-alias", `pg-${kind}`, "--mount", `type=bind,src=${join(temporary, "certificates")},dst=/tls,readonly`, "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--tmpfs", "/tmp:rw,size=16m", "--env", "POSTGRES_USER=fixture_admin", "--env", `POSTGRES_PASSWORD=${adminPassword}`, "--env", "POSTGRES_DB=fixture", "--entrypoint", "/bin/sh"], postgres, ["-ec", `cp /tls/${kind}.key /tmp/server.key; cp /tls/${kind}.crt /tmp/server.crt; chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key -c hba_file=/tls/pg_hba.conf -c max_connections=40`]);
  await ready(async () => (await sql(pg, "SELECT current_setting('listen_addresses')")) === "*");
  await sql(pg, "CREATE TABLE tls_sentinel(value text PRIMARY KEY); INSERT INTO tls_sentinel VALUES ('untouched');");
  return pg;
}
async function startup(kind, role) {
  const report = { kind, path: `${role}-startup`, startedAt: new Date().toISOString(), status: "failed" };
  evidence.cases.push(report);
  const resource = await create(`${network}-${role}`, [...appPolicy, ...mounts(), ...environment(kind, "startup", { DATABASE_URL: database(kind, "fixture", "varda_app", `integrated_${role}`) })], api, ["node", `dist/${role === "api" ? "server" : "worker"}.js`]);
  try {
    if (kind === "trusted") {
      await ready(async () => {
        const code = role === "api"
          ? "const results=await Promise.all(['/ready','/health'].map(async path=>{const r=await fetch('http://127.0.0.1:3000'+path,{signal:AbortSignal.timeout(2000)});return r.status}));if(results.some(s=>s!==200))process.exit(1);console.log(JSON.stringify({ready:true,health:true}));"
          : "const r=await fetch('http://127.0.0.1:3001/health',{signal:AbortSignal.timeout(2000)});if(r.status!==200)process.exit(1);console.log(JSON.stringify({health:true}));";
        report.health = await control(resource, code);
        return true;
      });
      return { report, resource };
    }
    report.exitCode = Number((await docker(["wait", resource.name], { timeout: 40_000 })).trim());
    assert.notEqual(report.exitCode, 0);
    const codes = certificateCodes(await docker(["logs", resource.name]));
    assert.ok(codes.length > 0 && codes.every(code => expectedCodes[kind].includes(code)), `${role} startup requires ${kind} certificate failure`);
    report.refusal = { codes, category: kind };
    report.status = "passed";
    await remove(resource);
    return { report, resource };
  } finally { report.elapsedMs = Date.now() - Date.parse(report.startedAt); }
}
try {
  evidence.sourceCommit = (await command("git", ["rev-parse", "HEAD"])).trim();
  evidence.sourceStatus = (await command("git", ["status", "--porcelain", "--untracked-files=all"])).trim();
  evidence.scripts = Object.fromEntries(await Promise.all(["smoke-runtime-tls.mjs", "runtime-tls-probe.mjs", "runtime-tls-fixtures.mjs"].map(async name => [name, hash(await readFile(join(scripts, name)))])));
  for (const id of new Set(Object.values(evidence.images))) {
    const image = JSON.parse(await docker(["image", "inspect", id]))[0];
    assert.equal(image.Id, id, "Input must be the actual host image ID");
    assert.equal(`${image.Os}/${image.Architecture}`, evidence.platform, "TLS gate is bounded to linux/amd64");
  }
  resources.push({ type: "network", name: network, removed: false });
  await docker(["network", "create", "--internal", "--label", `${label}=${owner}`, network]);
  assert.equal((await docker(["network", "inspect", "--format", "{{.Internal}}", network])).trim(), "true", "TLS fixtures require an internal network");
  await certificates();
  const storage = await create(`${network}-storage`, ["--network-alias", "storage", "--tmpfs", "/data:rw,size=256m,mode=1777", "--env", `RUSTFS_ACCESS_KEY=${storageKey}`, "--env", `RUSTFS_SECRET_KEY=${storagePassword}`, "--env", "RUSTFS_VOLUMES=/data", "--env", "RUSTFS_ADDRESS=0.0.0.0:9000", "--env", "RUSTFS_CONSOLE_ENABLE=false"], rustfs);
  const fixtures = {};
  for (const kind of ["trusted", "rogue", "expired", "wrong-san"]) {
    fixtures[kind] = await create(`${network}-tls-${kind}`, [...appPolicy, ...mounts(), "--network-alias", `tls-${kind}`, "--env", `TLS_FIXTURE_KIND=${kind}`], api, ["node", "runtime-tls-fixtures.mjs"]);
    await ready(async () => Boolean(await metrics(fixtures[kind])));
  }
  await ready(async () => control(fixtures.trusted, "const r=await fetch('http://storage:9000/health',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('storage');console.log('true');"));
  await probe("trusted", "bucket");
  for (const kind of ["trusted", "rogue", "expired", "wrong-san"]) {
    for (const path of ["storage", "smtp-implicit", "smtp-starttls"]) {
      const before = await metrics(fixtures[kind]);
      const report = await probe(kind, path);
      const after = await metrics(fixtures[kind]);
      const mode = path === "smtp-starttls" ? "starttls" : "implicit";
      report.mutations = { http: after.http - before.http, s3: after.mutations - before.mutations, auth: after[mode].auth - before[mode].auth, envelope: after[mode].envelope - before[mode].envelope, data: after[mode].data - before[mode].data, upgrades: after[mode].upgrades - before[mode].upgrades };
      assert.equal(after[mode].cleartextViolations, 0, "SMTP AUTH/envelope/DATA cannot precede the offered upgrade");
      if (kind !== "trusted") assert.deepEqual({ ...report.mutations, upgrades: undefined }, { http: 0, s3: 0, auth: 0, envelope: 0, data: 0, upgrades: undefined }, "Certificate rejection must precede requests and SMTP mutations");
      else if (path === "storage") assert.ok(report.mutations.http >= 4 && report.mutations.s3 >= 2);
      else {
        assert.equal(report.mutations.auth, 1); assert.equal(report.mutations.data, 1); assert.equal(report.mutations.envelope, 2);
        if (path === "smtp-starttls") assert.equal(report.mutations.upgrades, 1);
      }
    }
  }
  for (const kind of ["trusted", "rogue", "expired", "wrong-san"]) {
    const pg = await postgresFixture(kind);
    if (kind === "trusted") {
      await probe(kind, "db");
      const full = await probe(kind, "full-migrate", {}, ["node", "dist/migrate.js"]);
      const schema = JSON.parse(await sql(pg, "SELECT json_build_object('app',to_regclass('public.asset') IS NOT NULL,'queue',to_regclass('pgboss.version') IS NOT NULL,'drizzle',to_regclass('drizzle.__drizzle_migrations') IS NOT NULL,'runtimeRole',EXISTS(SELECT FROM pg_roles WHERE rolname='varda_app'))"));
      assert.ok(Object.values(schema).every(Boolean));
      full.result = schema;
      await sql(pg, "CREATE DATABASE queue_only");
      const queueMigration = await probe(kind, "queue-migrate", { DATABASE_URL: database(kind, "queue_only") });
      assert.equal(await sql(pg, "SELECT count(*) FROM pgboss.version", "queue_only"), "1");
      queueMigration.result.queueSchemaPresent = true;
      for (const path of ["queue", "listener"]) await probe(kind, path, { DATABASE_URL: database(kind, "fixture", "varda_app", `probe_${path}`), TLS_APPLICATION_NAME: `probe_${path}` });
      const running = [];
      try {
        for (const role of ["worker", "api"]) running.push(await startup(kind, role));
        // The installed dedicated listener replaces its last LISTEN statement
        // with a same-session channel-registration heartbeat after ten seconds.
        // Both markers identify that connection; pooled queries use neither.
        const encryption = JSON.parse(await sql(pg, "SELECT json_agg(json_build_object('role',a.application_name,'encrypted',s.ssl,'protocol',s.version,'listener',(a.query ~ '^LISTEN ' OR a.query LIKE '%FROM pg_listening_channels()%'))) FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.application_name IN ('integrated_api','integrated_worker')"));
        assert.ok(encryption?.length >= 4 && encryption.every(row => row.encrypted));
        for (const { report } of running) {
          const own = encryption.filter(row => row.role === `integrated_${report.path.split('-')[0]}`);
          assert.ok(own.some(row => row.listener), "Unmodified runtime must have an encrypted dedicated LISTEN session");
          report.encryption = own; report.status = "passed";
        }
        await probe(kind, "worker-job", { DATABASE_URL: database(kind, "fixture", "varda_app", "worker_job") });
        for (const { resource } of running) assert.equal(certificateCodes(await docker(["logs", resource.name])).length, 0);
      } finally { for (const { resource } of running.toReversed()) await remove(resource); }
    } else {
      for (const path of ["db", "queue", "listener", "queue-migrate", "full-migrate", "api-startup", "worker-startup"]) {
        const before = await fingerprint(pg);
        const report = path.endsWith("-startup") ? (await startup(kind, path.split("-")[0])).report
          : await probe(kind, path, {}, path === "full-migrate" ? ["node", "dist/migrate.js"] : undefined);
        const after = await fingerprint(pg);
        report.databaseMutation = { before, after, unchanged: true };
        assert.deepEqual(after, before, "Rejected client must not change schemas, roles or sentinel data");
      }
    }
    await remove(pg);
  }
  evidence.fixtureCounters = {};
  for (const [kind, fixture] of Object.entries(fixtures)) evidence.fixtureCounters[kind] = await metrics(fixture);
  controller.signal.throwIfAborted();
  evidence.status = "passed";
} catch (error) {
  failure = error;
  evidence.error = error.message.startsWith("docker") || error.message.startsWith("openssl") ? error.message : "TLS gate assertion or fixture setup failed";
} finally {
  cleaning = true;
  const deadline = Date.now() + 60_000;
  for (const resource of resources.toReversed()) {
    if (resource.removed) continue;
    if (Date.now() >= deadline) { evidence.cleanup.push({ type: resource.type, name: resource.name, error: "cleanup-deadline" }); failure ??= new Error("Cleanup deadline"); continue; }
    try { await remove(resource, deadline); } catch (error) { failure ??= error; }
  }
  try { if (temporary) await rm(temporary, { recursive: true, force: true }); evidence.privateCertificatesRemoved = true; }
  catch { failure ??= new Error("Private certificate cleanup failed"); evidence.privateCertificatesRemoved = false; }
  if (failure) evidence.status = "incomplete";
  if (signal) { evidence.status = "interrupted"; evidence.interruptedSignal = signal; }
  evidence.completedAt = new Date().toISOString();
  evidence.elapsedMs = Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
  await writeFile(join(output, "summary.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(output, "summary.txt"), `Runtime TLS gate: ${evidence.status}\nCases passed: ${evidence.cases.filter(c => c.status === "passed").length}/${evidence.cases.length}\nPrivate certificates removed: ${evidence.privateCertificatesRemoved}\nOrdinary TLS matrix; VARD55 release hold remains.\n`, { mode: 0o600 });
}
if (signal) process.exitCode = signal === "SIGINT" ? 130 : 143;
else if (failure) { console.error(`Runtime TLS gate failed; sanitized partial proof retained at ${output}.`); process.exitCode = 1; }
else console.log(`Runtime TLS gate passed ${evidence.cases.length} application cases; sanitized proof retained at ${output}.`);
