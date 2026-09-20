import { useState } from "react";

export function VardFilePreview({
  url,
  mimeType,
  label,
  controls = false,
}: {
  url: string | null | undefined;
  mimeType: string | null | undefined;
  label?: string;
  controls?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const available = url && url !== failedUrl;
  return (
    <span className="vard-file-preview">
      {available && mimeType?.startsWith("image/") ? (
        <img
          src={url}
          alt={label ?? ""}
          loading="lazy"
          onError={() => setFailedUrl(url)}
        />
      ) : available && mimeType?.startsWith("video/") ? (
        <video
          src={url}
          controls={controls}
          muted={!controls}
          playsInline
          preload="metadata"
          aria-label={label}
          aria-hidden={!controls || undefined}
          tabIndex={controls ? 0 : -1}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="vard-file-placeholder">
          <span aria-hidden="true">▤</span>
          <span>
            {url === failedUrl && url
              ? "Preview unavailable"
              : url
                ? "No preview"
                : "Not ready"}
          </span>
        </span>
      )}
    </span>
  );
}
