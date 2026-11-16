import { type Promotion, promotionInputSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney, localDateOf } from "~/lib/format";
import { zonedInstant } from "~/lib/zoned";
import { UnsavedGuard } from "../unsaved-guard";
import { centsInput, inputCents } from "./money";

export function PromotionsView() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Promotion | null | undefined>();
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: ["rewards", "promotions", page, search],
    queryFn: () => api().rewards.promotions(page, search),
    refetchOnMount: "always",
  });
  return (
    <section aria-label={t("promotions.title")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("promotions.title")}</h3>
        <Button
          onClick={() => {
            setEditing(null);
            setSaved(false);
          }}
        >
          {t("promotions.new")}
        </Button>
      </div>
      <p className="text-sm text-muted">{t("promotions.help")}</p>
      {saved && <p role="status">{t("promotions.saved")}</p>}
      {editing !== undefined && (
        <PromotionEditor
          key={editing?.id ?? "new"}
          initial={editing}
          onClose={() => {
            setEditing(undefined);
            void query.refetch();
          }}
          onSaved={() => {
            setEditing(undefined);
            setSaved(true);
          }}
        />
      )}
      <TextField
        label={t("promotions.search")}
        type="search"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      {query.isPending ? (
        <Skeleton className="h-40" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data.promotions.length ? (
        <EmptyState title={t("promotions.empty")} />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {query.data.promotions.map((p) => (
              <li
                key={p.id}
                className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4"
              >
                <h4 className="break-words font-semibold">{p.name}</h4>
                <p className="break-all font-medium">{p.code}</p>
                <p>
                  {p.kind === "percent" ? `${p.value / 100}%` : formatMoney(p.value, "EUR", locale)}
                  {!p.active ? ` · ${t("inventory.inactive")}` : ""}
                </p>
                <p className="text-sm text-muted">
                  {t("promotions.usage", {
                    used: p.usedCount,
                    limit: p.usageLimit ?? t("promotions.unlimited"),
                  })}
                </p>
                <Button
                  variant="secondary"
                  className="max-w-full whitespace-normal! text-left [overflow-wrap:anywhere]"
                  onClick={() => {
                    setEditing(p);
                    setSaved(false);
                  }}
                >
                  {t("promotions.edit")}: {p.name}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
              {t("inventory.previous")}
            </Button>
            <span>{page}</span>
            <Button
              variant="secondary"
              disabled={page * 20 >= query.data.pagination.total}
              onClick={() => setPage(page + 1)}
            >
              {t("inventory.next")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
const optionalCount = (value: string) =>
  value.trim() === "" ? null : /^\d+$/.test(value) ? Number(value) : Number.NaN;
function localInput(instant: string | null, timeZone: string) {
  if (!instant) return "";
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  return `${localDateOf(instant, timeZone)}T${time}`;
}
function PromotionEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Promotion | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const initialForm = {
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    kind: initial?.kind ?? "percent",
    value: centsInput(initial?.value ?? 1000),
    minimum: centsInput(initial?.minimumSpendCents ?? 0),
    cap: initial?.maximumDiscountCents ? centsInput(initial.maximumDiscountCents) : "",
    limit: initial?.usageLimit?.toString() ?? "",
    perClient: initial ? (initial.perClientLimit?.toString() ?? "") : "1",
    start: localInput(initial?.startsAt ?? null, timeZone),
    end: localInput(initial?.endsAt ?? null, timeZone),
    active: initial?.active ?? true,
    kinds:
      initial?.eligibleKinds ??
      (["service", "product", "custom"] as ("service" | "product" | "custom")[]),
    services: initial?.serviceIds ?? [],
  };
  const [form, setForm] = useState(initialForm);
  const [invalid, setInvalid] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const catalog = useQuery({
    queryKey: ["rewards", "promotion-services"],
    queryFn: () => api().admin.services.list(),
  });
  const save = useMutation({
    mutationFn: (input: Parameters<ReturnType<typeof api>["rewards"]["savePromotion"]>[1]) =>
      api().rewards.savePromotion(initial?.id ?? null, input),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ["rewards"] });
      onSaved();
    },
  });
  function instant(value: string, before: string | null) {
    if (!value) return null;
    if (before && value === localInput(before, timeZone)) return before;
    const [date, time] = value.split("T");
    if (!date || !time) throw new Error("Invalid local time");
    const iso = zonedInstant(date, time, timeZone);
    if (localInput(iso, timeZone) !== value) throw new Error("This local time does not exist");
    return iso;
  }
  return (
    <form
      aria-label={t(initial ? "promotions.edit" : "promotions.new")}
      className="space-y-4 rounded-xl border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const input = promotionInputSchema.safeParse({
            code: form.code,
            name: form.name,
            kind: form.kind,
            value: inputCents(form.value),
            minimumSpendCents: inputCents(form.minimum),
            maximumDiscountCents: form.cap.trim() ? inputCents(form.cap) : null,
            usageLimit: optionalCount(form.limit),
            perClientLimit: optionalCount(form.perClient),
            startsAt: instant(form.start, initial?.startsAt ?? null),
            endsAt: instant(form.end, initial?.endsAt ?? null),
            eligibleKinds: form.kinds,
            serviceIds: form.services,
            active: form.active,
            version: initial?.version ?? null,
          });
          setInvalid(!input.success);
          if (input.success) save.mutate(input.data);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <UnsavedGuard dirty={dirty} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t("promotions.name")}
          value={form.name}
          maxLength={100}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label={t("promotions.code")}
          value={form.code}
          maxLength={40}
          autoComplete="off"
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        <SelectField
          label={t("promotions.kind")}
          value={form.kind}
          options={[
            { value: "percent", label: t("promotions.percent") },
            { value: "fixed", label: t("promotions.fixed") },
          ]}
          onChange={(v) => setForm({ ...form, kind: v as typeof form.kind })}
        />
        <TextField
          label={t("promotions.value")}
          inputMode="decimal"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
        />
        <TextField
          label={t("promotions.minimum")}
          inputMode="decimal"
          value={form.minimum}
          onChange={(e) => setForm({ ...form, minimum: e.target.value })}
        />
        <TextField
          label={t("promotions.cap")}
          inputMode="decimal"
          value={form.cap}
          onChange={(e) => setForm({ ...form, cap: e.target.value })}
        />
        <TextField
          label={t("promotions.limit")}
          inputMode="numeric"
          value={form.limit}
          onChange={(e) => setForm({ ...form, limit: e.target.value })}
        />
        <TextField
          label={t("promotions.perClient")}
          inputMode="numeric"
          value={form.perClient}
          onChange={(e) => setForm({ ...form, perClient: e.target.value })}
        />
        <TextField
          label={t("promotions.start")}
          type="datetime-local"
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.target.value })}
        />
        <TextField
          label={t("promotions.end")}
          type="datetime-local"
          value={form.end}
          onChange={(e) => setForm({ ...form, end: e.target.value })}
        />
      </div>
      <fieldset>
        <legend className="font-medium">{t("promotions.scope")}</legend>
        <div className="flex flex-wrap gap-4">
          {(["service", "product", "custom"] as const).map((kind) => (
            <label key={kind} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={form.kinds.includes(kind)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    kinds: e.target.checked
                      ? [...form.kinds, kind]
                      : form.kinds.filter((k) => k !== kind),
                  })
                }
              />
              {t(
                kind === "service"
                  ? "promotions.services"
                  : kind === "product"
                    ? "promotions.products"
                    : "promotions.custom",
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="font-medium">{t("promotions.serviceScope")}</legend>
        {catalog.isPending ? (
          <Skeleton className="h-20" />
        ) : catalog.isError ? (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : (
          <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
            {catalog.data.services.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-accent"
                  checked={form.services.includes(s.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      services: e.target.checked
                        ? [...form.services, s.id]
                        : form.services.filter((id) => id !== s.id),
                    })
                  }
                />
                {s.name}
                {!s.active ? ` · ${t("inventory.inactive")}` : ""}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-accent"
          checked={form.active}
          onChange={(e) => setForm({ ...form, active: e.target.checked })}
        />
        {t("promotions.active")}
      </label>
      {(invalid || save.isError) && <p role="alert">{t("loyalty.error")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!online || save.isPending}>
          {t("promotions.save")}
        </Button>
        <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
          {t("promotions.reload")}
        </Button>
      </div>
    </form>
  );
}
