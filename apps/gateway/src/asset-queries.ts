import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { listAssetPage, listAssetVersions, type AssetPage } from "./asset-api";

export function assetBrowserQueryOptions(workspaceId: string, prefix = "", search = "", limit = 50) {
  const needle = search.trim();
  return infiniteQueryOptions({
    queryKey: ["assets", workspaceId, "cursor-v1", prefix, needle, limit],
    queryFn: ({ pageParam, signal }) => listAssetPage(workspaceId, prefix, needle, pageParam, limit, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    gcTime: 30 * 60_000,
    refetchInterval: (query) => query.state.data?.pages.some(
      (page) => page.assets.some(({ status }) => status === "processing"),
    ) ? 1500 : false,
  });
}

// Traversal is live. A forward rename can repeat an ID on a later page;
// retain the latest value while keeping the already-rendered item position.
export function flattenAssetPages(pages: AssetPage[] = []) {
  const folders = new Map<string, AssetPage["folders"][number]>();
  const assets = new Map<string, AssetPage["assets"][number]>();
  for (const page of pages) {
    for (const folder of page.folders) folders.set(folder.prefix, folder);
    for (const asset of page.assets) assets.set(asset.id, asset);
  }
  return { folders: [...folders.values()], assets: [...assets.values()] };
}

export function assetVersionHistoryQueryOptions(
  queryClient: QueryClient,
  workspaceId: string,
  assetId: string,
  currentVersionId: string | null,
) {
  let refreshedCurrentVersionId = currentVersionId;

  return queryOptions({
    queryKey: ["asset-versions", workspaceId, assetId, currentVersionId],
    queryFn: async () => {
      const history = await listAssetVersions(workspaceId, assetId);
      if (history.currentVersionId !== refreshedCurrentVersionId) {
        // An older retry can become current without changing the latest status,
        // so the detail query may not be polling when processing completes.
        await Promise.all([
          queryClient.invalidateQueries(
            { queryKey: ["asset", workspaceId, assetId], exact: true },
            { throwOnError: true },
          ),
          queryClient.invalidateQueries(
            { queryKey: ["assets", workspaceId] },
            { throwOnError: true },
          ),
        ]);
        // Keep repeated history polls bounded, but allow a failed refresh to retry.
        refreshedCurrentVersionId = history.currentVersionId;
      }
      return history;
    },
    refetchInterval: (query) =>
      query.state.data?.versions.some(
        (version) => version.status === "processing",
      )
        ? 1500
        : false,
  });
}
