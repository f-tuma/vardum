import { useState } from "react";
import { Modal } from "./modal";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  tone = "danger",
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  tone?: "danger" | "neutral";
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onCancel();
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      label={title}
      className={`confirm-dialog ${tone === "neutral" ? "confirm-neutral" : ""}`}
      onClose={() => {
        if (!pending) onCancel();
      }}
    >
      <div className="confirm-dialog-content">
        <header>
          <span>
            {tone === "danger" ? "!! DESTRUCTIVE ACTION" : "CONFIRM CHANGE"}
          </span>
          <h2>{title}</h2>
        </header>
        <p>{description}</p>
        <footer>
          <button type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={tone === "danger" ? "danger-button" : "primary-button"}
            type="button"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
