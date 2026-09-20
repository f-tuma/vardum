import type { ReactNode } from "react";
import { Modal } from "./modal";

export function FormDialog({
  open,
  title,
  pending = false,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  pending?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      label={title}
      className="panel-dialog form-dialog"
      initialFocus="input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled)"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <div className="panel-dialog-content">
        <header>
          <h2>{title}</h2>
          <button type="button" disabled={pending} onClick={onClose}>
            Close
          </button>
        </header>
        <div className="form-dialog-body" aria-busy={pending}>
          {children}
        </div>
      </div>
    </Modal>
  );
}
