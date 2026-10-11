import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliSetupCommand } from "./cli-setup";

test("copied setup preserves shell arguments and stops on a failed step", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vardum-setup-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = join(root, "commands.jsonl");
  for (const name of ["npm", "npx"])
    // oxlint-disable-next-line no-await-in-loop -- two tiny fixture files, order is irrelevant
    await writeFile(
      join(root, name),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAIL_INIT && process.argv.includes("init")) process.exit(1);
`,
      { mode: 0o755 },
    );
  const server = "https://example.com/it's-$(touch injected);echo";
  const command = cliSetupCommand(server, "workspace", "vard");
  assert.ok(!command.includes("\n"));
  const options = {
    cwd: root,
    env: { PATH: `${root}:${process.env.PATH}`, CAPTURE: capture },
  };
  const run = promisify(execFile);
  await run("sh", ["-c", command], options);
  const commands = (await readFile(capture, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(commands, [
    [
      "install",
      "--save-dev",
      "--save-exact",
      "@vardum/cli@0.8.0",
    ],
    [
      "--no-install",
      "vardum",
      "init",
      "--server",
      server,
      "--workspace",
      "workspace",
      "--vard",
      "vard",
    ],
    ["--no-install", "vardum", "login"],
    ["--no-install", "vardum", "pull"],
  ]);
  await assert.rejects(readFile(join(root, "injected")), { code: "ENOENT" });
  await writeFile(capture, "");
  await assert.rejects(
    run("sh", ["-c", command], {
      ...options,
      env: { ...options.env, FAIL_INIT: "1" },
    }),
  );
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 2);
});
