import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { CloseIcon } from "./icons";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Sticky footer, e.g. the primary actions. */
  footer?: ReactNode;
  /** Wider panel for forms with a side-by-side layout. */
  size?: "md" | "lg";
}

/**
 * Side panel on desktop, bottom sheet on phones. A modal Base UI dialog: focus is trapped,
 * Escape and the close button dismiss it, and the page behind is inert.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: SheetProps) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-end sm:place-items-stretch sm:justify-items-end">
          <Dialog.Popup
            className={cn(
              "sob-rise flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-lg",
              "transition-[transform,opacity] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0",
              "sm:max-h-none sm:h-dvh sm:rounded-none sm:rounded-l-xl sm:border-y-0 sm:border-r-0 sm:data-ending-style:translate-x-4 sm:data-ending-style:translate-y-0",
              size === "lg" ? "sm:max-w-2xl" : "sm:max-w-md",
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <Dialog.Title className="font-display text-xl font-semibold leading-tight">
                  {title}
                </Dialog.Title>
                {description && (
                  <Dialog.Description className="mt-1 text-sm text-muted">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close
                aria-label={t("sheet.close")}
                className="-m-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-fg"
              >
                <CloseIcon />
              </Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
            {footer && (
              <footer className="border-t border-line bg-surface px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                {footer}
              </footer>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
