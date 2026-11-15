import type { StaffAccessPreset } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
export function AccessPanel({ staffId }: { staffId: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const access = useQuery({
    queryKey: ["admin", "staff-access", staffId],
    queryFn: () => api().admin.staff.access(staffId),
  });
  const reload = () => {
    void queries.invalidateQueries({ queryKey: ["admin"] });
  };
  return (
    <section
      aria-label={t("access.title")}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h3 className="font-semibold">{t("access.title")}</h3>
      <p className="text-sm text-muted">{t("access.help")}</p>
      {access.isPending ? (
        <Skeleton className="h-16" />
      ) : access.isError ? (
        <ErrorState error={access.error} onRetry={() => void access.refetch()} />
      ) : access.data.accountRole !== null && access.data.accountRole !== "staff" ? (
        <p>{t("access.accountRole")}</p>
      ) : (
        <>
          <AccessForm
            key={`${staffId}-${access.data.version}`}
            data={access.data}
            onSaved={reload}
          />
          {access.data.accountRole === null && (
            <p className="text-sm text-muted">{t("access.noAccount")}</p>
          )}
        </>
      )}
    </section>
  );
}
function AccessForm({
  data,
  onSaved,
}: {
  data: { staffId: string; preset: StaffAccessPreset; version: number };
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const [preset, setPreset] = useState(data.preset);
  const save = useMutation({
    mutationFn: () => api().admin.staff.setAccess(data.staffId, { preset, version: data.version }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <SelectField
        label={t("access.profile")}
        value={preset}
        options={(["manager", "receptionist", "professional", "restricted"] as const).map(
          (value) => ({ value, label: t(`access.${value}`) }),
        )}
        onChange={(value) => {
          setPreset(value as StaffAccessPreset);
          save.reset();
        }}
      />
      {save.isError && (
        <div role="alert">
          <p className="text-danger-fg">{t("access.error")}</p>
          <Button variant="ghost" onClick={onSaved}>
            {t("access.reload")}
          </Button>
        </div>
      )}
      <Button type="submit" disabled={!online || save.isPending || preset === data.preset}>
        {t("access.save")}
      </Button>
    </form>
  );
}
