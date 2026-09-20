import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    const hide = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".info-tip-position")
      )
        return;
      setPosition(null);
    };
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open]);

  function show(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const useBelow = below >= Math.min(300, above);
    setPosition({
      maxHeight: Math.max(60, (useBelow ? below : above) - 12),
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      ...(useBelow
        ? { top: rect.bottom }
        : { bottom: window.innerHeight - rect.top }),
    });
  }

  return (
    <span className="info-tip" onMouseLeave={() => setPosition(null)}>
      <button
        type="button"
        className="info-tip-trigger"
        aria-label={label}
        aria-describedby={position ? id : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setPosition(null)}
        onClick={(event) => show(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setPosition(null);
          }
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" />
          <path d="M8 7v4" stroke="currentColor" />
          <circle cx="8" cy="4.5" r=".75" fill="currentColor" />
        </svg>
      </button>
      {position &&
        createPortal(
          <span className="info-tip-position" style={position}>
            <span id={id} role="tooltip" className="info-tip-content">
              {children}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
