/**
 * The one place that decides which files Vardum accepts. The API validates
 * uploads against these lists, the dashboard and the CLI pick a MIME type for
 * a filename from them, and the accept attribute is derived from them — so a
 * new format is added here and nowhere else.
 */
export const supportedImageMimeTypes = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
] as const;

export const supportedVideoMimeTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/mpeg",
] as const;

export const supportedMimeTypes = [
  ...supportedImageMimeTypes,
  ...supportedVideoMimeTypes,
] as const;

export type SupportedMimeType = (typeof supportedMimeTypes)[number];

export const videoMimeSet: Set<string> = new Set(supportedVideoMimeTypes);

export function isVideoMimeType(mimeType: string | null | undefined) {
  return Boolean(mimeType && videoMimeSet.has(mimeType));
}

/** Extensions are the reliable signal: File.type is empty or non-canonical often enough. */
export const extensionMimeTypes: Record<string, SupportedMimeType> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  webm: "video/webm",
};

export function mimeForFilename(filename: string): SupportedMimeType | null {
  const extension = filename.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension && Object.hasOwn(extensionMimeTypes, extension)
    ? extensionMimeTypes[extension]!
    : null;
}

/** Value for a file input's accept attribute, e.g. ".avif,.gif,…". */
export const uploadAccept = Object.keys(extensionMimeTypes)
  .map((extension) => `.${extension}`)
  .join(",");

/** Per-kind upload ceilings in bytes, as the API reports them. */
export type UploadLimits = { image: number; video: number; file: number };

/** Files are the future generic kind: whatever is neither image nor video. */
export function uploadLimitFor(limits: UploadLimits, mimeType: string) {
  return videoMimeSet.has(mimeType)
    ? limits.video
    : mimeType.startsWith("image/")
      ? limits.image
      : limits.file;
}
