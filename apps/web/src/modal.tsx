import { useEffect, useRef, type ReactNode } from "react";

// The one modal in the app: native <dialog>, backdrop click and Escape close it,
// focus returns where it came from. Style through className, not a second copy
// of this.
export function Modal({
  open,
  label,
  className = "panel-dialog",
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      restoreFocus(dialog, returnFocusRef.current);
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* Mounted only while open, so a dialog's queries start on demand. */}
      {open && children}
    </dialog>
  );
}

function restoreFocus(dialog: HTMLDialogElement, previous: HTMLElement | null) {
  // A <details> menu that opened the dialog is closed by now; focus its summary.
  const details = previous?.closest("details");
  const target =
    details && !details.open
      ? details.querySelector<HTMLElement>("summary")
      : previous;
  if (target?.isConnected) return target.focus();
  const main = dialog.closest<HTMLElement>("main");
  if (main) {
    main.tabIndex = -1;
    main.focus();
  }
}
