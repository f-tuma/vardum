import { mimeForFilename, supportedMimeTypes } from "@vardum/shared";
import { z } from "zod";

// Vardum's own layout. Importing from inside it would re-import originals and
// generated variants as if they were somebody's source files.
export const reservedPrefixes = ["originals/", "derived/"];

export const importSource = z
  .string()
  .max(1024)
  .refine(
    (value) => !reservedPrefixes.some((prefix) => value.startsWith(prefix)),
    { message: "That prefix holds Vardum's own objects" },
  );

/**
 * The asset key an object lands on: its path below the source prefix, with each
 * segment reduced to what an asset key may contain. Returns null when nothing
 * usable survives, so the caller skips the object instead of inventing a name.
 */
export function importedAssetKey(
  destinationPrefix: string,
  sourcePrefix: string,
  objectKey: string,
) {
  if (!objectKey.startsWith(sourcePrefix)) return null;
  const relative = objectKey.slice(sourcePrefix.length);
  if (!relative || relative.endsWith("/")) return null;

  const segments = relative.split("/").map(slugSegment);
  if (segments.some((segment) => !segment)) return null;

  const key = `${destinationPrefix}${segments.join("/")}`;
  return key.length <= 255 ? key : null;
}

/** The declared type for an imported object: what S3 says, else the extension. */
export function importedMimeType(
  objectKey: string,
  contentType: string | undefined,
) {
  const declared = supportedMimeTypes.find((type) => type === contentType);
  return declared ?? mimeForFilename(objectKey);
}

function slugSegment(segment: string) {
  return segment
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}
