import assert from "node:assert/strict";
import test from "node:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import type { AssetPage, AssetSummary } from "./asset-api.js";
import {
  assetBrowserQueryOptions,
  flattenAssetPages,
} from "./asset-queries.js";

function asset(
  id: string,
  status: AssetSummary["status"] = "ready",
): AssetSummary {
  return {
    id,
    key: `${id}.png`,
    displayName: id,
    status,
    isPublic: false,
    currentVersionId: null,
    latestVersionId: null,
    error: null,
    mimeType: "image/png",
    size: 100,
    width: 1,
    height: 1,
    thumbnailUrl: null,
    updatedAt: "2026-10-03T00:00:00Z",
  };
}

test("loads beyond 100 items, keeps prior pages on failure and retries the same cursor", async (t) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const calls: Array<string | null> = [];
  let fail = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (raw: string, init?: RequestInit) => {
      const url = new URL(raw, "http://test");
      assert.equal(url.searchParams.get("pagination"), "cursor");
      assert.equal(url.searchParams.get("limit"), "50");
      assert.ok(init?.signal instanceof AbortSignal);
      const cursor = url.searchParams.get("cursor");
      calls.push(cursor);
      if (cursor === "page-100" && fail)
        return Response.json({ message: "Temporary failure" }, { status: 503 });
      const start = cursor === "page-50" ? 50 : cursor === "page-100" ? 100 : 0;
      return Response.json({
        folders: [],
        assets: Array.from({ length: Math.min(50, 123 - start) }, (_, i) =>
          asset(String(start + i)),
        ),
        nextCursor: start < 100 ? `page-${start + 50}` : null,
      });
    },
  );
  const observer = new InfiniteQueryObserver(
    client,
    assetBrowserQueryOptions("ws"),
  );
  const stop = observer.subscribe(() => {});
  t.after(() => {
    stop();
    client.clear();
  });
  await observer.refetch();
  await observer.fetchNextPage({ cancelRefetch: false });
  assert.equal(
    flattenAssetPages(observer.getCurrentResult().data?.pages).assets.length,
    100,
  );
  await observer.fetchNextPage({ cancelRefetch: false });
  assert.equal(observer.getCurrentResult().isFetchNextPageError, true);
  assert.equal(observer.getCurrentResult().error?.message, "Temporary failure");
  assert.equal(
    flattenAssetPages(observer.getCurrentResult().data?.pages).assets.length,
    100,
  );
  fail = false;
  await observer.fetchNextPage({ cancelRefetch: false });
  const result = observer.getCurrentResult();
  assert.equal(result.isError, false);
  assert.equal(result.hasNextPage, false);
  assert.equal(flattenAssetPages(result.data?.pages).assets.length, 123);
  assert.deepEqual(calls, [null, "page-50", "page-100", "page-100"]);
});

test("stale refresh follows freshly issued cursors; workspace invalidation includes later processing pages", async (t) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let revision = 0;
  const calls: Array<string | null> = [];
  t.mock.method(globalThis, "fetch", async (raw: string) => {
    const cursor = new URL(raw, "http://test").searchParams.get("cursor");
    calls.push(cursor);
    assert.ok(cursor === null || cursor === `cursor-${revision}`);
    return Response.json({
      folders: [],
      assets: [
        asset(
          cursor ? "later" : "first",
          cursor && revision === 0 ? "processing" : "ready",
        ),
      ],
      nextCursor: cursor ? null : `cursor-${revision}`,
    });
  });
  const options = assetBrowserQueryOptions("ws");
  const observer = new InfiniteQueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  t.after(() => {
    stop();
    client.clear();
  });
  await observer.refetch();
  await observer.fetchNextPage();
  const interval = options.refetchInterval;
  assert.equal(
    typeof interval === "function"
      ? interval(observer.getCurrentQuery())
      : undefined,
    1500,
  );
  client.setQueryData(["assets", "other", "cursor-v1", "", "", 50], {
    pages: [],
    pageParams: [],
  });
  revision = 1;
  await client.invalidateQueries({ queryKey: ["assets", "ws"] });
  assert.deepEqual(calls, [null, "cursor-0", null, "cursor-1"]);
  assert.equal(
    observer.getCurrentResult().data?.pages[1]?.assets[0]?.status,
    "ready",
  );
  assert.equal(
    typeof interval === "function"
      ? interval(observer.getCurrentQuery())
      : undefined,
    false,
  );
  assert.equal(
    client.getQueryState(["assets", "other", "cursor-v1", "", "", 50])
      ?.isInvalidated,
    false,
  );
});

test("live forward rename duplicates retain latest values without moving visible item positions", () => {
  const first = asset("a", "processing");
  const last = { ...asset("a"), key: "z.png", displayName: "Renamed" };
  const pages: AssetPage[] = [
    {
      folders: [{ name: "one", prefix: "one/" }],
      assets: [first, asset("b")],
      nextCursor: "next",
    },
    {
      folders: [
        { name: "updated", prefix: "one/" },
        { name: "two", prefix: "two/" },
      ],
      assets: [last, asset("c")],
      nextCursor: null,
    },
  ];
  const flattened = flattenAssetPages(pages);
  assert.deepEqual(
    flattened.assets.map(({ id }) => id),
    ["a", "b", "c"],
  );
  assert.deepEqual(flattened.assets[0], last);
  assert.deepEqual(flattened.folders, [
    { name: "updated", prefix: "one/" },
    { name: "two", prefix: "two/" },
  ]);
});

test("changing folder or search has an isolated cache and cancellation reaches fetch", async (t) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const old = assetBrowserQueryOptions("ws", "one/", "  words  ");
  const folder = assetBrowserQueryOptions("ws", "two/", "words");
  const other = assetBrowserQueryOptions("else", "one/", "words");
  assert.notDeepEqual(old.queryKey, folder.queryKey);
  assert.notDeepEqual(old.queryKey, other.queryKey);
  assert.deepEqual(
    old.queryKey,
    assetBrowserQueryOptions("ws", "one/", "words").queryKey,
  );
  let signal: AbortSignal | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (raw: string, init?: RequestInit) => {
      const url = new URL(raw, "http://test");
      assert.equal(url.searchParams.get("search"), "words");
      assert.equal(url.searchParams.get("prefix"), "one/");
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
    },
  );
  t.after(() => client.clear());
  const pending = client.fetchInfiniteQuery(old).catch(() => undefined);
  await client.cancelQueries({ queryKey: old.queryKey, exact: true });
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(client.getQueryData(folder.queryKey), undefined);
});
