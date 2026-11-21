import { Dialog } from "@base-ui/react/dialog";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { Button } from "./button";
import { useSheetFooterInset } from "./sheet-footer-inset";

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
  confirmDisabled?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
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
  confirmDisabled = false,
  returnFocus,
  children,
}: ConfirmDialogProps) {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  useSheetFooterInset(open, actions, true);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-end sm:place-items-center">
          <Dialog.Popup
            initialFocus={destructive ? cancelButton : undefined}
            finalFocus={returnFocus}
            className="sob-rise flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-lg transition-[transform,opacity] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 sm:rounded-xl"
          >
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region needs keyboard focus for Page Down and arrow navigation */}
            <section aria-label={title} tabIndex={0} className="min-h-0 overflow-y-auto p-6">
              <Dialog.Title className="font-display text-xl font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-2 text-muted">{description}</Dialog.Description>
              {children}
            </section>
            <div
              ref={setActions}
              data-dialog-actions
              className="flex shrink-0 flex-col-reverse gap-3 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-6"
            >
              <Button
                ref={cancelButton}
                variant="secondary"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {cancelLabel}
              </Button>
              <Button
                variant={destructive ? "danger" : "primary"}
                onClick={onConfirm}
                loading={pending}
                disabled={confirmDisabled}
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
