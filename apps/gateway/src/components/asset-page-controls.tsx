import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function AssetPageControls({
  loaded,
  hasMore,
  fetching,
  loadingMore,
  error,
  nextPageError,
  onMore,
  onRetry,
}: {
  loaded: number;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  error?: string;
  nextPageError: boolean;
  onMore: () => void;
  onRetry: () => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLOutputElement>(null);
  const wasMore = useRef(hasMore);
  const requestedMore = useRef(false);
  useEffect(() => {
    if (
      wasMore.current &&
      !hasMore &&
      requestedMore.current &&
      (document.activeElement === document.body ||
        document.activeElement === more.current)
    )
      status.current?.focus();
    wasMore.current = hasMore;
  }, [hasMore]);
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <output
          ref={status}
          tabIndex={-1}
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {loaded} {hasMore ? "items loaded" : "items"}
        </output>
        <div className="flex flex-wrap items-center gap-2">
        {error && !nextPageError && (
          <Button variant="outline" disabled={fetching} onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            Retry refresh
          </Button>
        )}
        {hasMore || nextPageError ? (
          <Button
            ref={more}
            variant="outline"
            disabled={fetching}
            onClick={() => {
              requestedMore.current = true;
              onMore();
            }}
            onBlur={(event) => {
              if (event.relatedTarget) requestedMore.current = false;
            }}
          >
            {loadingMore ? <Spinner data-icon="inline-start" /> : null}
            {loadingMore
              ? "Loading…"
              : nextPageError
                ? "Retry loading more"
                : "Load more"}
          </Button>
        ) : null}
        </div>
      </div>
    </div>
  );
}
