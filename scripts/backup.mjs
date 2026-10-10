#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "./release-packages.mjs";

// Operates only on the explicitly named Compose project. Never wipes a target.
const repo = fileURLToPath(new URL("../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    "env-file": { type: "string" },
    "compose-file": { type: "string", default: "compose.production.yml" },
    directory: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "node scripts/backup.mjs <create|verify|restore> --project NAME --env-file PATH --directory PATH [--compose-file compose.production.yml]\nCreate stops gateway/API/worker and leaves them stopped. Restore requires a stopped application, an empty database and an empty bucket. See docs/operations.md.",
  );
} else {
  const [action] = positionals;
  assert.ok(
    positionals.length === 1 &&
      ["create", "verify", "restore"].includes(action),
    "Choose create, verify or restore (see --help)",
  );
  assert.match(
    values.project ?? "",
    /^[a-z0-9][a-z0-9_-]*$/,
    "An explicit Compose project is required",
  );
  assert.ok(
    values["env-file"] && values.directory,
    "Explicit --env-file and --directory are required",
  );
  const directory = resolve(values.directory);
  assert.ok(
    !/[:,]/.test(directory),
    "Backup directory must not contain colons or commas (Docker mount syntax)",
  );
  const envFile = resolve(values["env-file"]);
  await lstat(envFile);
  const composeArgs = [
    "compose",
    "--env-file",
    envFile,
    "-p",
    values.project,
    "-f",
    resolve(values["compose-file"]),
  ];
  const compose = (...args) =>
    run("docker", [...composeArgs, ...(args[0] === "run" ? ["run", "--pull", "never", ...args.slice(1)] : args)], {
      cwd: repo,
      timeout: 30 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const tool = async (command, source) => {
    const { stdout } = await compose(
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--volume",
      `${directory}:/backup${command === "snapshot" ? "" : ":ro"}`,
      "api",
      "node",
      "dist/object-backup.js",
      command,
      "/backup",
      ...(source ? [JSON.stringify(source)] : []),
    );
    if (stdout.trim()) console.log(stdout.trim());
  };
  const sql = async (query) =>
    (
      await compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-X",
        "-U",
        "varda",
        "-d",
        "varda",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        query,
      )
    ).stdout.trim();
  const checkArchive = () =>
    compose(
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--volume",
      `${directory}:/backup:ro`,
      "postgres",
      "pg_restore",
      "--list",
      "/backup/postgres.dump",
    );
  async function streamDatabase(args, { input, output } = {}) {
    const child = spawn(
      "docker",
      [...composeArgs, "exec", "-T", "postgres", ...args],
      {
        cwd: repo,
        timeout: 30 * 60_000,
        stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"],
      },
    );
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText = (errorText + chunk).slice(-8192);
    });
    const completed = new Promise((yes, no) => {
      child.once("error", no);
      child.once("close", (code) =>
        code === 0
          ? yes()
          : no(new Error(`${args[0]} failed (${code}): ${errorText}`)),
      );
    });
    const pipes = [completed];
    if (input) pipes.push(pipeline(createReadStream(input), child.stdin));
    if (output)
      pipes.push(
        pipeline(
          child.stdout,
          createWriteStream(output, { flags: "wx", mode: 0o600 }),
        ),
      );
    try {
      await Promise.all(pipes);
    } catch (error) {
      child.kill("SIGTERM");
      await Promise.allSettled(pipes);
      throw error;
    }
  }
  const began = Date.now();
  if (action === "create") {
    // Validate the source before interrupting service or creating a backup marker.
    const details = JSON.parse(
      await sql(
        "SELECT json_build_object('postgresVersion',current_setting('server_version'),'migrations',(SELECT json_agg(json_build_object('hash',hash,'createdAt',created_at::text) ORDER BY id) FROM drizzle.__drizzle_migrations))",
      ),
    );
    assert.ok(
      details.migrations?.length,
      "Source must be a migrated Vardum database",
    );
    const containers = (await compose("ps", "--all", "-q", "api")).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(containers.length, "The source must have an API container");
    const images = new Set(
      (
        await run("docker", [
          "inspect",
          "--format",
          "{{.Image}}",
          ...containers,
        ])
      ).stdout
        .trim()
        .split("\n"),
    );
    assert.equal(
      images.size,
      1,
      "Finish the deployment before backing up mixed API versions",
    );
    const image = [...images][0];
    process.umask(0o077);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }); // Existing directories are never reused.
    await compose("stop", "gateway", "api", "worker");
    console.log(
      "Application stopped. Keep external bucket writers blocked until backup completes.",
    );
    await streamDatabase(
      [
        "psql",
        "-X",
        "-U",
        "varda",
        "-d",
        "varda",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SELECT coalesce(json_agg(json_build_object('key',storage_key,'size',size,'sha256',checksum) ORDER BY storage_key),'[]'::json) FROM asset_version WHERE status IN ('ready','processing')",
      ],
      { output: join(directory, "references.json") },
    );
    await streamDatabase(
      [
        "pg_dump",
        "-U",
        "varda",
        "-d",
        "varda",
        "-Fc",
        "--exclude-table-data=public.worker_heartbeat",
      ],
      { output: join(directory, "postgres.dump") },
    );
    await checkArchive();
    await tool("snapshot", { project: values.project, image, ...details });
    await tool("verify");
  } else {
    // Local checksums and archive structure are checked before destination writes.
    assert.ok(
      (await lstat(directory)).isDirectory(),
      "Backup must be a directory, not a symlink",
    );
    await tool("verify");
    await checkArchive();
    if (action === "restore") {
      const running = (
        await compose("ps", "--services", "--status", "running")
      ).stdout
        .trim()
        .split("\n");
      assert.ok(
        !running.some((service) =>
          ["api", "worker", "gateway"].includes(service),
        ),
        "Stop the destination application before restoring",
      );
      assert.equal(
        await sql(
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'",
        ),
        "0",
        "Restore requires an empty destination database; nothing was overwritten",
      );
      await tool("empty");
      await streamDatabase(
        [
          "pg_restore",
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-acl",
          "-U",
          "varda",
          "-d",
          "varda",
        ],
        { input: join(directory, "postgres.dump") },
      );
      await tool("restore");
      // Restore schema/data first; the migrator then recreates the limited role and grants.
      await compose("run", "--rm", "--no-deps", "-T", "migrate");
      await sql("ANALYZE");
    }
  }
  console.log(
    `${action} completed in ${((Date.now() - began) / 1000).toFixed(1)}s. Application services were not started. Keep this backup and deployment secrets encrypted off-host.`,
  );
}
