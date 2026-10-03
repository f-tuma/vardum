import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Called only by smoke-production.sh, which owns and removes this disposable stack.
export async function checkRustfsRecovery({
  request,
  workspaceId,
  assetId,
  currentVersionId,
  file,
}) {
  const project = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(project ?? "", /^vardum-smoke-\d+$/);
  const compose = (...args) =>
    execFile(
      "docker",
      [
        "compose",
        "-p",
        project,
        "--profile",
        "rustfs",
        "-f",
        "compose.production.yml",
        ...args,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  const policy = (options) =>
    compose(
      "exec",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      `
    const { startQueue, stopQueue, assetIngestQueue } = await import('./dist/queue.js');
    try { const boss = await startQueue(); await boss.updateQueue(assetIngestQueue, ${JSON.stringify(options)}); }
    finally { await stopQueue(); }
  `,
    );
  const base = `/api/workspaces/${workspaceId}/assets/${assetId}`;
  let version;
  const monitoringHeaders = {
    authorization: `Bearer ${process.env.MONITORING_TOKEN}`,
  };
  async function waitHealth(matches) {
    const deadline = Date.now() + 100_000;
    let health;
    do {
      const response = await fetch(
        `${process.env.SMOKE_URL}/api/operations/health`,
        {
          headers: monitoringHeaders,
          signal: AbortSignal.timeout(10_000),
        },
      );
      health = await response.json();
      assert.equal(response.status, health.status === "healthy" ? 200 : 503);
      if (matches(health)) return health;
      await pause(1000);
    } while (Date.now() < deadline);
    throw new Error(
      `Operational health did not converge: ${JSON.stringify(health)}`,
    );
  }
  async function waitFor(status) {
    const deadline = Date.now() + 180_000;
    do {
      const history = await request(`${base}/versions`).then((r) => r.json());
      const row = history.versions.find((item) => item.id === version.id);
      if (row?.status === status) return { row, history };
      await pause(500);
    } while (Date.now() < deadline);
    throw new Error(`RustFS recovery: version did not become ${status}`);
  }

  try {
    const denied = await fetch(
      `${process.env.SMOKE_URL}/api/operations/metrics`,
    );
    assert.equal(denied.status, 401);
    await waitHealth((health) => health.status === "healthy");
    await compose("exec", "-T", "worker", "node", "dist/worker-healthcheck.js");
    // Freeze a real process: no graceful heartbeat cleanup can hide expiry bugs.
    await compose("pause", "worker");
    await waitHealth((health) => health.workers?.live === 0);
    assert.equal((await fetch(`${process.env.SMOKE_URL}/ready`)).status, 200);
    await compose("unpause", "worker");
    await waitHealth((health) => health.status === "healthy");
    console.log(
      "Worker heartbeat expiry and recovery detected while API readiness stayed available",
    );
    await compose("stop", "worker");
    // Shorten only this isolated stack's backoff; real automatic queue retries and
    // the worker's scheduled reconciliation still run without manual status edits.
    await policy({ retryLimit: 1, retryDelay: 1, retryBackoff: false });
    version = await request(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "recovery.svg",
        mimeType: file.type,
        size: file.size,
      }),
    }).then((r) => r.json());
    const form = new FormData();
    for (const [key, value] of Object.entries(version.upload.fields))
      form.append(key, value);
    form.append("file", file, "recovery.svg");
    const uploaded = await fetch(version.upload.url, {
      method: "POST",
      body: form,
    });
    assert.equal(uploaded.ok, true, `RustFS upload: ${uploaded.status}`);
    await request(`${base}/versions/${version.id}/finalize`, {
      method: "POST",
    });
    await compose("stop", "rustfs");
    await compose("start", "worker");
    const failed = await waitFor("failed");
    assert.equal(failed.row.retryable, true);
    assert.equal(failed.history.currentVersionId, currentVersionId);
    assert.match(failed.row.error, /repeated attempts/);
    await waitHealth(
      (health) =>
        !health.storage &&
        health.queues?.some(
          (queue) => queue.name === "asset-ingest" && queue.failed15m > 0,
        ),
    );
    const metrics = await fetch(
      `${process.env.SMOKE_URL}/api/operations/metrics`,
      { headers: monitoringHeaders },
    );
    assert.equal(metrics.status, 200);
    assert.match(
      await metrics.text(),
      /vardum_dependency_up\{dependency="storage"\} 0/,
    );

    await compose("up", "-d", "--wait", "--wait-timeout", "90", "rustfs");
    await compose("restart", "worker");
    const retry = await request(`${base}/versions/${version.id}/retry`, {
      method: "POST",
    });
    assert.equal(retry.status, 202);
    const ready = await waitFor("ready");
    assert.equal(ready.history.currentVersionId, version.id);
    assert.equal(ready.row.retryable, false);
    assert.equal(ready.row.error, null);
    assert.equal(
      ready.row.checksum,
      createHash("sha256")
        .update(Buffer.from(await file.arrayBuffer()))
        .digest("hex"),
    );
    await waitHealth((health) => health.status === "healthy");
    await compose("stop", "postgres");
    await waitHealth(
      (health) =>
        !health.database && health.workers === null && health.queues === null,
    );
    await compose("up", "-d", "--wait", "--wait-timeout", "90", "postgres");
    await waitHealth((health) => health.status === "healthy");
    console.log(
      "Authenticated monitoring detected RustFS and PostgreSQL outages and recovered without stale healthy metrics",
    );
    console.log(
      "Real RustFS outage: exhausted job reconciled; worker restart and authorized retry completed the same version",
    );
  } finally {
    await compose("unpause", "worker").catch(() => {});
    await compose("up", "-d", "--wait", "--wait-timeout", "90", "postgres");
    await compose("up", "-d", "--wait", "--wait-timeout", "90", "rustfs");
    await compose("start", "worker");
    await policy({ retryLimit: 3, retryDelay: 5, retryBackoff: true });
  }
}
