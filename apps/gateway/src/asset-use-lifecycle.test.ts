import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useEffect } from "react";

test("linked-only folder follows source completion after its source history observer unmounts", { timeout: 7000 }, async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:5173/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "Event", "MouseEvent", "CustomEvent", "FormData", "MutationObserver", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : Reflect.get(dom.window, key) });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Browser detection occurs at import time; real browser timers are necessary
  // to exercise scheduled refetches rather than inspecting an option function.
  const { QueryClient, QueryClientProvider, useInfiniteQuery } = await import("@tanstack/react-query");
  const { createRoot } = await import("react-dom/client");
  const { assetUseQueryOptions } = await import("./asset-queries.js");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.createElement("div"));
  t.after(async () => { await act(async () => { root.unmount(); client.clear(); }); dom.window.close(); });
  let version = "v1";
  let sourceProcessing = false;
  let reads = 0;
  let observed: { version?: string | null; processing?: boolean } = {};
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /\/asset-uses\?/);
    reads++;
    return Response.json({ uses: [{ id: "linked-icon", key: "mobile/icon", currentVersionId: version, sourceProcessing }], nextCursor: null });
  });
  function Folder() {
    const listing = useInfiniteQuery(assetUseQueryOptions("workspace", "mobile/"));
    const item = listing.data?.pages[0]?.uses[0];
    useEffect(() => { observed = { version: item?.currentVersionId, processing: item?.sourceProcessing }; }, [item?.currentVersionId, item?.sourceProcessing]);
    return null;
  }
  async function until(predicate: () => boolean, deadline = Date.now() + 3000): Promise<void> {
    if (predicate()) return;
    assert.ok(Date.now() < deadline, JSON.stringify({ observed, reads }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    return until(predicate, deadline);
  }
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(Folder))); });
  await until(() => observed.version === "v1");
  // Exactly the uploader's invalidation at finalize, while v1 is still current.
  sourceProcessing = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["asset-uses", "workspace"] }); });
  await until(() => observed.processing === true);
  version = "v2"; sourceProcessing = false;
  await until(() => observed.version === "v2" && observed.processing === false);
  const completedReads = reads;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1650)); });
  assert.equal(reads, completedReads, "polling stops after source completion");
});
