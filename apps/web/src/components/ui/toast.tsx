import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";

const tones = {
  success: "border-success-fg/40 bg-success-soft text-success-fg",
  error: "border-danger-fg/40 bg-danger-soft text-danger-fg",
  info: "border-line bg-surface text-fg",
} as const;

type Tone = keyof typeof tones;

function ToastList() {
  const { toasts } = Toast.useToastManager();
  const { t } = useI18n();
  return toasts.map((toast) => {
    const tone = (toast.type as Tone | undefined) ?? "info";
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={cn(
          "sob-rise pointer-events-auto flex w-full items-start gap-3 rounded-lg border p-3.5 shadow-lg",
          tones[tone],
        )}
      >
        <Toast.Content className="flex w-full items-start gap-3">
          <span className="mt-0.5 shrink-0">
            {tone === "error" ? <AlertIcon /> : tone === "success" ? <CheckIcon /> : null}
          </span>
          <Toast.Title className="flex-1 text-[0.95rem] font-medium leading-snug" />
          <Toast.Close
            aria-label={t("common.dismiss")}
            className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md opacity-80 hover:opacity-100"
          >
            <CloseIcon />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}

/** Mount once near the root. Toasts sit above the mobile bottom bar and are announced politely. */
export function ToastHost({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider timeout={5000} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] mx-auto flex w-full max-w-md flex-col gap-2 p-4 pb-[calc(1rem+var(--bottom-nav,0px)+env(safe-area-inset-bottom))] sm:bottom-[calc(var(--bottom-nav,0px)+1rem)] sm:right-4 sm:pb-4 md:bottom-4 sm:left-auto sm:mx-0">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useToast() {
  const manager = Toast.useToastManager();
  return {
    success: (title: string) => manager.add({ title, type: "success" }),
    error: (title: string) => manager.add({ title, type: "error", timeout: 8000 }),
    info: (title: string) => manager.add({ title, type: "info" }),
  };
}
