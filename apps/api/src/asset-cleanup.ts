import { deleteObjects, listObjectKeys } from "./storage.js";

export type AssetDeletePayload = {
  versionIds: string[];
  storageKeys: string[];
};

export async function deleteAssetObjects(payload: AssetDeletePayload) {
  const derivedKeys = (
    await Promise.all(
      payload.versionIds.map((versionId) =>
        listObjectKeys(`derived/v1/${versionId}/`),
      ),
    )
  ).flat();
  const keys = [...new Set([...payload.storageKeys, ...derivedKeys])];
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await deleteObjects(keys.slice(offset, offset + 1000));
  }
}
