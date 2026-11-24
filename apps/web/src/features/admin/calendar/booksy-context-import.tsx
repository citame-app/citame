import {
  booksyContextImportSchema,
  type BooksyContextImport as ImportPayload,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Sheet } from "~/components/ui/sheet";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { invalidateCalendarData } from "./cache";

export function BooksyContextImport() {
  const { t, locale, timeZone } = useI18n();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ImportPayload | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const preview = useMutation({
    mutationFn: (value: ImportPayload) => api().appointments.previewBooksyContext(value),
  });
  const apply = useMutation({
    mutationFn: ({ value, hash }: { value: ImportPayload; hash: string }) =>
      api().appointments.importBooksyContext(value, hash),
    onSuccess: () => {
      setDone(true);
      void invalidateCalendarData(queries);
    },
  });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t("badge.import")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={t("badge.import")}>
        <div className="space-y-5">
          <p className="text-sm text-muted">{t("badge.importDescription")}</p>
          <p className="rounded-lg border border-line bg-sunken p-3 text-sm">
            {t("badge.importSafety")}
          </p>
          <label className="block space-y-2 text-sm font-medium">
            <span>{t("badge.importFile")}</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={preview.isPending || apply.isPending}
              className="block max-w-full text-sm"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                preview.reset();
                apply.reset();
                setDone(false);
                setInput(null);
                setInvalid(false);
                if (!file) return;
                try {
                  if (file.size > 2_000_000) throw new Error("size");
                  const parsed = booksyContextImportSchema.parse(JSON.parse(await file.text()));
                  setInput(parsed);
                } catch {
                  setInvalid(true);
                }
              }}
            />
          </label>
          {invalid && (
            <p role="alert" className="text-sm text-danger-fg">
              {t("badge.importInvalid")}
            </p>
          )}
          {input && !done && (
            <Button
              variant="secondary"
              loading={preview.isPending}
              disabled={apply.isPending}
              onClick={() => preview.mutate(input)}
            >
              {t("badge.importPreview")}
            </Button>
          )}
          {preview.data && (
            <dl className="grid grid-cols-2 gap-3 rounded-xl border border-line p-4 text-sm">
              <dt>{t("badge.importAppointments")}</dt>
              <dd>{preview.data.appointments}</dd>
              <dt>{t("drawer.services")}</dt>
              <dd>{preview.data.services}</dd>
              <dt>{t("badge.internal")}</dt>
              <dd>{preview.data.internalNotes}</dd>
              <dt>{t("badge.customer")}</dt>
              <dd>{preview.data.customerComments}</dd>
              <dt>{t("badge.requested")}</dt>
              <dd>{preview.data.requested}</dd>
              <dt>{t("badge.invoicedBooksy")}</dt>
              <dd>{preview.data.invoiced}</dd>
              <dt>{t("badge.paidBooksy")}</dt>
              <dd>{preview.data.paid}</dd>
              {preview.data.paymentReviewsReopened !== undefined && (
                <>
                  <dt>{t("badge.importPaymentReviews")}</dt>
                  <dd>{preview.data.paymentReviewsReopened}</dd>
                </>
              )}
            </dl>
          )}
          {preview.data && (
            <ul className="max-h-72 space-y-3 overflow-auto rounded-xl border border-line p-4 text-sm">
              {preview.data.items.map((item) => (
                <li
                  key={`${item.appointmentId}:${item.servicePosition}`}
                  className="border-b border-line pb-3 last:border-0"
                >
                  <p className="font-medium">{item.serviceName}</p>
                  <p>{new Date(item.startsAt).toLocaleString(locale, { timeZone })}</p>
                  <p className="text-muted">
                    {t(
                      item.action === "add"
                        ? "badge.importAdd"
                        : item.action === "update"
                          ? "badge.importUpdate"
                          : "badge.importUnchanged",
                    )}
                  </p>
                  <p className="break-all text-xs text-muted">
                    {item.sourceRef} · {item.appointmentId}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {(preview.isError || apply.isError) && (
            <p role="alert" className="text-sm text-danger-fg">
              {t("badge.importError")}
            </p>
          )}
          {done ? (
            <p role="status" className="font-medium">
              {t("badge.importDone")}
            </p>
          ) : (
            preview.data &&
            input && (
              <Button
                loading={apply.isPending}
                onClick={() => apply.mutate({ value: input, hash: preview.data.reviewHash })}
              >
                {t("badge.importApply")}
              </Button>
            )
          )}
        </div>
      </Sheet>
    </>
  );
}
