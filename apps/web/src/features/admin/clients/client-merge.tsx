import type {
  ClientMergeInput,
  ClientMergePreview,
  ClientMerge as MergeReceipt,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { useDebounced } from "../use-debounced";

export function ClientMerge({
  clientId,
  clientName,
  disabled = false,
  onDirtyChange,
}: {
  clientId: string;
  clientName: string;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={t("merge.title")}
      className="max-w-xl space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h3 className="text-heading">{t("merge.title")}</h3>
      <p className="text-sm text-muted">{t("merge.help")}</p>
      {disabled && <p className="text-sm">{t("merge.saveDraft")}</p>}
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        {t("merge.open")}
      </Button>
      {open && (
        <MergeReview
          key={clientId}
          clientId={clientId}
          clientName={clientName}
          onClose={() => setOpen(false)}
          onDirtyChange={onDirtyChange}
        />
      )}
    </section>
  );
}
function MergeReview({
  clientId,
  clientName,
  onClose,
  onDirtyChange,
}: {
  clientId: string;
  clientName: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 300);
  const [other, setOther] = useState<{ id: string; name: string } | null>(null);
  const [keep, setKeep] = useState(clientId);
  const [review, setReview] = useState<ClientMergePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [result, setResult] = useState<MergeReceipt | null>(null);
  const packet = useRef<ClientMergeInput | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = Boolean(other) && !result;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const candidates = useQuery({
    queryKey: ["client-duplicates", clientId],
    queryFn: () => api().admin.clients.duplicates(clientId),
    staleTime: 0,
  });
  const searched = useQuery({
    queryKey: ["merge-client-search", term],
    queryFn: () => api().admin.clients.list({ search: term, pageSize: 20 }),
    enabled: term.length >= 2,
  });
  const preview = useMutation({
    mutationFn: () => {
      if (!other) throw new Error("Choose a profile");
      return api().admin.clients.previewMerge({
        sourceId: keep === clientId ? other.id : clientId,
        targetId: keep,
      });
    },
    onSuccess: (data) => {
      if (mounted.current) {
        setReview(data);
        setConfirmed(false);
        setStale(false);
        packet.current = null;
        save.reset();
      }
    },
  });
  const save = useMutation({
    mutationFn: () => {
      if (!packet.current) {
        if (!review?.canMerge || !confirmed) throw new Error("Confirm the reviewed identity");
        packet.current = {
          sourceId: review.source.id,
          targetId: review.target.id,
          reviewHash: review.reviewHash,
          confirmedSamePerson: true,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      return api().admin.clients.merge(packet.current);
    },
    onSuccess: async (data) => {
      if (!mounted.current) return;
      setResult(data);
      setUncertain(false);
      await queries.invalidateQueries();
    },
    onError: (error) => {
      if (!mounted.current) return;
      const unknown =
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500);
      if (unknown) setUncertain(true);
      // Once uncertain, even a later authentication failure cannot replace the original packet.
      else if (!uncertain) {
        packet.current = null;
        if (
          error instanceof ApiError &&
          ["version_conflict", "client_merged", "invalid_state"].includes(error.code)
        ) {
          setReview(null);
          setConfirmed(false);
          setStale(true);
        }
      }
    },
  });
  const frozen = save.isPending || uncertain;
  const change = () => {
    setReview(null);
    setConfirmed(false);
    setStale(false);
    packet.current = null;
    preview.reset();
    save.reset();
  };
  const choose = (row: { id: string; name: string }) => {
    if (frozen || preview.isPending) return;
    change();
    setOther(row);
    setKeep(clientId);
  };
  const close = () => {
    if (save.isPending) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const options = (
    rows: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      matchedBy?: ("email" | "phone" | "name")[];
      hasAccount?: boolean;
    }[],
  ) => (
    <ul className="space-y-2">
      {rows
        .filter((row) => row.id !== clientId)
        .map((row) => (
          <li key={row.id}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
              <input
                type="radio"
                name="merge-candidate"
                className="mt-1 shrink-0 accent-accent"
                checked={other?.id === row.id}
                disabled={frozen || preview.isPending}
                onChange={() => choose(row)}
              />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                <span className="block font-medium">{row.name}</span>
                <span className="block text-sm text-muted">{row.email ?? row.phone}</span>
                {row.matchedBy?.length ? (
                  <span className="block text-sm text-muted">
                    {row.matchedBy.map((match) => t(`merge.${match}`)).join(" · ")}
                  </span>
                ) : null}
                {row.hasAccount && <span className="block text-sm">{t("merge.account")}</span>}
              </span>
            </label>
          </li>
        ))}
    </ul>
  );
  return (
    <>
      <Sheet
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={t("merge.title")}
        description={t("merge.help")}
        size="lg"
        footer={
          result ? undefined : (
            <Button
              className="w-full whitespace-normal!"
              disabled={
                !online || save.isPending || (!uncertain && (!review?.canMerge || !confirmed))
              }
              onClick={() => save.mutate()}
            >
              {t(uncertain ? "merge.recover" : "merge.submit")}
            </Button>
          )
        }
      >
        {result ? (
          <div className="space-y-4">
            <p role="status">{t("merge.done")}</p>
            <a
              className="inline-flex min-h-11 items-center text-accent-text underline"
              href={`/admin/clients/${result.targetId}`}
            >
              {t("merge.openSurvivor")}
            </a>
          </div>
        ) : (
          <div className="min-w-0 space-y-5">
            <fieldset disabled={frozen || preview.isPending} className="min-w-0 space-y-4">
              <TextField
                label={t("merge.search")}
                value={search}
                maxLength={100}
                onChange={(event) => {
                  if (!frozen) setSearch(event.target.value);
                }}
              />
              {candidates.isPending && <Skeleton className="h-24" />}
              {candidates.isError && (
                <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
              )}
              {candidates.data && (
                <section aria-label={t("merge.suggested")} className="space-y-2">
                  <h3 className="font-semibold">{t("merge.suggested")}</h3>
                  {options(candidates.data.candidates)}
                  {!candidates.data.candidates.length && (
                    <p className="text-sm text-muted">{t("merge.empty")}</p>
                  )}
                  {candidates.data.hasMore && <p>{t("merge.more")}</p>}
                </section>
              )}
              {term.length >= 2 && (
                <section aria-label={t("merge.manual")} className="space-y-2">
                  <h3 className="font-semibold">{t("merge.manual")}</h3>
                  {searched.isPending ? (
                    <Skeleton className="h-20" />
                  ) : searched.isError ? (
                    <ErrorState error={searched.error} onRetry={() => void searched.refetch()} />
                  ) : (
                    options(
                      (searched.data?.clients ?? []).filter(
                        (row) =>
                          !candidates.data?.candidates.some((candidate) => candidate.id === row.id),
                      ),
                    )
                  )}
                </section>
              )}
              {other && (
                <fieldset className="min-w-0 space-y-2">
                  <legend className="mb-2 font-semibold">{t("merge.direction")}</legend>
                  {[{ id: clientId, name: clientName }, other].map((row) => (
                    <label
                      key={row.id}
                      className="flex min-h-11 items-center gap-3 break-words [overflow-wrap:anywhere]"
                    >
                      <input
                        type="radio"
                        name="merge-survivor"
                        checked={keep === row.id}
                        onChange={() => {
                          change();
                          setKeep(row.id);
                        }}
                      />
                      <span className="min-w-0">{t("merge.keep", { name: row.name })}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <Button
                variant="secondary"
                disabled={!other || !online || preview.isPending || frozen}
                onClick={() => preview.mutate()}
              >
                {t("merge.review")}
              </Button>
            </fieldset>
            {preview.isError && <p role="alert">{t("merge.error")}</p>}
            {stale && <p role="alert">{t("merge.stale")}</p>}
            {review && (
              <section className="min-w-0 space-y-4">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {[
                    ["merge.source", review.source],
                    ["merge.target", review.target],
                  ].map(([label, value]) => {
                    const row = value as ClientMergePreview["source"];
                    return (
                      <article
                        key={row.id}
                        className="min-w-0 space-y-1 rounded-lg border border-line p-3 break-words [overflow-wrap:anywhere]"
                      >
                        <h3 className="font-semibold">
                          {t(label as "merge.source" | "merge.target")}
                        </h3>
                        <p>{row.name}</p>
                        <p className="text-sm">{row.email}</p>
                        <p className="text-sm">{row.phone}</p>
                        {row.notes && (
                          <p className="whitespace-pre-wrap text-sm text-muted">{row.notes}</p>
                        )}
                        <p className="text-sm">
                          {t("crm.access")}: {t(`crm.${row.bookingAccess}`)}
                        </p>
                        {row.tags.length > 0 && (
                          <p className="text-sm">
                            {t("crm.tags")}: {row.tags.join(", ")}
                          </p>
                        )}
                        {row.hasAccount && <p className="text-sm">{t("merge.account")}</p>}
                      </article>
                    );
                  })}
                </div>
                <p className="text-sm">{t("merge.history", review.counts)}</p>
                <p className="text-sm text-muted">{t("merge.effects")}</p>
                {review.reasons.map((reason) => (
                  <p role="alert" key={reason}>
                    {t(`merge.reason.${reason}`)}
                  </p>
                ))}
                <label className="flex min-h-11 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-accent"
                    checked={confirmed}
                    disabled={frozen || !review.canMerge}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>{t("merge.confirm")}</span>
                </label>
              </section>
            )}
            {uncertain && <p role="alert">{t("merge.uncertain")}</p>}
            {save.isError && !stale && <p role="alert">{t("merge.error")}</p>}
            {save.error instanceof ApiError && save.error.status === 401 && (
              <a
                href={`/sign-in?redirect=${encodeURIComponent(`/admin/clients/${clientId}`)}`}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-11 items-center text-accent-text underline"
              >
                {t("merge.signIn")}
              </a>
            )}
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("merge.leave")}
        description={t("merge.leaveBody")}
        confirmLabel={t("merge.leaveConfirm")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => {
          setDiscard(false);
          onClose();
        }}
      />
    </>
  );
}
