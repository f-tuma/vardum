import { mimeForFilename, type SupportedMimeType } from "./mime.js";

/** Strip the final supported media suffix, never dots in a directory or stem. */
export function mediaStem(path: string) {
  const start = path.lastIndexOf("/") + 1;
  const dot = path.lastIndexOf(".");
  return dot > start && mimeForFilename(path.slice(start))
    ? path.slice(0, dot)
    : path;
}

const mimeExtensions: Record<SupportedMimeType, string> = {
  "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg",
  "image/png": "png", "image/svg+xml": "svg", "image/tiff": "tiff",
  "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  "video/quicktime": "mov", "video/x-msvideo": "avi", "video/mpeg": "mpeg",
};

/** Project files keep one suffix for their output format; library names do not. */
export function mediaOutputPath(path: string, mimeType: string) {
  const extension = Object.hasOwn(mimeExtensions, mimeType)
    ? mimeExtensions[mimeType as SupportedMimeType]
    : undefined;
  return extension ? `${mediaStem(path)}.${extension}` : path;
}
