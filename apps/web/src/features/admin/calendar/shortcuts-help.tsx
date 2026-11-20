import { Sheet } from "~/components/ui/sheet";
import { useI18n } from "~/i18n/react";

const ROWS = [
  ["t", "calendar.shortcuts.today"],
  ["← / [", "calendar.shortcuts.previous"],
  ["→ / ]", "calendar.shortcuts.next"],
  ["d", "calendar.shortcuts.day"],
  ["w", "calendar.shortcuts.week"],
  ["m", "calendar.shortcuts.month"],
  ["l", "calendar.shortcuts.list"],
  ["n", "calendar.shortcuts.new"],
  ["r", "calendar.shortcuts.refresh"],
  ["?", "calendar.shortcuts.help"],
] as const;

/** Documents every calendar shortcut, including the keyboard alternative to dragging. */
export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("shortcuts.title")}>
      <dl className="space-y-3">
        {ROWS.map(([keys, label]) => (
          <div key={keys} className="flex items-center justify-between gap-4">
            <dt className="text-[0.95rem]">{t(label)}</dt>
            <dd>
              <kbd className="whitespace-nowrap rounded-md border border-line-strong bg-sunken px-2 py-1 font-mono text-sm">
                {keys}
              </kbd>
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
          <dt className="text-[0.95rem]">{t("calendar.shortcuts.move")}</dt>
          <dd>
            <kbd className="whitespace-nowrap rounded-md border border-line-strong bg-sunken px-2 py-1 font-mono text-sm">
              {t("calendar.shortcuts.moveKeys")}
            </kbd>
          </dd>
        </div>
      </dl>
    </Sheet>
  );
}
