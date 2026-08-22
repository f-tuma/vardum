import { useEffect, useId, useRef, useState } from "react";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      setPending(false);
      const previous = returnFocusRef.current;
      const details = previous?.closest("details");
      const target =
        details && !details.open
          ? details.querySelector<HTMLElement>("summary")
          : previous;
      if (target?.isConnected) {
        target.focus();
      } else {
        const main = dialog.closest<HTMLElement>("main");
        if (main) {
          main.tabIndex = -1;
          main.focus();
        }
      }
    }
  }, [open]);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      if (dialogRef.current?.isConnected) onCancel();
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClick={(event) => {
        if (!pending && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirm-dialog-content">
        <header>
          <span>!! DESTRUCTIVE ACTION</span>
          <h2 id={titleId}>{title}</h2>
        </header>
        <p>{description}</p>
        <footer>
          <button
            ref={cancelRef}
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
