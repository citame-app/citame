import {
  CLIENT_CSV_MAX_BYTES,
  type ClientImportPreview,
  type ClientImportResult,
  clientImportPreviewInputSchema,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";

function download(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function ClientTransfer({ search }: { search?: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const fileId = useId();
  const [open, setOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [csv, setCsv] = useState("");
  const [review, setReview] = useState<ClientImportPreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<ClientImportResult | null>(null);
  const [fileError, setFileError] = useState(false);
  const [reading, setReading] = useState(false);
  const readingToken = useRef(0);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const exporting = useMutation({
    mutationFn: () => api().admin.clients.export(search),
    onSuccess: (data) => {
      download(data.csv, `sisters-of-beauty-clients-${data.exportedAt.slice(0, 10)}.csv`);
      setExported(data.count);
    },
  });
  const preview = useMutation({
    mutationFn: () => {
      if (!clientImportPreviewInputSchema.safeParse({ csv }).success)
        throw new ApiError("validation_error", 400, "CSV exceeds the file limits");
      return api().admin.clients.previewImport(csv);
    },
    onSuccess: (data) => {
      setReview(data);
      setSelected(data.rows.filter((row) => row.status === "create").map((row) => row.row));
      save.reset();
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!review || !selected.length) throw new Error("Review and select client rows first");
      const rows = [...selected].sort((a, b) => a - b);
      const signature = JSON.stringify({ csv, rows });
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return api().admin.clients.import({
        csv,
        rows,
        reviewHash: review.reviewHash,
        idempotencyKey: attempt.current.key,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      attempt.current = null;
      setCsv("");
      setReview(null);
      setSelected([]);
      preview.reset();
      void queries.invalidateQueries({ queryKey: ["admin", "clients"] });
    },
  });
  const busy = reading || preview.isPending || save.isPending;
  const stale = save.error instanceof ApiError && save.error.code === "version_conflict";
  const errorText = (error: unknown) => {
    if (error instanceof ApiError && error.code === "version_conflict")
      return t("clientTransfer.changed");
    if (error instanceof ApiError && error.code === "validation_error")
      return t("clientTransfer.invalidFile");
    return t(describeProblem(error).messageKey);
  };
  function changeCsv(value: string) {
    if (!value.trim()) attempt.current = null;
    readingToken.current++;
    setReading(false);
    setCsv(value);
    setReview(null);
    setSelected([]);
    setResult(null);
    setFileError(false);
    preview.reset();
    save.reset();
  }
  async function readFile(file: File) {
    const token = ++readingToken.current;
    setReading(true);
    setFileError(false);
    try {
      if (file.size > CLIENT_CSV_MAX_BYTES) throw new Error("File too large");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (token === readingToken.current) changeCsv(content);
    } catch {
      if (token === readingToken.current) {
        setFileError(true);
        setReading(false);
      }
    }
  }
  function close() {
    if (busy) return;
    if (csv.trim()) setDiscard(true);
    else setOpen(false);
  }
  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            if (result) changeCsv("");
            setOpen(true);
          }}
        >
          {t("clientTransfer.open")}
        </Button>
        <Button
          variant="secondary"
          disabled={!online}
          loading={exporting.isPending}
          onClick={() => {
            setExported(null);
            exporting.mutate();
          }}
        >
          {t("clientTransfer.export")}
        </Button>
      </div>
      <p className="max-w-3xl text-sm text-muted">{t("clientTransfer.privacy")}</p>
      {exporting.isError && (
        <p role="alert" className="text-danger-fg">
          {errorText(exporting.error)}
        </p>
      )}
      {exported !== null && (
        <p role="status" className="text-sm">
          {t("clientTransfer.exported", { count: exported })}
        </p>
      )}
      <UnsavedGuard dirty={Boolean(csv.trim()) || busy} />
      <Sheet
        open={open}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
        title={t("clientTransfer.open")}
        description={t("clientTransfer.description")}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busy} onClick={close}>
              {t("admin.close")}
            </Button>
            {!result && (
              <Button
                variant="secondary"
                disabled={busy || !online || !csv.trim()}
                loading={preview.isPending}
                onClick={() => preview.mutate()}
              >
                {t("clientTransfer.review")}
              </Button>
            )}
            {review && (
              <Button
                disabled={busy || !online || !selected.length || stale}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {t("clientTransfer.importSelected", { count: selected.length })}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5">
          {result ? (
            <p role="status" className="rounded-lg border border-line bg-canvas p-4">
              {t("clientTransfer.created", { count: result.created })}{" "}
              {t("clientTransfer.skipped", { count: result.skipped })}
            </p>
          ) : (
            <>
              <details open={!review} className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("clientTransfer.source")}
                </summary>
                <div className="mt-4 space-y-4">
                  <p className="text-sm text-muted">{t("clientTransfer.format")}</p>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      download(
                        '\uFEFF"name","email","phone","notes","tags"\r\n',
                        "sisters-of-beauty-client-template.csv",
                      )
                    }
                  >
                    {t("clientTransfer.template")}
                  </Button>
                  <fieldset disabled={busy} className="min-w-0 space-y-4">
                    <div>
                      <label htmlFor={fileId} className="mb-1.5 block text-sm font-medium">
                        {t("clientTransfer.file")}
                      </label>
                      <input
                        id={fileId}
                        type="file"
                        accept=".csv,text/csv"
                        className="w-full min-w-0 rounded-lg border border-line p-2 text-sm"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void readFile(file);
                        }}
                      />
                    </div>
                    <TextAreaField
                      label={t("clientTransfer.content")}
                      value={csv}
                      onChange={(event) => changeCsv(event.target.value)}
                      rows={6}
                      spellCheck={false}
                    />
                  </fieldset>
                </div>
              </details>
              {fileError && (
                <p role="alert" className="text-danger-fg">
                  {t("clientTransfer.invalidFile")}
                </p>
              )}
              {(preview.isError || save.isError) && (
                <p role="alert" className="text-danger-fg">
                  {errorText(save.error ?? preview.error)}
                </p>
              )}
              {review && (
                <section aria-label={t("clientTransfer.preview")} className="space-y-3">
                  <p role="status" className="text-sm">
                    {t("clientTransfer.counts", {
                      create: review.counts.create,
                      duplicate: review.counts.duplicate,
                      invalid: review.counts.invalid,
                      ambiguous: review.counts.ambiguous,
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        setSelected(
                          review.rows
                            .filter((row) => row.status === "create")
                            .map((row) => row.row),
                        )
                      }
                    >
                      {t("clientTransfer.selectAll")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setSelected([])}>
                      {t("clientTransfer.selectNone")}
                    </Button>
                  </div>
                  <ul className="max-h-96 space-y-2 overflow-y-auto">
                    {review.rows.map((row) => (
                      <li key={row.row} className="rounded-lg border border-line p-3">
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 size-5 shrink-0 accent-accent"
                            checked={selected.includes(row.row)}
                            disabled={busy || row.status !== "create"}
                            aria-label={t("clientTransfer.row", {
                              row: row.row,
                              name: row.name || t("clientTransfer.unnamed"),
                            })}
                            onChange={(event) =>
                              setSelected((value) =>
                                event.target.checked
                                  ? [...value, row.row]
                                  : value.filter((number) => number !== row.row),
                              )
                            }
                          />
                          <span className="min-w-0 space-y-1 break-words text-sm">
                            <span className="block font-medium">
                              {row.row}. {row.name || t("clientTransfer.unnamed")}
                            </span>
                            <span className="block text-muted">
                              {[row.email, row.phone].filter(Boolean).join(" · ")}
                            </span>
                            <span className="block">
                              {t(`clientTransfer.status.${row.status}`)}
                            </span>
                            {row.issues.map((issue) => (
                              <span key={issue} className="block text-danger-fg">
                                {t(`clientTransfer.issue.${issue}`)}
                              </span>
                            ))}
                            {row.matches.map((match) => (
                              <span key={match.id} className="block text-muted">
                                {match.name}
                              </span>
                            ))}
                            {row.duplicateRow && (
                              <span className="block text-muted">
                                {t("clientTransfer.duplicateRow", { row: row.duplicateRow })}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        destructive
        title={t("admin.unsaved.title")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={() => {
          changeCsv("");
          setDiscard(false);
          setOpen(false);
        }}
      />
    </div>
  );
}
