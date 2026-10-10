import { isVideoMimeType } from "@vardum/shared";
import { FileIcon } from "lucide-react";
import { useState } from "react";

/** Image or muted video still for an asset; a file glyph when there is none. */
export function AssetThumb({
  url,
  mimeType,
  label = "",
  controls = false,
}: {
  url: string | null | undefined;
  mimeType: string | null | undefined;
  label?: string;
  controls?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const available = url && url !== failedUrl;
  if (!available)
    return (
      <span className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
        <FileIcon aria-hidden="true" />
        {url ? "Preview unavailable" : "No preview"}
      </span>
    );
  if (isVideoMimeType(mimeType) || mimeType?.startsWith("video/"))
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- uploaded assets carry no caption track
      <video
        src={url}
        controls={controls}
        muted={!controls}
        playsInline
        preload="metadata"
        aria-label={label || undefined}
        aria-hidden={!controls || undefined}
        tabIndex={controls ? 0 : -1}
        className="size-full object-scale-down"
        onError={() => setFailedUrl(url)}
      />
    );
  return (
    <img
      src={url}
      alt={label}
      loading="lazy"
      className="size-full object-scale-down"
      onError={() => setFailedUrl(url)}
    />
  );
}
