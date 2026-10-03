/** Explicit root is a valid origin; only direct links fall back to the key folder. */
export function assetOrigin(key: string, fromPrefix?: string, fromSearch = "") {
  const slash = key.lastIndexOf("/");
  const prefix =
    fromPrefix ??
    (fromSearch ? "" : slash === -1 ? "" : key.slice(0, slash + 1));
  return { prefix, ...(fromSearch ? { q: fromSearch } : {}) };
}
