import type {
  InventoryClassification,
  InventoryClassificationAssignment,
  InventoryClassificationReorder,
} from "@sob/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { useInventoryLiveRevision } from "../calendar/live-provider";
import { UnsavedGuard } from "../unsaved-guard";
import { BrandLogo, BrandLogoEditor } from "./brand-logo";
import { ClassificationOrderList } from "./classification-order-list";

export function useInventoryClassifications(enabled = true) {
  const revision = useInventoryLiveRevision();
  return useQuery({
    queryKey: ["inventory", "classifications", revision],
    queryFn: () => api().inventory.classifications(),
    placeholderData: keepPreviousData,
    enabled,
  });
}

type Draft = InventoryClassification & { generation: string };

function isClassificationConflict(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.code === "version_conflict" || error.code === "sync_generation_changed")
  );
}

export function InventoryClassifications({
  canWrite,
  onEditingChange,
}: {
  canWrite: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t } = useI18n();
  const catalogue = useInventoryClassifications();
  const query = useQueryClient();
  const online = useOnline();
  const toast = useToast();
  const title = useId();
  const [draft, setDraft] = useState<Draft>();
  const [baseline, setBaseline] = useState<InventoryClassification>();
  const [notice, setNotice] = useState(false);
  const [logoBrandId, setLogoBrandId] = useState<string>();
  const review = catalogue.data;
  const entries = review?.entries ?? [];
  const current = entries.find((entry) => entry.id === draft?.id);
  const logoBrand = entries.find((entry) => entry.id === logoBrandId && entry.kind === "brand");
  const stale = Boolean(
    draft &&
      review &&
      (draft.generation !== review.generation || (current?.version ?? 0) !== draft.version),
  );
  const editing = canWrite && draft !== undefined;
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);
  const save = useMutation({
    mutationFn: ({ id, kind, parentId, name, active, position, version, generation }: Draft) =>
      api().inventory.saveClassification(id, {
        kind,
        parentId,
        name,
        active,
        position,
        version,
        generation,
      }),
    onError: (error) => {
      if (isClassificationConflict(error)) void catalogue.refetch();
    },
    onSuccess: async () => {
      await query.invalidateQueries({ queryKey: ["inventory"] });
      setDraft(undefined);
      setNotice(true);
    },
  });
  const order = useMutation({
    mutationFn: (input: InventoryClassificationReorder) =>
      api().inventory.reorderClassifications(input),
    onSuccess: () => {
      toast.success(t("inventory.classification.orderSaved"));
    },
    onSettled: async () => {
      await query.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
  const canReorder = canWrite && online && !catalogue.isPlaceholderData && !order.isPending;
  // Background refreshes retain the last reviewed data. The API checks the draft's
  // generation and version before writing, even if a newer catalogue is still loading.
  const conflict = isClassificationConflict(save.error);
  const canSave = canWrite && online && !stale && !conflict && !save.isPending;
  function edit(entry: InventoryClassification) {
    if (!review || !canWrite) return;
    save.reset();
    setNotice(false);
    setBaseline(entry);
    setDraft({ ...entry, generation: review.generation });
  }
  function keepReviewedChanges(draft: Draft, generation: string) {
    const reviewed = current ?? { ...draft, version: 0 };
    const next = {
      ...reviewed,
      name: draft.name !== baseline?.name ? draft.name : reviewed.name,
      active: draft.active !== baseline?.active ? draft.active : reviewed.active,
      parentId: draft.parentId !== baseline?.parentId ? draft.parentId : reviewed.parentId,
      position: draft.position !== baseline?.position ? draft.position : reviewed.position,
      generation,
    };
    save.reset();
    setBaseline(reviewed);
    setDraft(next);
  }
  const newEntry = (kind: Draft["kind"]) =>
    edit({
      id: crypto.randomUUID(),
      name: "",
      kind,
      parentId: null,
      active: true,
      position: 0,
      version: 0,
    });
  const parentOptions = entries.filter(
    (row) =>
      row.id !== draft?.id &&
      row.kind === "category" &&
      row.parentId === null &&
      (row.active || row.id === draft?.parentId),
  );
  if (catalogue.isPending) return <Skeleton className="h-40" />;
  if (catalogue.isError)
    return <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />;
  if (!review) return <Skeleton className="h-40" />;
  if (editing && draft) {
    return (
      <form
        className="grid max-w-2xl gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
        aria-labelledby={title}
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || !draft.name.trim()) return;
          save.mutate(draft);
        }}
      >
        <UnsavedGuard dirty={!save.isPending} />
        <h3 id={title} className="font-semibold sm:col-span-2">
          {t("inventory.classification.edit")}
        </h3>
        <TextField
          label={t("inventory.classification.name")}
          name="name"
          required
          maxLength={100}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextField
          label={t("inventory.classification.position")}
          name="position"
          type="number"
          min={0}
          max={2147483646}
          required
          value={Number.isNaN(draft.position) ? "" : draft.position}
          onChange={(event) => setDraft({ ...draft, position: event.target.valueAsNumber })}
        />
        {draft.kind === "category" && (
          <SelectField
            name="parentId"
            label={t("inventory.classification.parent")}
            value={draft.parentId ?? ""}
            options={[
              { value: "", label: t("inventory.classification.noParent") },
              ...parentOptions.map((row) => ({ value: row.id, label: row.name })),
            ]}
            onChange={(parentId) => setDraft({ ...draft, parentId: parentId || null })}
          />
        )}
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="active"
            checked={draft.active}
            onChange={(event) => setDraft({ ...draft, active: event.target.checked })}
          />
          {t("inventory.active")}
        </label>
        {(stale || conflict) && review && (
          <div className="space-y-2 sm:col-span-2" role="status">
            <p>{t("inventory.classification.changed")}</p>
            {stale && current && (
              <p>
                {current.name} ·{" "}
                {t(current.active ? "inventory.active" : "inventory.classification.archived")} ·{" "}
                {current.position} ·{" "}
                {entries.find((row) => row.id === current.parentId)?.name ??
                  t("inventory.classification.noParent")}
              </p>
            )}
            {stale ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => keepReviewedChanges(draft, review.generation)}
              >
                {t("inventory.classification.review")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                loading={catalogue.isFetching}
                onClick={() => void catalogue.refetch()}
              >
                {t("common.retry")}
              </Button>
            )}
          </div>
        )}
        {save.isError && !conflict && (
          <div className="sm:col-span-2">
            <ErrorState error={save.error} />
          </div>
        )}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" disabled={!canSave}>
            {t("inventory.classification.save")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={save.isPending}
            onClick={() => setDraft(undefined)}
          >
            {t("inventory.classification.cancel")}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <section className="space-y-4" aria-labelledby={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={title} className="text-heading">
          {t("inventory.classification.title")}
        </h3>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => newEntry("category")}>
              {t("inventory.classification.newCategory")}
            </Button>
            <Button variant="secondary" onClick={() => newEntry("brand")}>
              {t("inventory.classification.newBrand")}
            </Button>
          </div>
        )}
      </div>
      {canWrite && logoBrand && (
        <BrandLogoEditor
          key={logoBrand.id}
          brand={logoBrand}
          generation={review.generation}
          ready={!catalogue.isPlaceholderData}
          onClose={() => setLogoBrandId(undefined)}
        />
      )}
      {notice && <p role="status">{t("inventory.classification.saved")}</p>}
      {order.isError &&
        (isClassificationConflict(order.error) ? (
          <p role="alert">{t("inventory.classification.orderChanged")}</p>
        ) : (
          <ErrorState error={order.error} />
        ))}
      {!entries.length && <p className="text-muted">{t("inventory.classification.empty")}</p>}
      {(["category", "brand"] as const).map((kind) => {
        const roots = entries.filter((row) => row.kind === kind && !row.parentId);
        if (!roots.length) return null;
        return (
          <div key={kind} className="rounded-xl border border-line bg-surface p-4">
            <h4 className="font-semibold">
              {t(kind === "category" ? "pos.category" : "pos.brand")}
            </h4>
            <ClassificationOrderList
              className="divide-y divide-line"
              rows={roots}
              generation={review.generation}
              ready={canReorder}
              onMove={order.mutate}
              render={(root, movement) => {
                const children = entries.filter((row) => row.parentId === root.id);
                return (
                  <>
                    <ClassificationRow
                      entry={root}
                      movement={canWrite && movement}
                      canWrite={canWrite}
                      onEdit={edit}
                      onLogo={root.kind === "brand" ? () => setLogoBrandId(root.id) : undefined}
                    />
                    {children.length > 0 && (
                      <ClassificationOrderList
                        className="ms-3 border-s border-line ps-3 sm:ms-5 sm:ps-4"
                        rows={children}
                        generation={review.generation}
                        ready={canReorder}
                        onMove={order.mutate}
                        render={(child, movement) => (
                          <ClassificationRow
                            entry={child}
                            movement={canWrite && movement}
                            canWrite={canWrite}
                            onEdit={edit}
                          />
                        )}
                      />
                    )}
                  </>
                );
              }}
            />
          </div>
        );
      })}
    </section>
  );
}

function ClassificationRow({
  entry,
  canWrite,
  movement,
  onEdit,
  onLogo,
}: {
  entry: InventoryClassification;
  movement: ReactNode;
  canWrite: boolean;
  onEdit: (entry: InventoryClassification) => void;
  onLogo?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {entry.kind === "brand" && <BrandLogo brand={entry} compact />}
        <span className="min-w-0 break-words">
          {entry.name}
          {!entry.active && (
            <span className="ms-2 text-sm text-muted">
              {t("inventory.classification.archived")}
            </span>
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {movement}
        {canWrite && onLogo && (
          <Button
            variant="secondary"
            type="button"
            aria-label={`${t("inventory.brandLogo.title")} · ${entry.name}`}
            onClick={onLogo}
          >
            {t("inventory.brandLogo.title")}
          </Button>
        )}
        {canWrite && (
          <Button
            variant="secondary"
            type="button"
            aria-label={`${t("inventory.classification.edit")} · ${entry.name}`}
            onClick={() => onEdit(entry)}
          >
            {t("inventory.classification.edit")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProductClassificationFields({
  entries,
  value,
  onChange,
}: {
  entries: InventoryClassification[];
  value: InventoryClassificationAssignment;
  onChange: (assignment: InventoryClassificationAssignment) => void;
}) {
  const { t } = useI18n();
  const fields: [
    keyof InventoryClassificationAssignment,
    Parameters<typeof t>[0],
    (row: InventoryClassification) => boolean,
  ][] = [
    ["categoryId", "pos.category", (row) => row.kind === "category" && row.parentId === null],
    [
      "subcategoryId",
      "inventory.classification.subcategory",
      (row) => value.categoryId !== null && row.parentId === value.categoryId,
    ],
    ["brandId", "pos.brand", (row) => row.kind === "brand"],
  ];
  return (
    <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
      <legend className="font-semibold">{t("inventory.classification.title")}</legend>
      {fields.map(([key, label, filter]) => (
        <SelectField
          key={key}
          name={key}
          label={t(label)}
          value={value[key] ?? ""}
          options={[
            { value: "", label: t("inventory.classification.noValue") },
            ...entries
              .filter((row) => filter(row) && (row.active || row.id === value[key]))
              .map((row) => ({ value: row.id, label: row.name })),
          ]}
          onChange={(id) =>
            onChange({
              ...value,
              [key]: id || null,
              ...(key === "categoryId" ? { subcategoryId: null } : {}),
            })
          }
        />
      ))}
    </fieldset>
  );
}
