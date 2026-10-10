import { useQueryClient } from "@tanstack/react-query";
import { mediaStem } from "@vardum/shared";
import { toast } from "sonner";
import { errorMessage, toKey } from "@/lib/format";
import { createAsset, uploadVersion, validateUploadFile } from "./asset-api";

function percent(fraction: number) {
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

/**
 * Uploads run in the background and report through toasts, so the user can
 * keep browsing while large files transfer.
 */
export function useUploader(workspaceId: string) {
  const queryClient = useQueryClient();

  function refresh() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["asset", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["asset-versions", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-overview", workspaceId] }),
    ]);
  }

  async function transfer(assetId: string, file: File) {
    const id = toast.loading(`Uploading ${file.name}`);
    try {
      await uploadVersion(workspaceId, assetId, file, (status, fraction) =>
        toast.loading(`Uploading ${file.name}`, {
          id,
          description: fraction === undefined ? status : percent(fraction),
        }),
      );
      toast.success(`${file.name} uploaded`, { id, description: "Processing…" });
    } catch (cause) {
      toast.error(`${file.name} failed`, {
        id,
        description: errorMessage(cause, "Upload failed"),
      });
    } finally {
      await refresh();
    }
  }

  /** Creates the asset first, so a taken key fails before any bytes move. */
  async function uploadNew(
    file: File,
    { prefix, key, displayName }: { prefix: string; key?: string; displayName?: string },
  ) {
    await validateUploadFile(file);
    const created = await createAsset(workspaceId, {
      key: `${prefix}${key || toKey(mediaStem(file.name))}`,
      displayName: displayName || mediaStem(file.name),
    });
    await refresh();
    void transfer(created.id, file);
    return created;
  }

  async function uploadMany(files: File[], prefix: string) {
    const keys = files.map((file) => `${prefix}${toKey(mediaStem(file.name))}`);
    if (new Set(keys).size !== keys.length)
      throw new Error("Some files have the same name without their extension. Upload them separately with different names.");
    await Promise.all(files.map(validateUploadFile));
    await Promise.all(
      files.map(async (file) => {
        try {
          await uploadNew(file, { prefix });
        } catch (cause) {
          toast.error(`${file.name} not uploaded`, {
            description: errorMessage(cause, "Upload failed"),
          });
        }
      }),
    );
  }

  async function uploadReplacement(assetId: string, file: File) {
    await validateUploadFile(file);
    void transfer(assetId, file);
  }

  return { uploadNew, uploadMany, uploadReplacement };
}
