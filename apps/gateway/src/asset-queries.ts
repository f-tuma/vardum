import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { listAssetVersions } from "./asset-api";

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
