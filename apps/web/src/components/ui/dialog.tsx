import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  pending?: boolean;
  children?: ReactNode;
}

/** Modal confirmation: focus is trapped, Escape and the cancel button close it. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-end sm:place-items-center">
          <Dialog.Popup className="sob-rise w-full max-w-md rounded-t-xl border border-line bg-surface p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-lg transition-[transform,opacity] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 sm:rounded-xl sm:pb-6">
            <Dialog.Title className="font-display text-xl font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-muted">{description}</Dialog.Description>
            {children}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                {cancelLabel}
              </Button>
              <Button
                variant={destructive ? "danger" : "primary"}
                onClick={onConfirm}
                loading={pending}
              >
                {confirmLabel}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
