import { type ClientControls, clientControlsInputSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

const draftOf = (row: ClientControls) => ({
  version: row.version,
  tags: row.tags.join(", "),
  bookingAccess: row.bookingAccess,
  reason: "",
});
export function ClientControlsEditor({
  clientId,
  onDirtyChange,
}: {
  clientId: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const query = useQuery({
    queryKey: ["client-controls", clientId],
    queryFn: () => api().admin.clients.controls(clientId),
    refetchOnMount: "always",
    refetchInterval: 30000,
  });
  if (query.isPending) return <Skeleton className="h-36" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <ControlsForm key={clientId} row={query.data} onDirtyChange={onDirtyChange} />;
}
function ControlsForm({
  row,
  onDirtyChange,
}: {
  row: ClientControls;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [baseline, setBaseline] = useState(row);
  const [draft, setDraft] = useState(() => draftOf(row));
  const [success, setSuccess] = useState(false);
  const changedAccess = draft.bookingAccess !== baseline.bookingAccess;
  const dirty = draft.tags !== baseline.tags.join(", ") || changedAccess;
  const stale =
    row.version !== draft.version || row.canManageBookingAccess !== baseline.canManageBookingAccess;
  useEffect(() => {
    if (!dirty || !onDirtyChange) return;
    onDirtyChange(true);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const request = () =>
    clientControlsInputSchema.safeParse({
      version: draft.version,
      ...(draft.tags !== baseline.tags.join(", ")
        ? { tags: draft.tags.trim() ? draft.tags.split(",") : [] }
        : {}),
      ...(changedAccess ? { bookingAccess: draft.bookingAccess, reason: draft.reason } : {}),
    });
  const validation = request();
  const tagsError =
    !validation.success && validation.error.issues.some((issue) => issue.path[0] === "tags");
  const save = useMutation({
    mutationFn: () => {
      const parsed = request();
      if (!parsed.success || stale) throw new Error("Invalid controls");
      return api().admin.clients.updateControls(row.clientId, parsed.data);
    },
    onSuccess: (saved) => {
      setBaseline(saved);
      setDraft(draftOf(saved));
      setSuccess(true);
      queries.setQueryData(["client-controls", row.clientId], saved);
      void queries.invalidateQueries({ queryKey: ["admin", "clients"] });
      void queries.invalidateQueries({ queryKey: ["admin", "client", row.clientId] });
    },
  });
  const change = (next: Partial<typeof draft>) => {
    setDraft({ ...draft, ...next });
    setSuccess(false);
    save.reset();
  };
  return (
    <section
      aria-label={t("crm.controls")}
      className="max-w-xl space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <h3 className="text-heading">{t("crm.controls")}</h3>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label={t("crm.tags")}
          hint={t("crm.tagsHelp")}
          error={tagsError ? t("crm.tagsError") : undefined}
          value={draft.tags}
          maxLength={840}
          onChange={(e) => change({ tags: e.target.value })}
        />
        {row.canManageBookingAccess ? (
          <SelectField
            label={t("crm.access")}
            value={draft.bookingAccess}
            options={[
              { value: "normal", label: t("crm.normal") },
              { value: "trusted", label: t("crm.trusted") },
              { value: "blocked", label: t("crm.blocked") },
            ]}
            onChange={(value) =>
              change({ bookingAccess: value as ClientControls["bookingAccess"] })
            }
          />
        ) : (
          <p>
            {t(
              row.bookingAccess === "normal"
                ? "crm.normal"
                : row.bookingAccess === "trusted"
                  ? "crm.trusted"
                  : "crm.blocked",
            )}
          </p>
        )}
        <p className="text-sm text-muted">{t("crm.accessHelp")}</p>
        {changedAccess && row.canManageBookingAccess && (
          <TextField
            label={t("crm.reason")}
            hint={t("crm.private")}
            value={draft.reason}
            maxLength={500}
            onChange={(e) => change({ reason: e.target.value })}
          />
        )}
        {!changedAccess && row.reason && (
          <p className="break-words text-sm text-muted">{row.reason}</p>
        )}
        {stale && (
          <div role="status" className="space-y-2">
            <p>{t("crm.stale")}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setBaseline(row);
                setDraft(draftOf(row));
                setSuccess(false);
                save.reset();
              }}
            >
              {t("crm.reload")}
            </Button>
          </div>
        )}
        {save.isError && <p role="alert">{t("crm.error")}</p>}
        {success && <p role="status">{t("crm.saved")}</p>}
        <Button
          type="submit"
          disabled={!online || !dirty || stale || save.isPending || !request().success}
        >
          {t("crm.save")}
        </Button>
      </form>
    </section>
  );
}
