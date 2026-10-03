import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  getAsset,
  listAssets,
  retryAssetVersion,
  type AssetSummary,
  type AssetVersion,
} from "./asset-api.js";
import { assetVersionHistoryQueryOptions } from "./asset-queries.js";

const workspaceId = "workspace";
const assetId = "asset";
const detailKey = ["asset", workspaceId, assetId];
const listKey = ["assets", workspaceId, "", ""];
const basePath = `/api/workspaces/${workspaceId}/assets`;

function version(
  id: string,
  number: number,
  status: AssetVersion["status"],
  current: boolean,
): AssetVersion {
  return {
    id,
    number,
    status,
    current,
    filename: `${id}.png`,
    mimeType: "image/png",
    size: number * 100,
    width: number * 10,
    height: number * 20,
    checksum: null,
    error: status === "failed" ? "Processing failed" : null,
    retryable: status === "failed",
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "user",
  };
}

function summary(
  current: "v1" | "v2",
  latestStatus: "failed" | "pending",
): AssetSummary {
  const number = current === "v1" ? 1 : 2;
  return {
    id: assetId,
    key: "image",
    displayName: "Image",
    isPublic: false,
    currentVersionId: current,
    latestVersionId: "v3",
    status: latestStatus,
    error: latestStatus === "failed" ? "Latest processing failed" : null,
    mimeType: "image/png",
    size: number * 100,
    width: number * 10,
    height: number * 20,
    thumbnailUrl: `/w/workspace/image?version=${current}`,
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

for (const latestStatus of ["failed", "pending"] as const) {
  const name = `older retry refreshes detail and list when latest v3 stays ${latestStatus}`;
  test(name, { timeout: 1000 }, async (t) => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    let phase: "failed" | "processing" | "ready" = "failed";
    let detailReads = 0;
    let listReads = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (url === `${basePath}/${assetId}/versions/v2/retry`) {
        assert.equal(init?.method, "POST");
        phase = "processing";
        return Response.json({ status: "processing" });
      }
      const current = phase === "ready" ? "v2" : "v1";
      if (url === `${basePath}/${assetId}/versions`) {
        return Response.json({
          currentVersionId: current,
          versions: [
            version("v3", 3, latestStatus, false),
            version("v2", 2, phase, current === "v2"),
            version("v1", 1, "ready", current === "v1"),
          ],
        });
      }
      if (url === `${basePath}/${assetId}`) {
        detailReads++;
        return Response.json(summary(current, latestStatus));
      }
      if (url === `${basePath}?prefix=`) {
        listReads++;
        return Response.json({
          folders: [],
          assets: [summary(current, latestStatus)],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const detailOptions = {
      queryKey: detailKey,
      queryFn: () => getAsset(workspaceId, assetId),
    };
    const listOptions = {
      queryKey: listKey,
      queryFn: () => listAssets(workspaceId),
    };
    const historyOptions = assetVersionHistoryQueryOptions(
      queryClient, workspaceId, assetId, "v1",
    );
    await Promise.all([
      queryClient.fetchQuery(detailOptions),
      queryClient.fetchQuery(listOptions),
      queryClient.fetchQuery(historyOptions),
    ]);
    const detail = new QueryObserver(queryClient, detailOptions);
    const history = new QueryObserver(queryClient, historyOptions);
    const stopDetail = detail.subscribe(() => {});
    const stopHistory = history.subscribe(() => {});
    const invalidated: unknown[][] = [];
    const stopCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "invalidate") {
        invalidated.push([...event.query.queryKey]);
      }
    });
    t.after(() => {
      stopCache();
      stopHistory();
      stopDetail();
      queryClient.clear();
    });
    queryClient.setQueryData(
      ["asset", workspaceId, "another-asset"], summary("v1", latestStatus),
    );
    queryClient.setQueryData(
      ["assets", "another-workspace"], { folders: [], assets: [] },
    );

    await retryAssetVersion(workspaceId, assetId, "v2");
    // The existing mutation refresh happens before the older version is ready.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["asset", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] }),
      queryClient.invalidateQueries({
        queryKey: ["asset-versions", workspaceId, assetId],
      }),
    ]);
    assert.equal(detail.getCurrentResult().data?.currentVersionId, "v1");
    assert.equal(detail.getCurrentResult().data?.status, latestStatus);
    assert.equal(detailReads, 2);
    assert.equal(
      history.getCurrentResult().data?.versions.find(({ id }) => id === "v2")?.status,
      "processing",
    );
    const historyQuery = history.getCurrentQuery();
    const polling = historyOptions.refetchInterval;
    assert.equal(typeof polling, "function");
    assert.equal(
      typeof polling === "function" ? polling(historyQuery) : undefined,
      1500,
    );
    // A cached list can have refreshed during processing and still show v1.
    await queryClient.fetchQuery(listOptions);
    assert.equal(queryClient.getQueryState(listKey)?.isInvalidated, false);
    queryClient.setQueryData(
      ["asset", workspaceId, "another-asset"], summary("v1", latestStatus),
    );
    const beforeCompletion = invalidated.length;
    const readsBeforeCompletion = detailReads;

    phase = "ready";
    // This is the history poll which previously left detail at v1 until reload.
    await history.refetch({ throwOnError: true });
    assert.equal(history.getCurrentResult().data?.currentVersionId, "v2");
    assert.deepEqual(detail.getCurrentResult().data, summary("v2", latestStatus));
    assert.equal(detailReads, readsBeforeCompletion + 1);
    assert.deepEqual(invalidated.slice(beforeCompletion), [detailKey, listKey]);
    assert.equal(queryClient.getQueryState(listKey)?.isInvalidated, true);
    assert.equal(
      typeof polling === "function" ? polling(historyQuery) : undefined,
      false,
    );
    const afterCompletion = invalidated.length;

    // Repeated reads on the old options remain bounded while React catches up.
    await history.refetch({ throwOnError: true });
    await history.refetch({ throwOnError: true });
    assert.equal(invalidated.length, afterCompletion);
    assert.equal(detailReads, readsBeforeCompletion + 1);
    // Production recreates the memoized options when detail's current ID agrees.
    history.setOptions(
      assetVersionHistoryQueryOptions(queryClient, workspaceId, assetId, "v2"),
    );
    await history.refetch({ throwOnError: true });
    await history.refetch({ throwOnError: true });
    assert.equal(invalidated.length, afterCompletion);
    assert.equal(detailReads, readsBeforeCompletion + 1);
    assert.equal(
      queryClient.getQueryState(["asset", workspaceId, "another-asset"])?.isInvalidated,
      false,
    );
    assert.equal(
      queryClient.getQueryState(["assets", "another-workspace"])?.isInvalidated,
      false,
    );

    // The inactive list is stale; opening it refetches the changed current metadata.
    const list = new QueryObserver(queryClient, listOptions);
    await new Promise<void>((resolve, reject) => {
      t.after(
        list.subscribe((result) => {
          if (result.isError) reject(result.error);
          else if (result.isSuccess && !result.isFetching) resolve();
        }),
      );
    });
    assert.deepEqual(list.getCurrentResult().data?.assets, [
      summary("v2", latestStatus),
    ]);
    assert.equal(listReads, 3);
  });
}

test("a transient detail refresh failure does not poison synchronization for the same current ID", async (t) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  let ready = false;
  let failDetail = true;
  let detailReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === `${basePath}/${assetId}/versions`) {
      return Response.json({
        currentVersionId: ready ? "v2" : "v1",
        versions: [
          version("v2", 2, ready ? "ready" : "processing", ready),
          version("v1", 1, "ready", !ready),
        ],
      });
    }
    assert.equal(url, `${basePath}/${assetId}`);
    detailReads++;
    if (failDetail) {
      failDetail = false;
      return Response.json(
        { message: "Detail temporarily unavailable" }, { status: 503 },
      );
    }
    return Response.json(summary("v2", "failed"));
  });
  const detailOptions = {
    queryKey: detailKey,
    queryFn: () => getAsset(workspaceId, assetId),
  };
  queryClient.setQueryData(detailKey, summary("v1", "failed"));
  const historyOptions = assetVersionHistoryQueryOptions(
    queryClient, workspaceId, assetId, "v1",
  );
  await queryClient.fetchQuery(historyOptions);
  const detail = new QueryObserver(queryClient, detailOptions);
  const history = new QueryObserver(queryClient, historyOptions);
  const stopDetail = detail.subscribe(() => {});
  const stopHistory = history.subscribe(() => {});
  t.after(() => {
    stopHistory();
    stopDetail();
    queryClient.clear();
  });

  ready = true;
  await assert.rejects(
    history.refetch({ throwOnError: true }), /Detail temporarily unavailable/,
  );
  assert.equal(detail.getCurrentResult().data?.currentVersionId, "v1");
  assert.equal(detailReads, 1);
  await history.refetch({ throwOnError: true });
  assert.equal(detail.getCurrentResult().data?.currentVersionId, "v2");
  assert.equal(history.getCurrentResult().data?.currentVersionId, "v2");
  assert.equal(detailReads, 2);
  await history.refetch({ throwOnError: true });
  assert.equal(detailReads, 2);
});
