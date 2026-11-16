import {
  type AdminService,
  type Resource,
  resourceCreateSchema,
  resourceKindSchema,
  resourceUpdateSchema,
  type ServiceResources,
  serviceResourceInputSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";

const selectClass =
  "min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-fg";
const requirementsKey = (id: string) => ["admin", "resources", "service", id];
const resourceQuery = { queryKey: ["admin", "resources"], queryFn: () => api().resources.list() };
type DraftProps = { onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void };
function useDraftStatus(dirty: boolean, busy: boolean, props: DraftProps) {
  useEffect(() => {
    props.onDirty(dirty);
    return () => props.onDirty(false);
  }, [dirty, props.onDirty]);
  useEffect(() => {
    props.onBusy(busy);
    return () => props.onBusy(false);
  }, [busy, props.onBusy]);
}
function useRefreshResources() {
  const queries = useQueryClient();
  return () => {
    for (const key of [
      ["admin", "resources"],
      ["admin", "calendar"],
      ["availability"],
      ["appointments"],
    ])
      void queries.invalidateQueries({ queryKey: key });
  };
}
export function ResourcesPanel({ services }: { services: Pick<AdminService, "id" | "name">[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Resource | "new" | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const resources = useQuery({ ...resourceQuery, enabled: open });
  const selectId = useId();
  const leave = (action: () => void) => {
    if (busy) return;
    if (dirty) setDiscard(() => action);
    else action();
  };
  const close = () => {
    setOpen(false);
    setEditing(null);
    setServiceId("");
    setDirty(false);
  };
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t("resources.title")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) leave(close);
        }}
        title={t("resources.title")}
        description={t("resources.help")}
        size="lg"
      >
        <UnsavedGuard dirty={dirty} />
        <div className="space-y-6">
          <p className="rounded-lg border border-line bg-sunken p-3 text-sm text-muted">
            {t("resources.effect")}
          </p>
          {resources.isPending ? (
            <p role="status">{t("resources.loading")}</p>
          ) : resources.isError ? (
            <ErrorState error={resources.error} onRetry={() => void resources.refetch()} />
          ) : (
            resources.data &&
            (editing ? (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => leave(() => setEditing(null))}
                >
                  {t("resources.back")}
                </Button>
                <ResourceForm
                  key={editing === "new" ? "new" : editing.id}
                  initial={editing === "new" ? null : editing}
                  onDirty={setDirty}
                  onBusy={setBusy}
                />
              </>
            ) : (
              <>
                <Button
                  onClick={() =>
                    leave(() => {
                      setServiceId("");
                      setEditing("new");
                    })
                  }
                >
                  {t("resources.new")}
                </Button>
                {resources.data.resources.length === 0 ? (
                  <EmptyState title={t("resources.empty")} description={t("resources.emptyHelp")} />
                ) : (
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {resources.data.resources.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center justify-between gap-3 p-4"
                      >
                        <div className="min-w-0">
                          <p className="break-words font-medium">{r.name}</p>
                          <p className="text-sm text-muted">
                            {t(`resources.${r.kind}`)} · {r.capacity}{" "}
                            {!r.active && `· ${t("resources.inactive")}`}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          aria-label={t("resources.edit", { name: r.name })}
                          onClick={() =>
                            leave(() => {
                              setServiceId("");
                              setEditing(r);
                            })
                          }
                        >
                          {t("admin.edit")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <section className="space-y-4 border-t border-line pt-5">
                  <label htmlFor={selectId} className="block font-medium">
                    {t("resources.service")}
                  </label>
                  <select
                    id={selectId}
                    className={selectClass}
                    value={serviceId}
                    disabled={busy}
                    onChange={(e) => {
                      const id = e.target.value;
                      leave(() => setServiceId(id));
                    }}
                  >
                    <option value="">{t("resources.choose")}</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {serviceId && (
                    <RequirementLoader
                      key={serviceId}
                      serviceId={serviceId}
                      resources={resources.data.resources}
                      onDirty={setDirty}
                      onBusy={setBusy}
                    />
                  )}
                </section>
              </>
            ))
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        open={discard !== null}
        onOpenChange={(next) => !next && setDiscard(null)}
        destructive
        title={t("resources.discard")}
        description={t("resources.discardBody")}
        confirmLabel={t("resources.leave")}
        cancelLabel={t("resources.keep")}
        onConfirm={() => {
          discard?.();
          setDirty(false);
          setDiscard(null);
        }}
      />
    </>
  );
}
function ResourceForm({ initial, ...props }: { initial: Resource | null } & DraftProps) {
  const { t } = useI18n();
  const online = useOnline();
  const refresh = useRefreshResources();
  const [base, setBase] = useState(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Resource["kind"]>(initial?.kind ?? "room");
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 1));
  const [active, setActive] = useState(initial?.active ?? true);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const request = useRef({ signature: "", key: "" });
  const kindId = useId();
  const reset = (r: Resource) => {
    setBase(r);
    setName(r.name);
    setKind(r.kind);
    setCapacity(String(r.capacity));
    setActive(r.active);
    setInvalid(false);
  };
  const save = useMutation({
    mutationFn: async () => {
      const fields = { name, kind, capacity: /^\d+$/.test(capacity) ? Number(capacity) : null };
      if (base)
        return api().resources.update(
          base.id,
          resourceUpdateSchema.parse({ ...fields, active, version: base.version }),
        );
      const signature = JSON.stringify(fields);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      return api().resources.create(
        resourceCreateSchema.parse({ ...fields, idempotencyKey: request.current.key }),
      );
    },
    onSuccess: (r) => {
      reset(r);
      setSaved(true);
      refresh();
    },
  });
  const reload = useMutation({
    mutationFn: () => api().resources.list(),
    onSuccess: (data) => {
      const current = data.resources.find((r) => r.id === base?.id);
      if (current) reset(current);
      save.reset();
      setSaved(false);
    },
  });
  const dirty =
    name !== (base?.name ?? "") ||
    kind !== (base?.kind ?? "room") ||
    capacity !== String(base?.capacity ?? 1) ||
    active !== (base?.active ?? true);
  const busy = save.isPending || reload.isPending;
  useDraftStatus(dirty, busy, props);
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const valid = resourceUpdateSchema.safeParse({
          name,
          kind,
          capacity: /^\d+$/.test(capacity) ? Number(capacity) : null,
          active,
          version: base?.version ?? 1,
        }).success;
        setInvalid(!valid);
        if (valid && !busy && online) save.mutate();
      }}
    >
      <TextField
        disabled={busy}
        label={t("resources.name")}
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div>
        <label htmlFor={kindId} className="mb-1.5 block text-sm font-medium">
          {t("resources.kind")}
        </label>
        <select
          id={kindId}
          className={selectClass}
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(resourceKindSchema.parse(e.target.value))}
        >
          {resourceKindSchema.options.map((k) => (
            <option key={k} value={k}>
              {t(`resources.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <TextField
        disabled={busy}
        label={t("resources.capacity")}
        hint={t("resources.capacityHelp")}
        type="number"
        min={1}
        max={20}
        step={1}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
      />
      {base && (
        <label className="flex min-h-11 items-center gap-3">
          <input
            className="size-5 accent-accent"
            type="checkbox"
            checked={active}
            disabled={busy}
            onChange={(e) => setActive(e.target.checked)}
          />
          {t("resources.active")}
        </label>
      )}
      {invalid && (
        <p role="alert" className="text-danger-fg">
          {t("resources.invalid")}
        </p>
      )}
      {save.isError && (
        <>
          <p role="alert" className="text-danger-fg">
            {t("resources.conflict")}
          </p>
          <ErrorState error={save.error} />
          <Button variant="secondary" disabled={!online || busy} onClick={() => reload.mutate()}>
            {t("resources.reload")}
          </Button>
        </>
      )}
      {reload.isError && <ErrorState error={reload.error} />}
      {saved && (
        <p role="status" className="text-success-fg">
          {t("resources.saved")}
        </p>
      )}
      <Button type="submit" loading={save.isPending} disabled={!online || reload.isPending}>
        {t("resources.save")}
      </Button>
    </form>
  );
}
function RequirementLoader({
  serviceId,
  ...props
}: { serviceId: string; resources: Resource[] } & DraftProps) {
  const { t } = useI18n();
  const result = useQuery({
    queryKey: requirementsKey(serviceId),
    queryFn: () => api().resources.requirements(serviceId),
  });
  if (result.isPending) return <p role="status">{t("resources.loading")}</p>;
  if (result.isError)
    return <ErrorState error={result.error} onRetry={() => void result.refetch()} />;
  return <RequirementForm initial={result.data} {...props} />;
}
function RequirementForm({
  initial,
  resources,
  ...props
}: { initial: ServiceResources; resources: Resource[] } & DraftProps) {
  const { t } = useI18n();
  const online = useOnline();
  const refresh = useRefreshResources();
  const queries = useQueryClient();
  const [base, setBase] = useState(initial);
  const valuesOf = (r: ServiceResources) =>
    Object.fromEntries(
      resources.map((pool) => [
        pool.id,
        String(r.requirements.find((v) => v.resourceId === pool.id)?.quantity ?? 0),
      ]),
    );
  const [values, setValues] = useState(() => valuesOf(initial));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (input: ReturnType<typeof serviceResourceInputSchema.parse>) =>
      api().resources.saveRequirements(base.serviceId, input),
    onSuccess: (r) => {
      queries.setQueryData(requirementsKey(r.serviceId), r);
      setBase(r);
      setValues(valuesOf(r));
      setSaved(true);
      refresh();
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      const [requirements, pools] = await Promise.all([
        api().resources.requirements(base.serviceId),
        api().resources.list(),
      ]);
      return { requirements, pools };
    },
    onSuccess: ({ requirements: r, pools }) => {
      queries.setQueryData(resourceQuery.queryKey, pools);
      queries.setQueryData(requirementsKey(r.serviceId), r);
      setBase(r);
      setValues(valuesOf(r));
      setInvalid(false);
      setSaved(false);
      save.reset();
    },
  });
  const busy = save.isPending || reload.isPending;
  const dirty = resources.some(
    (r) =>
      (values[r.id] ?? "0") !==
      String(base.requirements.find((v) => v.resourceId === r.id)?.quantity ?? 0),
  );
  useEffect(() => {
    // A background refresh may finish after mounting from stale cache. Adopt it only
    // while untouched; concurrent updates must never erase an operator's draft.
    if (initial.version > base.version && !dirty && !busy) {
      setBase(initial);
      setValues(
        Object.fromEntries(
          resources.map((r) => [
            r.id,
            String(initial.requirements.find((v) => v.resourceId === r.id)?.quantity ?? 0),
          ]),
        ),
      );
    }
  }, [initial, base.version, dirty, busy, resources]);
  useDraftStatus(dirty, busy, props);
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const quantities = resources.map((r) => ({
          resourceId: r.id,
          quantity: /^\d+$/.test(values[r.id] ?? "0") ? Number(values[r.id] ?? "0") : -1,
        }));
        const validCapacity = quantities.every((q) => {
          const r = resources.find((r) => r.id === q.resourceId);
          return q.quantity >= 0 && r && q.quantity <= r.capacity && (q.quantity === 0 || r.active);
        });
        const input = serviceResourceInputSchema.safeParse({
          version: base.version,
          requirements: quantities.filter((q) => q.quantity !== 0),
        });
        setInvalid(!validCapacity || !input.success);
        if (validCapacity && input.success && online && !busy) save.mutate(input.data);
      }}
    >
      <p className="text-sm text-muted">{t("resources.zero")}</p>
      {resources.map((r) => (
        <TextField
          key={r.id}
          disabled={busy}
          label={t("resources.quantity", { name: r.name })}
          hint={!r.active ? t("resources.inactive") : undefined}
          type="number"
          min={0}
          max={r.capacity}
          step={1}
          value={values[r.id] ?? "0"}
          onChange={(e) => setValues((v) => ({ ...v, [r.id]: e.target.value }))}
        />
      ))}
      {invalid && (
        <p role="alert" className="text-danger-fg">
          {t("resources.requirementsInvalid")}
        </p>
      )}
      {save.isError && (
        <>
          <p role="alert" className="text-danger-fg">
            {t("resources.conflict")}
          </p>
          <ErrorState error={save.error} />
          <Button variant="secondary" disabled={!online || busy} onClick={() => reload.mutate()}>
            {t("resources.reload")}
          </Button>
        </>
      )}
      {reload.isError && <ErrorState error={reload.error} />}
      {saved && (
        <p role="status" className="text-success-fg">
          {t("resources.requirementsSaved")}
        </p>
      )}
      <Button type="submit" loading={save.isPending} disabled={!online || reload.isPending}>
        {t("resources.saveRequirements")}
      </Button>
    </form>
  );
}
