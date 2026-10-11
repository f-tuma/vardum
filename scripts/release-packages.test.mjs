import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedContract } from "./retained-release-contract.mjs";
import { isRetryableInstallTarget, registryState, run, verifyPublishedRelease, waitForPublishedRelease, validatePackageReadme, withInstalledRelease } from "./release-packages.mjs";

test("registry verification waits for every package to propagate", async () => {
  const release = { packages: ["shared", "cli", "mcp"] };
  const delays = [];
  let reads = 0;
  const result = await waitForPublishedRelease(release, {
    attempts: 3,
    delayMs: 10,
    readState: async (input) => {
      assert.equal(input, release);
      reads++;
      return input.packages.map((name, index) => ({
        name,
        published: index < reads,
      }));
    },
    wait: async (ms) => delays.push(ms),
  });
  assert.equal(reads, 3);
  assert.deepEqual(delays, [10, 10]);
  assert.ok(result.every((pkg) => pkg.published));
});

test("available packages need no wait", async () => {
  await waitForPublishedRelease({}, {
    readState: async () => [{ published: true }],
    wait: async () => assert.fail("Unexpected delay"),
  });
});

test("missing packages fail after the bounded number of checks", async () => {
  let reads = 0;
  let waits = 0;
  await assert.rejects(waitForPublishedRelease({}, {
    attempts: 3,
    readState: async () => {
      reads++;
      return [{ published: false }];
    },
    wait: async () => { waits++; },
  }), /Not all release archives are available/);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

for (const message of ["Conflicting archive integrity", "Registry check failed (403)"]) {
  test(`does not retry ${message}`, async () => {
    const error = new Error(message);
    let reads = 0;
    await assert.rejects(waitForPublishedRelease({}, {
      readState: async () => {
        reads++;
        throw error;
      },
      wait: async () => assert.fail("Unexpected retry"),
    }), (actual) => actual === error);
    assert.equal(reads, 1);
  });
}

const readmePackages = [
  { name: "@vardum/shared", version: "0.4.1" },
  { name: "@vardum/cli", version: "0.8.1" },
  { name: "@vardum/mcp", version: "0.4.1" },
];
const cliManifest = readmePackages[1];
const publicReadme = `[CLI](https://www.npmjs.com/package/@vardum/cli/v/0.8.1)
 npm install --save-dev --save-exact @vardum/cli@0.8.1`;

test("packed public README permits standalone HTTPS setup and matching batch pins", () => {
  validatePackageReadme(publicReadme + "\n[App](https://vardum.com)\nnpx -y @vardum/mcp@0.4.1", cliManifest, readmePackages);
});

for (const target of ["../../docs/guide/quick-start.md", "https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md", "http://vardum.com", "https://key:secret@vardum.com"]) {
  test(`packed public README rejects inaccessible or unsafe setup link ${target}`, () => {
    assert.throws(() => validatePackageReadme(publicReadme + `\n[Setup](${target})`, cliManifest, readmePackages));
  });
}

test("packed public README rejects wrong self version, missing install and stale cross-package pins", () => {
  assert.throws(() => validatePackageReadme(publicReadme.replace("/v/0.8.1", "/v/0.8.0"), cliManifest, readmePackages), /exact public npm version/);
  assert.throws(() => validatePackageReadme(publicReadme.split("\n")[0], cliManifest, readmePackages), /exact installation pin/);
  assert.throws(() => validatePackageReadme(publicReadme + "\nnpx -y @vardum/mcp@0.4.0", cliManifest, readmePackages), /installation pin differs/);
});

test("packed README validates reference links and exact npm URL endings", () => {
  assert.throws(() => validatePackageReadme(publicReadme + "\n[setup]: ../../docs/guide/quick-start.md", cliManifest, readmePackages), /public absolute URLs/);
  assert.throws(() => validatePackageReadme(publicReadme.replace("/v/0.8.1)", "/v/0.8.10)"), cliManifest, readmePackages), /exact public npm version/);
  validatePackageReadme("[CLI][version]\n[version]: https://www.npmjs.com/package/@vardum/cli/v/0.8.1\nnpm install @vardum/cli@0.8.1", cliManifest, readmePackages);
});

// npm 12's actual local-loopback ETARGET JSON shape, captured without publishing.
const npmDetail = "In most cases you or one of your dependencies are requesting a package version that doesn't exist.";
function npmFailure(spec, changes = {}) {
  return Object.assign(new Error("Do not classify this unstructured message"), {
    code: 1, killed: false, signal: null,
    stdout: JSON.stringify({ error: { code: "ETARGET", summary: `No matching version found for ${spec}.`, detail: npmDetail } }),
    stderr: "npm error code ETARGET\nnpm error notarget\n", ...changes,
  });
}
const classifyRelease = { packages: readmePackages.map(pkg => ({ ...pkg, manifest: { ...pkg,
  dependencies: pkg.name === "@vardum/shared" ? {} : { "@vardum/shared": "^0.4.1", thirdparty: "^1.0.0" } } })) };
const classifyCli = classifyRelease.packages[1];

test("normal npm JSON ETARGET permits only the consumer pin and its validated batch dependency spec", () => {
  for (const [pkg, spec] of [[classifyCli, "@vardum/cli@0.8.1"], [classifyCli, "@vardum/shared@^0.4.1"],
    [classifyRelease.packages[2], "@vardum/mcp@0.4.1"]]) {
    assert.equal(isRetryableInstallTarget(npmFailure(spec), pkg, classifyRelease), true, spec);
  }
  for (const spec of ["@vardum/cli@0.8.0", "@vardum/cli@0.8.2", "@vardum/cli@^0.8.1", "@vardum/mcp@0.4.1",
    "@vardum/shared@0.4.1", "@vardum/shared@^0.4.0", "@vardum/shared@^0.4.2", "@vardum/shared@~0.4.1",
    "@vardum/shared@*", "@vardum/cli@latest", "@vardum/shared@next", "alias@npm:@vardum/shared@^0.4.1", "thirdparty@^1.0.0"]) {
    assert.equal(isRetryableInstallTarget(npmFailure(spec), classifyCli, classifyRelease), false, spec);
  }
  assert.equal(isRetryableInstallTarget(npmFailure("@vardum/shared@^0.4.1"), {
    ...classifyCli, manifest: { dependencies: { "@vardum/shared": "^0.4.0" } },
  }, classifyRelease), false, "unvalidated packed dependency");
});

test("classifier rejects malformed, ambiguous, truncated, non-normal, and non-ETARGET failures", () => {
  const stdout = npmFailure("@vardum/cli@0.8.1").stdout;
  const errors = [
    ["auth", { stdout: stdout.replace("ETARGET", "E401") }],
    ["transport", { stdout: stdout.replace("ETARGET", "ECONNRESET") }],
    ["integrity", { stdout: stdout.replace("ETARGET", "EINTEGRITY") }],
    ["wrong casing", { stdout: stdout.replace("ETARGET", "etarget") }],
    ["malformed", { stdout: stdout.slice(0, -1) }],
    ["two JSON documents", { stdout: `${stdout}\n${stdout}` }],
    ["JSON array", { stdout: `[${stdout}]` }],
    ["duplicate root", { stdout: stdout.replace('{"error":', `{"error":null,"error":`) }],
    ["duplicate code", { stdout: stdout.replace('"code":"ETARGET"', '"code":"E401","code":"ETARGET"') }],
    ["escaped duplicate code", { stdout: stdout.replace('"code":"ETARGET"', '"co\\u0064e":"E401","code":"ETARGET"') }],
    ["extra target object", { stdout: stdout.replace('"error":', '"errors":[],"error":') }],
    ["missing code", { stdout: stdout.replace('"code":"ETARGET",', '') }],
    ["non-summary message", { stdout: stdout.replace('"summary":', '"message":') }],
    ["summary has prefix", { stdout: stdout.replace('No matching', 'Other error: No matching') }],
    ["multiple summary specs", { stdout: stdout.replace('0.8.1.', '0.8.1. No matching version found for thirdparty@^1.0.0.') }],
    ["summary trailing newline", { stdout: stdout.replace('0.8.1.', '0.8.1.\\n') }],
    ["stderr only", { stdout: "", stderr: stdout }],
    ["timeout", { killed: true }],
    ["signal", { signal: "SIGTERM" }],
    ["unknown termination", { killed: undefined }],
    ["string process code", { code: "ETARGET" }],
    ["success process code", { code: 0 }],
    ["maxBuffer truncation", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
    ["oversize output", { stdout: `${" ".repeat(128_001)}${stdout}` }],
  ];
  for (const [label, changes] of errors) {
    assert.equal(isRetryableInstallTarget(npmFailure("@vardum/cli@0.8.1", changes), classifyCli, classifyRelease), false, label);
  }
});

const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
async function consumerFixture(versions = ["0.4.1", "0.8.1", "0.4.1"]) {
  const root = await mkdtemp(join(tmpdir(), "vardum-install-test-")), directory = join(root, "release");
  await mkdir(directory);
  const packages = [], manifests = [], archives = new Map();
  for (const [index, kind] of ["shared", "cli", "mcp"].entries()) {
    const name = `@vardum/${kind}`, version = versions[index], file = `vardum-${kind}-${version}.tgz`;
    const build = join(root, kind), manifest = { name, version, type: "module", ...(kind === "shared" ? {} : {
      dependencies: { "@vardum/shared": `^${versions[0]}` }, engines: { node: ">=22" },
      bin: { [kind === "cli" ? "vardum" : "vardum-mcp"]: "dist/index.js" },
    }) };
    await mkdir(join(build, "package/dist"), { recursive: true });
    await writeFile(join(build, "package/package.json"), JSON.stringify(manifest));
    await writeFile(join(build, "package/README.md"), "Offline verification fixture\n");
    await writeFile(join(build, "package/dist/index.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await run("tar", ["-czf", join(directory, file), "-C", build, "package"]);
    const bytes = await readFile(join(directory, file));
    packages.push({ name, version, file, integrity: `sha512-${digest("sha512", bytes, "base64")}`, bytes: bytes.length });
    manifests.push(manifest); archives.set(file, bytes);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify({ schema: 1, packages: packages.map(({ bytes, ...pkg }) => pkg) })}\n`);
  await writeFile(join(directory, "release.json"), manifestBytes);
  return { root, directory, packages, manifests, archives, contract: {
    expectedPackages: packages, expectedManifestSha256: digest("sha256", manifestBytes), expectedManifestBytes: manifestBytes.length,
  } };
}

function fakeConsumer(data, { onInstall = async () => {}, onRuntime = async () => {} } = {}) {
  const installs = [], runtime = [];
  const execute = async (command, args, options) => {
    const call = { command, args, ...options };
    if (command === "npm") {
      const pkg = data.packages.find(pkg => args.at(-1) === `${pkg.name}@${pkg.version}`);
      assert.ok(pkg, "Only one exact CLI/MCP root pin is installed");
      assert.notEqual(pkg.name, "@vardum/shared");
      installs.push(call);
      const patch = await onInstall(pkg, call, installs.length) ?? {};
      for (const entry of [pkg, data.packages[0]]) {
        const packageDir = join(options.cwd, "node_modules", entry.name);
        await mkdir(packageDir, { recursive: true });
        await writeFile(join(packageDir, "package.json"), JSON.stringify({ ...entry,
          version: entry === pkg ? patch.installedVersion ?? entry.version : patch.sharedVersion ?? entry.version }));
      }
      if (!patch.omitBinary) {
        await mkdir(join(options.cwd, "node_modules/.bin"), { recursive: true });
        await writeFile(join(options.cwd, "node_modules/.bin", pkg.name === "@vardum/cli" ? "vardum" : "vardum-mcp"), "fixture", { mode: 0o755 });
      }
      return { stdout: "{}", stderr: "" };
    }
    assert.equal(command, process.execPath);
    runtime.push(call);
    const override = await onRuntime(call, runtime.length);
    if (override) return override;
    if (args[1] === "version" || args[1] === "--version") {
      return { stdout: args[1] === "version" ? data.packages[1].version : data.packages[2].version };
    }
    assert.equal(args[1], "init");
    if (args.includes("--dry-run")) return { stdout: JSON.stringify({ actions: [{ applied: false }] }) };
    if (args.includes("other")) throw new Error("Use --force");
    if (!args.includes("--workspace")) throw new Error("Missing --workspace, --vard");
    const path = join(options.cwd, "vardum.json");
    try { await readFile(path); return { stdout: JSON.stringify({ changed: 0 }) }; } catch {}
    await writeFile(path, JSON.stringify({ schema: 1, server: "https://example.com", workspace: "workspace", vard: "vard" }));
    return { stdout: JSON.stringify({ changed: 1 }) };
  };
  return { execute, installs, runtime };
}
const publicOptions = (data, fake, extra = {}) => ({ expectedContract: data.contract, publicRegistry: true,
  installRetry: {}, execute: fake.execute, ...extra });
async function removed(path) { await assert.rejects(access(path), { code: "ENOENT" }); }
async function cleanupInstalls(fake) { for (const call of fake.installs) await removed(call.cwd); }

for (const missingSpec of ["@vardum/cli@0.8.1", "@vardum/shared@^0.4.1"]) {
  test(`transient ${missingSpec} uses fresh isolated attempts and resolves shared transitively`, async () => {
    const data = await consumerFixture(), failures = [], waits = [];
    let now = 0;
    const previousCredential = process.env.NPM_TOKEN, previousConfig = process.env.npm_config_registry;
    process.env.NPM_TOKEN = "fixture-secret"; process.env.npm_config_registry = "https://untrusted.invalid/";
    const fake = fakeConsumer(data, { onInstall: async (pkg, call, count) => {
      for (const failed of failures) await removed(failed.cwd);
      assert.deepEqual(Object.keys(call.env).sort(), ["HOME", "PATH", "XDG_CONFIG_HOME"]);
      assert.equal(call.timeout, 120_000);
      assert.equal(call.maxBuffer, 128_000);
      for (const flag of ["--json", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]) assert.ok(call.args.includes(flag));
      const cache = call.args[call.args.indexOf("--cache") + 1];
      const userConfig = call.args[call.args.indexOf("--userconfig") + 1];
      const globalConfig = call.args[call.args.indexOf("--globalconfig") + 1];
      assert.equal(await readFile(globalConfig, "utf8"), "");
      assert.equal(await readFile(userConfig, "utf8"), "registry=https://registry.npmjs.org/\n@vardum:registry=https://registry.npmjs.org/\n");
      assert.deepEqual(await readdir(cache), []); assert.deepEqual(await readdir(call.env.HOME), []);
      assert.deepEqual(await readdir(call.cwd), ["package.json"]);
      for (const old of failures) {
        assert.notEqual(call.cwd, old.cwd); assert.notEqual(call.env.HOME, old.env.HOME);
        assert.notEqual(cache, old.args[old.args.indexOf("--cache") + 1]);
        assert.notEqual(userConfig, old.args[old.args.indexOf("--userconfig") + 1]);
        assert.notEqual(globalConfig, old.args[old.args.indexOf("--globalconfig") + 1]);
      }
      if (count === 1) {
        await writeFile(join(call.cwd, "partial-install"), "failed");
        await writeFile(join(cache, "partial-cache"), "failed");
        await writeFile(join(call.env.HOME, "partial-home"), "failed");
        failures.push(call); throw npmFailure(missingSpec);
      }
    } });
    try {
      await withInstalledRelease(data.directory, async installed => {
        assert.equal(installed.cli.version, "0.8.1"); assert.equal(installed.mcp.version, "0.4.1");
        assert.notEqual(installed.cli.cwd, installed.mcp.cwd);
      }, publicOptions(data, fake, { now: () => now, wait: async ms => { waits.push(ms); now += ms; } }));
      assert.equal(fake.installs.length, 3); assert.deepEqual(waits, [10_000]);
      await cleanupInstalls(fake);
    } finally {
      if (previousCredential === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = previousCredential;
      if (previousConfig === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = previousConfig;
      await rm(data.root, { recursive: true, force: true });
    }
  });
}

test("default exhaustion is six attempts, five waits, bounded diagnostics and the original cause", async () => {
  const data = await consumerFixture(), waits = [], errors = [];
  let now = 0;
  const fake = fakeConsumer(data, { onInstall: async pkg => {
    const error = npmFailure("@vardum/shared@^0.4.1"); errors.push(error); throw error;
  } });
  try {
    await assert.rejects(withInstalledRelease(data.directory, async () => assert.fail("Unexpected callback"), publicOptions(data, fake, {
      now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    })), error => {
      assert.match(error.message, /after 6\/6 attempt\(s\).*ETARGET propagation did not settle/);
      assert.ok(error.message.length < 600); assert.equal(error.cause, errors.at(-1));
      assert.match(error.message, /common budget 180000ms, remaining 130000ms/);
      assert.match(error.message, /missing @vardum\/shared@\^0\.4\.1; npm ETARGET: No matching version found for @vardum\/shared@\^0\.4\.1/);
      assert.doesNotMatch(error.message, /unstructured/); return true;
    });
    assert.equal(fake.installs.length, 6); assert.deepEqual(waits, Array(5).fill(10_000));
    assert.ok(fake.installs.every(call => call.args.at(-1) === "@vardum/cli@0.8.1"));
    await cleanupInstalls(fake);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test("CLI and MCP share the monotonic budget and npm timeouts clip to its remaining time", async () => {
  const data = await consumerFixture(), waits = [];
  let now = 0;
  const fake = fakeConsumer(data, { onInstall: async (pkg, call, count) => {
    if (count === 1) now += 115_000;
    if (count === 2) { now += 1_000; throw npmFailure(`${pkg.name}@${pkg.version}`); }
  } });
  try {
    await withInstalledRelease(data.directory, async () => {}, publicOptions(data, fake, {
      now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    }));
    assert.deepEqual(fake.installs.map(call => call.timeout), [120_000, 65_000, 54_000]);
    assert.deepEqual(waits, [10_000]); await cleanupInstalls(fake);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

for (const mode of ["insufficient delay", "sleep reaches deadline", "successful CLI consumes budget", "setup consumes budget"]) {
  test(`deadline prevents further npm attempts and waits: ${mode}`, async () => {
    const data = await consumerFixture(), waits = [];
    let now = 0, clockReads = 0;
    const fake = fakeConsumer(data, { onInstall: async pkg => {
      if (mode === "successful CLI consumes budget") { now = 180_000; return; }
      if (mode === "insufficient delay") now = 175_000;
      throw npmFailure(`${pkg.name}@${pkg.version}`);
    } });
    try {
      await assert.rejects(withInstalledRelease(data.directory, async () => assert.fail("Unexpected callback"), publicOptions(data, fake, {
        now: () => mode === "setup consumes budget" && ++clockReads >= 3 ? 180_000 : now,
        wait: async ms => { waits.push(ms); now = 180_000; },
      })), /install budget exhausted/);
      assert.equal(fake.installs.length, mode === "setup consumes budget" ? 0 : 1);
      assert.deepEqual(waits, mode === "sleep reaches deadline" ? [10_000] : []);
      await cleanupInstalls(fake);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

test("a transient error followed by a nonretryable error stops immediately", async () => {
  const data = await consumerFixture(), waits = [];
  const later = npmFailure("thirdparty@^1.0.0");
  const fake = fakeConsumer(data, { onInstall: async (pkg, call, count) => {
    throw count === 1 ? npmFailure(`${pkg.name}@${pkg.version}`) : later;
  } });
  try {
    await assert.rejects(withInstalledRelease(data.directory, async () => {}, publicOptions(data, fake, {
      wait: async ms => waits.push(ms),
    })), error => { assert.match(error.message, /after 2\/6 attempt\(s\).*non-retryable/); assert.equal(error.cause, later);
      assert.match(error.message, /npm ETARGET: No matching version found for thirdparty@\^1\.0\.0\./); return true; });
    assert.equal(fake.installs.length, 2); assert.deepEqual(waits, [10_000]); await cleanupInstalls(fake);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

for (const changes of [{ killed: true }, { signal: "SIGTERM" }, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
  { stdout: "malformed" }, { stdout: npmFailure("@vardum/cli@0.8.0").stdout },
  { stdout: npmFailure("@vardum/cli@0.8.1").stdout.replace("ETARGET", "EINTEGRITY") }]) {
  test(`nonretryable npm failure gets one attempt: ${JSON.stringify(changes)}`, async () => {
    const data = await consumerFixture(), error = npmFailure("@vardum/cli@0.8.1", changes);
    const fake = fakeConsumer(data, { onInstall: async () => { throw error; } });
    try {
      await assert.rejects(withInstalledRelease(data.directory, async () => {}, publicOptions(data, fake, {
        wait: async () => assert.fail("Unexpected wait"),
      })), actual => actual.cause === error);
      assert.equal(fake.installs.length, 1); await cleanupInstalls(fake);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

for (const stage of ["installed version", "shared version", "missing binary", "binary execution", "binary version", "init", "callback"]) {
  test(`${stage} failure is outside the npm retry`, async () => {
    const data = await consumerFixture(), failure = npmFailure("@vardum/cli@0.8.1");
    const fake = fakeConsumer(data, {
      onInstall: async () => stage === "installed version" ? { installedVersion: "0.8.0" }
        : stage === "shared version" ? { sharedVersion: "0.4.0" } : stage === "missing binary" ? { omitBinary: true } : {},
      onRuntime: async call => {
        if (stage === "binary execution") throw failure;
        if (stage === "binary version") return { stdout: "0.8.0" };
        if (stage === "init" && call.args[1] === "init") throw failure;
      },
    });
    try {
      await assert.rejects(withInstalledRelease(data.directory, async () => { if (stage === "callback") throw failure; }, publicOptions(data, fake, {
        wait: async () => assert.fail("Unexpected retry wait"),
      })), error => { assert.doesNotMatch(error.message, /Public npm install/); return true; });
      assert.equal(fake.installs.length, ["init", "callback"].includes(stage) ? 2 : 1); await cleanupInstalls(fake);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

test("retry options require valid numeric bounds and a validated public release", async () => {
  const data = await consumerFixture(), fake = fakeConsumer(data);
  try {
    for (const installRetry of [null, false, [], { attempts: 0 }, { attempts: 1.5 }, { attempts: Infinity },
      { delayMs: -1 }, { delayMs: "10" }, { budgetMs: 0 }, { budgetMs: NaN }, { timeout: 1 }]) {
      await assert.rejects(withInstalledRelease(data.directory, async () => {}, publicOptions(data, fake, { installRetry })), /Install|Unknown/);
    }
    await assert.rejects(withInstalledRelease(data.directory, async () => {}, { expectedContract: data.contract, execute: fake.execute,
      installRetry: {} }), /requires a validated public release/);
    await assert.rejects(withInstalledRelease(undefined, async () => {}, { publicRegistry: true, execute: fake.execute,
      installRetry: {} }), /requires a validated public release/);
    await assert.rejects(verifyPublishedRelease(data.directory, async () => {}, {
      expectedContract: data.contract, consumerOptions: { installRetry: null, execute: fake.execute },
      registryOptions: { readState: async () => assert.fail("Invalid retry options must fail before registry reads") },
    }), /Install retry options must be an object/);
    assert.equal(fake.installs.length, 0);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

for (const mode of ["local fixture", "public compatibility"]) {
  test(`${mode} retains a single npm attempt without retry flags`, async () => {
    const data = await consumerFixture(), error = npmFailure("@vardum/cli@0.8.1");
    const execute = async (command, args, options) => {
      assert.equal(command, "npm"); assert.equal(options.timeout, 120_000);
      for (const flag of ["--json", "--globalconfig", "--cache"]) assert.ok(!args.includes(flag));
      assert.equal(args.at(-1), mode === "local fixture" ? "@vardum/cli@0.8.1" : "@vardum/cli@0.6.0");
      throw error;
    };
    try {
      await assert.rejects(withInstalledRelease(mode === "local fixture" ? data.directory : undefined, async () => {}, {
        expectedContract: mode === "local fixture" ? data.contract : undefined, publicRegistry: mode === "public compatibility", execute,
        wait: async () => assert.fail("Unexpected wait"),
      }), actual => actual === error);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

function registryFixture(data, { metadataMismatch = false, tarballMismatch = false } = {}) {
  return async url => {
    const archive = [...data.archives.keys()].find(file => String(url).endsWith(`/tarballs/${file}`));
    if (archive) {
      const bytes = data.archives.get(archive);
      return new Response(tarballMismatch ? Buffer.alloc(bytes.length, 65) : bytes);
    }
    const pkg = data.packages.find(pkg => String(url).endsWith(`/${encodeURIComponent(pkg.name)}/${pkg.version}`));
    assert.ok(pkg);
    return Response.json({ dist: { integrity: metadataMismatch && pkg.name === "@vardum/mcp" ? "different" : pkg.integrity,
      tarball: `https://registry.npmjs.org/tarballs/${pkg.file}` } });
  };
}

test("shared public orchestration validates and waits for exact registry bytes before any npm install", async () => {
  const data = await consumerFixture();
  let reads = 0, waits = 0;
  const fake = fakeConsumer(data, { onInstall: async (pkg, call, count) => {
    assert.equal(reads, 2);
    if (count === 1) throw npmFailure(`${pkg.name}@${pkg.version}`);
  } });
  try {
    await verifyPublishedRelease(data.directory, async () => {}, { expectedContract: data.contract, registryOptions: {
      attempts: 2, delayMs: 1,
      readState: async release => {
        assert.equal(fake.installs.length, 0); reads++;
        if (reads === 1) return release.packages.map(pkg => ({ ...pkg, published: false }));
        return registryState(release, { fetchImpl: registryFixture(data) });
      }, wait: async () => { waits++; },
    }, consumerOptions: { execute: fake.execute, wait: async () => { waits++; } } });
    assert.equal(fake.installs.length, 3); assert.equal(waits, 2); await cleanupInstalls(fake);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

for (const mismatch of ["archive", "metadata", "tarball"]) {
  test(`${mismatch} mismatch stops public orchestration before npm installation`, async () => {
    const data = await consumerFixture(), fake = fakeConsumer(data);
    let reads = 0;
    try {
      if (mismatch === "archive") await writeFile(join(data.directory, data.packages[0].file), "altered");
      await assert.rejects(verifyPublishedRelease(data.directory, async () => {}, { expectedContract: data.contract,
        registryOptions: { readState: async release => { reads++; return registryState(release, { fetchImpl: registryFixture(data, {
          metadataMismatch: mismatch === "metadata", tarballMismatch: mismatch === "tarball",
        }) }); }, wait: async () => assert.fail("Unexpected registry wait") },
        consumerOptions: { execute: fake.execute, wait: async () => assert.fail("Unexpected install wait") },
      }));
      assert.equal(fake.installs.length, 0); assert.equal(reads, mismatch === "archive" ? 0 : 1);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

test("retained expectedContract uses its own versions and packed dependency instead of current source", async () => {
  const data = await consumerFixture(["0.3.0", "0.7.0", "0.3.0"]), waits = [];
  const contract = expectedContract({ packages: data.packages, manifestSha256: data.contract.expectedManifestSha256,
    manifestBytes: data.contract.expectedManifestBytes });
  const fake = fakeConsumer(data, { onInstall: async (pkg, call, count) => {
    if (count === 1) throw npmFailure("@vardum/shared@^0.3.0");
  } });
  try {
    await verifyPublishedRelease(data.directory, async installed => {
      assert.equal(installed.cli.version, "0.7.0"); assert.equal(installed.mcp.version, "0.3.0");
    }, { expectedContract: contract, registryOptions: { readState: release => registryState(release, { fetchImpl: registryFixture(data) }) },
      consumerOptions: { execute: fake.execute, wait: async ms => waits.push(ms) } });
    assert.deepEqual(fake.installs.map(call => call.args.at(-1)), ["@vardum/cli@0.7.0", "@vardum/cli@0.7.0", "@vardum/mcp@0.3.0"]);
    assert.deepEqual(waits, [10_000]); await cleanupInstalls(fake);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
