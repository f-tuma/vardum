import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const script = fileURLToPath(new URL("./smoke-gateway-config.mjs", import.meta.url));
// Exercise the real child process, signal handling and ownership checks without
// a Docker daemon. The fake CLI records external resources and refuses name reuse.
const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.commands.push(args);
let value = "";
if (args[0] === "image" && args[1] === "inspect") {
  value = JSON.stringify([{ Id: args[2], Os: "linux", Architecture: "amd64", RootFS: { Type: "layers", Layers: [] } }]);
} else if (args[0] === "network" && args[1] === "create") {
  const name = args.at(-1);
  state.resources[name] = { type: "network", owner: args[args.indexOf("--label") + 1].split("=")[1] };
  value = name;
} else if (args[0] === "run") {
  const name = args[args.indexOf("--name") + 1];
  if (state.resources[name]) throw new Error("Container name reused");
  state.resources[name] = { type: "container", owner: args[args.indexOf("--label") + 1].split("=")[1], image: args.find(v => v.startsWith("sha256:")) };
  value = name;
} else if (args[0] === "inspect") {
  const resource = state.resources[args.at(-1)];
  const format = args[args.indexOf("--format") + 1];
  if (format.includes(".Image")) value = resource.image;
  else if (format.includes(".NetworkSettings.Ports")) value = JSON.stringify({ "80/tcp": process.env.FAKE_MODE === "assertion" ? [] : [{ HostIp: "127.0.0.1", HostPort: "9" }] });
  else value = resource.owner;
} else if (args[0] === "network" && args[1] === "inspect") {
  value = state.resources[args.at(-1)].owner;
} else if (args[0] === "logs") value = "fake startup log";
else if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) {
  if (state.resources[args.at(-1)].owner === "foreign") throw new Error("Foreign cleanup attempted");
  delete state.resources[args.at(-1)];
} else throw new Error("Unexpected fake Docker command " + JSON.stringify(args));
// The signal test polls concurrently; never expose a truncated JSON document.
const temporary = path + "." + process.pid + ".tmp";
fs.writeFileSync(temporary, JSON.stringify(state));
fs.renameSync(temporary, path);
fs.writeSync(1, value + "\\n");
`;

for (const signal of [null, "SIGINT", "SIGTERM"]) {
  test(`gateway probes clean owned resources after ${signal ?? "assertion failure"}`, { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vardum-gateway-signal-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), fakeDocker, { mode: 0o700 });
    const statePath = join(directory, "state.json");
    const foreign = { type: "container", owner: "foreign" };
    await writeFile(statePath, JSON.stringify({ resources: { unrelated: foreign }, commands: [] }));
    const destination = join(directory, "evidence");
    const child = spawn(process.execPath, [script, `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`, destination], {
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_STATE: statePath, FAKE_MODE: signal ? "signal" : "assertion" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, killedBy) => resolve({ code, killedBy }));
    });
    if (signal) {
      const deadline = Date.now() + 5_000;
      let ready = false;
      while (Date.now() < deadline) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        ready = state.commands.some(args => args[0] === "inspect" && args.includes("{{json .NetworkSettings.Ports}}"));
        if (ready) break;
        await delay(20);
      }
      assert.ok(ready, `Probe did not launch before signal: ${output}`);
      child.kill(signal);
    }
    const result = await completed;
    assert.equal(result.killedBy, null, output);
    assert.equal(result.code, signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1, output);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.resources, { unrelated: foreign }, output);
    const evidence = JSON.parse(await readFile(join(destination, "gateway-config-evidence.json"), "utf8"));
    assert.equal(evidence.status, signal ? "interrupted" : "incomplete");
    assert.equal(evidence.interruptedSignal, signal ?? undefined);
    assert.equal(evidence.cleanup.length, 4);
    assert.ok(evidence.cleanup.every(resource => resource.removed === true));
  });
}
