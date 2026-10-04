import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const script = fileURLToPath(new URL("./smoke-runtime-tls.mjs", import.meta.url));
const app = `sha256:${"a".repeat(64)}`;
const ids = [app, app, app, `sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`];
// Exercise real spawning, cancellation and cleanup with external state. No fake
// "successful TLS" route: these tests verify orchestration failures, not TLS.
const fakeDocker = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE;
state.commands.push(args);
let value = '', fail = false, block = false;
const name = args.at(-1);
if (args[0] === 'image' && args[1] === 'inspect') {
  value = JSON.stringify([{Id:args[2],Os:'linux',Architecture:mode === 'platform' ? 'arm64' : 'amd64'}]);
} else if (args[0] === 'network' && args[1] === 'create') {
  if (!args.includes('--internal')) throw Error('Public network');
  state.resources[name] = {type:'network',owner:args[args.indexOf('--label')+1].split('=')[1]};
  value = name;
} else if (args[0] === 'run') {
  if (args.includes('--publish') || args.includes('-p') || !args.includes('--pull') || args[args.indexOf('--pull')+1] !== 'never') throw Error('Unsafe launch');
  const container = args[args.indexOf('--name')+1];
  if (state.resources[container]) throw Error('Resource name reuse');
  state.resources[container] = {type:'container',owner:mode === 'foreign' ? 'foreign' : args[args.indexOf('--label')+1].split('=')[1],image:args.find(v=>v.startsWith('sha256:'))};
  for (const arg of args) if (arg.includes('dst=/tls,')) state.certificateDirectory = arg.match(/src=([^,]+)/)[1];
  value = container;
  if (mode === 'launch') fail = true; // Failed client may still have created a container.
} else if (args[0] === 'inspect') {
  const resource = state.resources[name];
  if (!resource) fail = true;
  else {
    const format = args[args.indexOf('--format')+1];
    if (format.includes('.Image')) value = mode === 'identity' ? 'sha256:'+'f'.repeat(64) : resource.image;
    else if (format.includes('PortBindings')) value = mode === 'foreign' ? '{"443/tcp":[{"HostPort":"9"}]}' : '{}';
    else if (format.includes('ReadonlyRootfs')) {
      const network = Object.keys(state.resources).find(key=>state.resources[key].type==='network');
      value = JSON.stringify({user:'65532:65532',capDrop:mode==='policy'?[]:['ALL'],securityOpt:['no-new-privileges'],readOnly:true,networks:{[network]:{}}});
    }
    else if (mode === 'cleanup') fail = true;
    else value = resource.owner;
  }
} else if (args[0] === 'network' && args[1] === 'inspect') value = args.includes('{{.Internal}}') ? 'true' : state.resources[name].owner;
else if (args[0] === 'exec') block = true;
else if (args[0] === 'ps') fail = true; // Never turn a daemon error into confirmed absence.
else if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) {
  if (state.resources[name].owner === 'foreign') throw Error('Foreign cleanup attempted');
  delete state.resources[name];
} else throw Error('Unexpected Docker operation');
const temporary = path+'.'+process.pid+'.tmp';
fs.writeFileSync(temporary,JSON.stringify(state));fs.renameSync(temporary,path);
if (fail) { fs.writeSync(2,'PRIVATE KEY synthetic-smtp-password postgres://do-not-retain\n');process.exit(1); }
if (block) setInterval(()=>{},1000);
else fs.writeSync(1,value+'\n');
`;
async function launch(t, mode, arguments_ = ids) {
  const directory = await mkdtemp(join(tmpdir(), "vardum-tls-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), fakeDocker, { mode: 0o700 });
  const statePath = join(directory, "state.json");
  const unrelated = { type: "container", owner: "foreign" };
  await writeFile(statePath, JSON.stringify({ resources: { unrelated }, commands: [] }));
  const destination = join(directory, "evidence");
  const child = spawn(process.execPath, [script, ...arguments_, destination], {
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_STATE: statePath, FAKE_MODE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const complete = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  return { child, complete, destination, statePath, unrelated, output: () => output };
}
async function sanitized(f) {
  const text = await readFile(join(f.destination, "summary.json"), "utf8");
  assert.doesNotMatch(text, /PRIVATE KEY|synthetic-smtp-password|postgres:\/\/|synthetic-storage-password/);
  const evidence = JSON.parse(text);
  assert.equal(evidence.privateCertificatesRemoved, true);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  if (state.certificateDirectory) await assert.rejects(access(state.certificateDirectory), { code: "ENOENT" });
  return { state, evidence };
}
for (const mode of ["launch", "identity", "platform", "policy"]) {
  test(`TLS gate retains sanitized failure proof and cleans owned resources after ${mode} failure`, { timeout: 15_000 }, async t => {
    const f = await launch(t, mode);
    assert.deepEqual(await f.complete, { code: 1, signal: null }, f.output());
    const { state, evidence } = await sanitized(f);
    assert.deepEqual(state.resources, { unrelated: f.unrelated });
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.cases.length, 0, "Setup failure cannot become a TLS pass");
    assert.ok(evidence.cleanup.every(item => item.removed));
    if (mode !== "platform") assert.equal(evidence.cleanup.length, mode === "policy" ? 3 : 2);
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`TLS gate aborts a blocked child and cleans only owned fixtures on ${signal}`, { timeout: 15_000 }, async t => {
    const f = await launch(t, "signal");
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = JSON.parse(await readFile(f.statePath, "utf8")).commands.some(args => args[0] === "exec");
      if (ready) break;
      await delay(20);
    }
    assert.ok(ready, f.output());
    f.child.kill(signal);
    assert.deepEqual(await f.complete, { code: signal === "SIGINT" ? 130 : 143, signal: null }, f.output());
    const { state, evidence } = await sanitized(f);
    assert.deepEqual(state.resources, { unrelated: f.unrelated });
    assert.equal(evidence.status, "interrupted");
    assert.equal(evidence.interruptedSignal, signal);
    assert.equal(evidence.cleanup.length, 3);
    assert.ok(evidence.cleanup.every(item => item.removed));
  });
}
for (const mode of ["foreign", "cleanup"]) {
  test(`TLS cleanup refuses ${mode === "foreign" ? "changed ownership" : "unconfirmed daemon absence"}`, { timeout: 15_000 }, async t => {
    const f = await launch(t, mode);
    if (mode === "cleanup") {
      const deadline = Date.now() + 5_000;
      while (!JSON.parse(await readFile(f.statePath, "utf8")).commands.some(args => args[0] === "exec")) { assert.ok(Date.now() < deadline); await delay(20); }
      f.child.kill("SIGTERM");
    }
    assert.deepEqual(await f.complete, { code: mode === "cleanup" ? 143 : 1, signal: null }, f.output());
    const { state, evidence } = await sanitized(f);
    assert.deepEqual(state.resources.unrelated, f.unrelated);
    assert.ok(Object.keys(state.resources).length > 1);
    assert.ok(evidence.cleanup.some(item => item.error === "ownership-check-or-removal-failed"));
    const removed = state.commands.filter(args => args[0] === "rm");
    if (mode === "foreign") assert.equal(removed.length, 0);
    assert.ok(evidence.cleanup.every(item => !item.absent), "CLI errors cannot certify cleanup");
  });
}
for (const [name, arguments_] of [["mutable tag", ["api:latest", ...ids.slice(1)]], ["mismatched application IDs", [ids[0], ids[3], ...ids.slice(2)]], ["extra argument", [...ids, "extra"]]]) {
  test(`TLS gate rejects ${name} before Docker or destination mutation`, async t => {
    const f = await launch(t, "signal", arguments_);
    assert.deepEqual(await f.complete, { code: 1, signal: null });
    assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")).commands, []);
    await assert.rejects(access(f.destination), { code: "ENOENT" });
  });
}
