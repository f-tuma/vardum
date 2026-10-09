import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const [gatewayImage, apiImage, destination, dokployImage, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Unexpected arguments");
for (const id of [gatewayImage, apiImage, ...(dokployImage ? [dokployImage] : [])])
  assert.match(id ?? "", /^sha256:[a-f0-9]{64}$/, "Pass full immutable Docker image IDs");
assert.ok(destination, "Usage: smoke-gateway-config.mjs GATEWAY_IMAGE_ID API_IMAGE_ID EMPTY_REPORT_DIRECTORY [DOKPLOY_IMAGE_ID]");
const output = resolve(destination);
await mkdir(output, { mode: 0o700 });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(repository, "docker/nginx.marketing.conf.template");
const owner = randomUUID();
const label = "io.vardum.gateway-config-smoke";
const network = `vardum-gateway-config-${owner}`;
const resources = [];
const cancellation = new AbortController();
let interruptedSignal;
let cleaning = false;
function interrupt(signal) {
  interruptedSignal ??= signal;
  if (!cleaning) cancellation.abort(new Error(`Gateway checks interrupted by ${signal}`));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => interrupt(signal));

const evidence = {
  schema: 2,
  startedAt: new Date().toISOString(),
  status: "incomplete",
  gatewayImage,
  apiImage,
  ...(dokployImage ? { dokployImage } : {}),
  platform: "linux/amd64",
  owner,
  network,
  scope: "Disposable routing and Docker DNS recovery mocks; real authentication, storage and restore are covered by production smoke.",
  commands: [],
  modes: {},
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, data) => writeFile(join(output, name), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + "\n");
async function docker(args, { binary = false, cleanup = false } = {}) {
  const invocation = { args, startedAt: new Date().toISOString() };
  evidence.commands.push(invocation);
  try {
    const result = await execute("docker", args, { encoding: binary ? null : "utf8", timeout: 20_000, maxBuffer: 16 * 1024 ** 2, ...(cleanup ? {} : { signal: cancellation.signal }) });
    invocation.status = "passed";
    return result;
  } catch (error) {
    invocation.status = "failed";
    invocation.error = `${error.message}\n${String(error.stderr ?? "")}`;
    throw error;
  }
}
async function createContainer(name, args, image, command = []) {
  // Register before launch: cleanup can recover a container created by a timed-out client.
  resources.push({ type: "container", name });
  await docker(["run", "--detach", "--name", name, "--label", `${label}=${owner}`, "--pull", "never", "--platform", "linux/amd64", "--network", network, ...args, image, ...command]);
  const actual = (await docker(["inspect", "--format", "{{.Image}}", name])).stdout.trim();
  assert.equal(actual, image, `Container ${name} must use the supplied Docker image ID`);
  return name;
}
async function fetchBounded(base, path, options = {}) {
  const response = await fetch(base + path, { ...options, redirect: "manual", signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(3_000)]) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}
async function waitReady(base) {
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const { response } = await fetchBounded(base, "/health");
      if (response.status === 200 && response.headers.get("x-vardum-gateway-probe") === `${owner}:api`) return;
      last = `status ${response.status}`;
    } catch (error) { last = error.message; }
    await delay(250, undefined, { signal: cancellation.signal });
  }
  throw new Error(`Gateway did not reach its mock API within 20 seconds: ${last}`);
}
const mock = `
  const http = require('node:http');
  const role = process.env.PROBE_ROLE;
  const generation = process.env.PROBE_GENERATION ?? '';
  const marker = process.env.PROBE_OWNER + ':' + role + (generation ? ':' + generation : '');
  http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-vardum-gateway-probe': marker });
      response.end(JSON.stringify({ role, generation, address: request.socket.localAddress, path: request.url, method: request.method, body: Buffer.concat(chunks).toString('utf8'), host: request.headers.host, forwardedFor: request.headers['x-forwarded-for'], forwardedProto: request.headers['x-forwarded-proto'] }));
    });
  }).listen(3000, '0.0.0.0');
`;
let failure;
try {
  for (const [name, id] of [["gateway", gatewayImage], ["api", apiImage], ...(dokployImage ? [["dokploy", dokployImage]] : [])]) {
    const image = JSON.parse((await docker(["image", "inspect", id])).stdout)[0];
    assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64", "Gateway routing proof is bounded to linux/amd64");
    evidence[`${name}Identity`] = { id: image.Id, os: image.Os, architecture: image.Architecture, rootfs: image.RootFS };
  }
  evidence.templateSha256 = hash(await readFile(template));
  resources.push({ type: "network", name: network });
  // Let Docker choose an available pool, then declare it explicitly: older
  // engines reject --ip reservations on automatically allocated networks.
  for (let attempt = 0; attempt < 3; attempt++) {
    await docker(["network", "create", "--label", `${label}=${owner}`, network]);
    const subnet = (await docker(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", network])).stdout.trim();
    assert.match(subnet, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/);
    const actualOwner = (await docker(["network", "inspect", "--format", `{{index .Labels "${label}"}}`, network])).stdout.trim();
    assert.equal(actualOwner, owner, "Only this invocation's empty network may be recreated");
    await docker(["network", "rm", network]);
    try {
      await docker(["network", "create", "--subnet", subnet, "--label", `${label}=${owner}`, network]);
      evidence.networkSubnet = subnet;
      break;
    } catch (error) {
      // Another invocation can claim the released pool; ask Docker for a new
      // one instead of guessing a fixed subnet or changing global IPAM pools.
      if (attempt === 2 || !/Pool overlaps with other one on this address space/i.test(String(error.stderr ?? error.message))) throw error;
    }
  }
  const backends = new Map();
  async function startBackend(role, generation = "") {
    const name = `${network}-backend-${role}${generation ? `-${generation}` : ""}`;
    const aliases = role === "api" ? ["api", "vardum-api-internal"] : ["marketing"];
    await createContainer(name, [
      ...aliases.flatMap(alias => ["--network-alias", alias]),
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--env", `PROBE_ROLE=${role}`, "--env", `PROBE_OWNER=${owner}`,
      "--env", `PROBE_GENERATION=${generation}`, "--entrypoint", "node",
    ], apiImage, ["-e", mock]);
    const ip = (await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name])).stdout.trim();
    assert.match(ip, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
    backends.set(role, { name, ip, generation });
    return backends.get(role);
  }
  async function removeBackend(role) {
    const backend = backends.get(role);
    const actualOwner = (await docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, backend.name])).stdout.trim();
    assert.equal(actualOwner, owner, "Replacement must only remove this invocation's backend");
    await docker(["rm", "--force", backend.name]);
    backends.delete(role);
    // Reserve the old IP with a process that has no port 3000 listener, so
    // Docker cannot accidentally give a replacement the same address.
    const holder = `${backend.name}-old-ip`;
    await createContainer(holder, ["--ip", backend.ip, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node"], apiImage, ["-e", "setInterval(() => {}, 1000)"]);
    const held = (await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, holder])).stdout.trim();
    assert.equal(held, backend.ip, "Old address must stay reserved without the upstream alias");
    return backend;
  }
  async function gatewayIdentity(name) {
    const info = JSON.parse((await docker(["inspect", "--format", '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"hostPid":{{json .State.Pid}}}', name])).stdout);
    const stat = (await docker(["exec", name, "cat", "/proc/1/stat"])).stdout;
    const masterStarted = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    assert.match(masterStarted, /^[0-9]+$/);
    const children = (await docker(["exec", name, "cat", "/proc/1/task/1/children"])).stdout.trim().split(/\s+/).filter(Boolean).sort();
    assert.ok(children.length > 0, "Nginx workers must be running");
    const workers = [];
    for (const pid of children) {
      assert.match(pid, /^[0-9]+$/);
      const workerStat = (await docker(["exec", name, "cat", `/proc/${pid}/stat`])).stdout;
      workers.push({ pid, started: workerStat.slice(workerStat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] });
    }
    return { ...info, masterStarted, workers };
  }
  async function waitGeneration(base, path, role, backend) {
    const started = Date.now();
    let last;
    while (Date.now() - started < 20_000) {
      try {
        const { response, bytes } = await fetchBounded(base, path);
        last = `status ${response.status}`;
        if (response.status === 200 && response.headers.get("x-vardum-gateway-probe") === `${owner}:${role}:${backend.generation}`) {
          const body = JSON.parse(bytes.toString("utf8"));
          assert.equal(body.address, backend.ip, "Recovery must reach the new container IP");
          assert.equal(body.path, path, "Recovery must preserve the exact URI");
          return Date.now() - started;
        }
      } catch (error) { last = error.message; }
      await delay(250, undefined, { signal: cancellation.signal });
    }
    throw new Error(`Gateway failed ${role} DNS recovery to changed IP within 20 seconds: ${last}`);
  }
  for (const role of ["api", "marketing"]) await startBackend(role);
  const gateways = [];
  let app;
  let asset;
  for (const mode of ["standard", "marketing", "fallback"]) {
    const name = `${network}-gateway-${mode}`;
    const report = evidence.modes[mode] = { container: name, checks: [] };
    const args = ["--publish", "127.0.0.1::80"];
    if (mode !== "standard") {
      if (!dokployImage)
        args.push("--mount", `type=bind,src=${template},dst=/etc/nginx/templates/default.conf.template,readonly`);
      args.push("--env", "API_UPSTREAM=vardum-api-internal:3000", "--env", `MARKETING_UPSTREAM=${mode === "marketing" ? "marketing:3000" : "127.0.0.1:8080"}`);
    }
    // No entrypoint/command override: exercise the official nginx startup and envsubst hooks.
    const image = mode !== "standard" && dokployImage ? dokployImage : gatewayImage;
    report.image = image;
    report.templateSource = mode === "standard" ? "none" : dokployImage ? "image" : "bind";
    await createContainer(name, args, image);
    if (mode !== "standard" && dokployImage) {
      const baked = (await docker(["exec", name, "cat", "/etc/nginx/templates/default.conf.template"], { binary: true })).stdout;
      assert.equal(hash(baked), evidence.templateSha256, "Built Dokploy image must contain the reviewed template");
      const mounts = JSON.parse((await docker(["inspect", "--format", "{{json .Mounts}}", name])).stdout);
      assert.equal(mounts.length, 0, "Dokploy routing must work without checkout mounts");
    }
    const bindings = JSON.parse((await docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name])).stdout)["80/tcp"];
    assert.equal(bindings?.length, 1);
    assert.equal(bindings[0].HostIp, "127.0.0.1");
    assert.match(bindings[0].HostPort, /^[0-9]+$/);
    const base = `http://127.0.0.1:${bindings[0].HostPort}`;
    report.base = base;
    await waitReady(base);
    const tested = await docker(["exec", name, "nginx", "-t"]);
    await save(`${mode}-nginx-test.txt`, tested.stdout + tested.stderr);
    const dumped = await docker(["exec", name, "nginx", "-T"]);
    const config = dumped.stdout + dumped.stderr;
    await save(`${mode}-nginx-effective.txt`, config);
    report.effectiveConfigSha256 = hash(config);
    for (const variable of ["$http_host", "$proxy_add_x_forwarded_for", "$scheme", "$uri"])
      assert.ok(config.includes(variable), `nginx variable ${variable} must survive entrypoint substitution`);
    if (mode !== "standard") {
      assert.ok(!config.includes("${API_UPSTREAM}"));
      assert.ok(!config.includes("${MARKETING_UPSTREAM}"));
      assert.match(config, /(?:proxy_pass http:\/\/|server )vardum-api-internal:3000(?: resolve)?;/);
      const marketing = mode === "marketing" ? "marketing:3000" : "127.0.0.1:8080";
      assert.ok(config.includes(`proxy_pass http://${marketing};`) || config.includes(`server ${marketing} resolve;`));
      const logs = await docker(["logs", name]);
      assert.ok((logs.stdout + logs.stderr).includes("20-envsubst-on-templates.sh"), "Normal nginx entrypoint must execute its template hook");
    }
    const index = (await docker(["exec", name, "cat", "/usr/share/nginx/html/index.html"], { binary: true })).stdout;
    assert.ok(index.length > 0);
    if (!app) {
      app = index;
      await save("built-index.html", app);
      const candidates = [...app.toString("utf8").matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
      const path = candidates.find((value) => /\.(?:js|css)(?:\?|$)/.test(value));
      assert.ok(path, "Built app index must reference a static JS or CSS asset");
      const pathname = new URL(path, base).pathname;
      assert.match(pathname, /^\/assets\/[A-Za-z0-9_./-]+$/);
      assert.ok(!pathname.split("/").some((part) => part === "." || part === ".."));
      const bytes = (await docker(["exec", name, "cat", `/usr/share/nginx/html${pathname}`], { binary: true })).stdout;
      assert.ok(bytes.length > 0);
      asset = { path, bytes };
      await save("built-asset.bin", bytes);
      evidence.app = { indexSha256: hash(app), assetPath: path, assetSha256: hash(bytes) };
    }
    assert.deepEqual(index, app, "All modes must serve the same built app");
    async function check(path, expected, options = {}, generation = "") {
      const { response, bytes } = await fetchBounded(base, path, options);
      const check = { path, expected, method: options.method ?? "GET", status: response.status, contentType: response.headers.get("content-type"), bodySha256: hash(bytes), bodyBytes: bytes.length };
      report.checks.push(check);
      assert.equal(response.status, 200, `${mode} ${path}: ${response.status}`);
      if (expected === "app" || expected === "asset") {
        assert.equal(response.headers.get("x-vardum-gateway-probe"), null, `${mode} ${path} must be served statically`);
        assert.deepEqual(bytes, expected === "app" ? app : asset.bytes, `${mode} ${path} must match the built file`);
        if (expected === "app") assert.ok(check.contentType?.startsWith("text/html"));
      } else {
        assert.equal(response.headers.get("x-vardum-gateway-probe"), `${owner}:${expected}${generation ? `:${generation}` : ""}`, `${mode} ${path} must reach the designated upstream`);
        const body = JSON.parse(bytes.toString("utf8"));
        assert.equal(body.role, expected);
        assert.equal(body.generation, generation);
        assert.equal(body.path, path, "Proxy must preserve the path and query");
        assert.equal(body.method, options.method ?? "GET");
        assert.equal(body.body, options.body ?? "");
        if (!["/health", "/ready"].includes(path)) {
          assert.equal(body.host, new URL(base).host);
          assert.equal(body.forwardedProto, "http");
          assert.ok(body.forwardedFor, "Forwarded client address must remain present");
        }
        check.upstreamResponse = body;
      }
      check.passed = true;
    }
    for (const path of ["/index.html", "/app", "/app/nested/route", "/account", "/account/profile", "/organizations", "/organizations/example", "/workspaces", "/workspaces/example", "/reset-password", "/reset-password/token", "/accept-invitation", "/accept-invitation/token", "/cli-login", "/cli-login/token"])
      await check(path, "app");
    await check(asset.path, "asset");
    for (const path of ["/api/", "/api/probe?query=preserved", "/w/workspace/a%2Fb%20c?sig=a%2Bb%3D&path=%252F", "/api/auth/sign-in/email", "/health", "/ready", "/v/", "/v/version/probe?query=preserved", "/w/", "/w/workspace/probe?query=preserved", `/assets/missing-${owner}.js`])
      await check(path, "api");
    await check("/api/probe", "api", { method: "POST", headers: { "content-type": "application/json" }, body: '{"routing":"preserve-method-and-body"}' });
    for (const path of ["/", "/unrelated/marketing/path?query=preserved"])
      await check(path, mode === "marketing" ? "marketing" : "app");
    report.initialRoutingPassed = true;
    const identity = await gatewayIdentity(name);
    gateways.push({ name, mode, base, report, check, identity });
  }
  const oldApi = await removeBackend("api");
  const newApi = await startBackend("api", "replacement");
  assert.notEqual(newApi.ip, oldApi.ip, "API replacement must have a different address");
  evidence.apiReplacement = { before: oldApi, after: newApi };
  for (const gateway of gateways) {
    const recoveredMs = await waitGeneration(gateway.base, "/ready", "api", newApi);
    for (const path of ["/api/probe?query=preserved", "/health", "/ready", "/v/version/probe?query=preserved", "/w/workspace/a%2Fb%20c?sig=a%2Bb%3D&path=%252F", `/assets/missing-${owner}.js`])
      await gateway.check(path, "api", {}, newApi.generation);
    await gateway.check("/api/probe", "api", { method: "POST", headers: { "content-type": "application/json" }, body: '{"replacement":"preserve-method-and-body"}' }, newApi.generation);
    await gateway.check("/app", "app");
    const after = await gatewayIdentity(gateway.name);
    assert.deepEqual(after, gateway.identity, "DNS recovery must not restart or reload nginx or its workers");
    gateway.report.apiDnsRecovery = { recoveredMs, before: gateway.identity, after, passed: true };
  }
  const oldMarketing = await removeBackend("marketing");
  const newMarketing = await startBackend("marketing", "replacement");
  assert.notEqual(newMarketing.ip, oldMarketing.ip, "Marketing replacement must have a different address");
  evidence.marketingReplacement = { before: oldMarketing, after: newMarketing };
  for (const gateway of gateways) {
    if (gateway.mode === "marketing") {
      const recoveredMs = await waitGeneration(gateway.base, "/", "marketing", newMarketing);
      await gateway.check("/unrelated/marketing/path?query=preserved", "marketing", {}, newMarketing.generation);
      const after = await gatewayIdentity(gateway.name);
      assert.deepEqual(after, gateway.identity, "Marketing DNS recovery must not reload nginx");
      gateway.report.marketingDnsRecovery = { recoveredMs, before: gateway.identity, after, passed: true };
    } else await gateway.check("/", "app");
    gateway.report.passed = true;
    console.log(`Gateway ${gateway.mode} config: ${gateway.report.checks.length} HTTP assertions and changed-IP DNS recovery passed.`);
  }
  // Start another gateway while neither hostname exists in Docker DNS. The
  // built SPA remains usable and the same nginx process adopts late upstreams.
  const absentApi = await removeBackend("api");
  const absentMarketing = await removeBackend("marketing");
  const coldName = `${network}-gateway-cold`;
  const coldArgs = ["--publish", "127.0.0.1::80", "--env", "API_UPSTREAM=vardum-api-internal:3000", "--env", "MARKETING_UPSTREAM=marketing:3000"];
  if (!dokployImage) coldArgs.push("--mount", `type=bind,src=${template},dst=/etc/nginx/templates/default.conf.template,readonly`);
  await createContainer(coldName, coldArgs, dokployImage ?? gatewayImage);
  const coldPort = JSON.parse((await docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", coldName])).stdout)["80/tcp"][0];
  assert.equal(coldPort.HostIp, "127.0.0.1");
  const coldBase = `http://127.0.0.1:${coldPort.HostPort}`;
  const coldDeadline = Date.now() + 20_000;
  let coldApp;
  while (Date.now() < coldDeadline) {
    try { coldApp = await fetchBounded(coldBase, "/app"); if (coldApp.response.status === 200) break; } catch { /* nginx startup */ }
    await delay(250, undefined, { signal: cancellation.signal });
  }
  assert.equal(coldApp?.response.status, 200, "Absent upstream aliases must not prevent gateway startup");
  assert.deepEqual(coldApp.bytes, app);
  for (const alias of ["vardum-api-internal", "marketing"]) {
    let result;
    try { result = (await docker(["exec", coldName, "nslookup", "-type=A", alias, "127.0.0.11"])).stdout; }
    catch (error) { result = `${error.stdout ?? ""}\n${error.stderr ?? ""}`; }
    assert.match(result, /NXDOMAIN|can't resolve/, "Cold start must prove DNS alias absence, not only an unavailable port");
  }
  for (const path of ["/health", "/"]) {
    const { response } = await fetchBounded(coldBase, path);
    assert.equal(response.status, 502, "Absent backend must fail closed while the app remains available");
  }
  const coldIdentity = await gatewayIdentity(coldName);
  const lateApi = await startBackend("api", "late");
  const lateMarketing = await startBackend("marketing", "late");
  assert.notEqual(lateApi.ip, absentApi.ip);
  assert.notEqual(lateMarketing.ip, absentMarketing.ip);
  const apiRecoveredMs = await waitGeneration(coldBase, "/ready", "api", lateApi);
  const marketingRecoveredMs = await waitGeneration(coldBase, "/", "marketing", lateMarketing);
  const coldAfter = await gatewayIdentity(coldName);
  assert.deepEqual(coldAfter, coldIdentity, "Late DNS recovery must not restart or reload nginx");
  evidence.coldStart = { container: coldName, apiRecoveredMs, marketingRecoveredMs, before: coldIdentity, after: coldAfter, passed: true };
  console.log("Gateway cold start: absent aliases and late API/marketing recovery passed.");
  cancellation.signal.throwIfAborted();
  evidence.status = "passed";
} catch (error) {
  failure = error;
  evidence.error = error.stack ?? error.message;
} finally {
  cleaning = true;
  evidence.cleanup = [];
  for (const resource of resources.toReversed()) {
    if (resource.type === "container") {
      try {
        const logs = await docker(["logs", resource.name], { cleanup: true });
        await save(`${resource.name.slice(network.length + 1)}-container.log`, logs.stdout + logs.stderr);
      } catch { /* A failed launch may never have created the container. */ }
    }
    try {
      const inspectArgs = resource.type === "container"
        ? ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, resource.name]
        : ["network", "inspect", "--format", `{{index .Labels "${label}"}}`, resource.name];
      const actualOwner = (await docker(inspectArgs, { cleanup: true })).stdout.trim();
      assert.equal(actualOwner, owner, "Cleanup must only remove this invocation's labelled resources");
      await docker(resource.type === "container" ? ["rm", "--force", resource.name] : ["network", "rm", resource.name], { cleanup: true });
      evidence.cleanup.push({ ...resource, removed: true });
    } catch (error) {
      if (/no such (?:object|container|network)/i.test(String(error.stderr ?? ""))) {
        evidence.cleanup.push({ ...resource, absent: true });
      } else {
        evidence.cleanup.push({ ...resource, error: error.message });
        failure ??= error;
        evidence.status = "incomplete";
      }
    }
  }
  if (interruptedSignal) {
    evidence.status = "interrupted";
    evidence.interruptedSignal = interruptedSignal;
  }
  evidence.completedAt = new Date().toISOString();
  await save("gateway-config-evidence.json", evidence);
}
if (interruptedSignal) {
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  console.error(`Gateway checks interrupted by ${interruptedSignal}; cleanup evidence retained at ${output}.`);
} else {
  if (failure) throw failure;
  console.log(`Gateway config evidence retained at ${output}.`);
}
