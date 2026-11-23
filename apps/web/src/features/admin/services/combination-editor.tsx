import {
  type CombinationCreate,
  type CombinationUpdate,
  combinationCreateSchema,
  combinationUpdateSchema,
  type Service,
  type ServiceCombination,
  type Staff,
} from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { combinationAvailable } from "~/features/booking/combination-choices";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { centsInput, inputCents } from "../commerce/money";
import { UnsavedGuard } from "../unsaved-guard";

type Packet =
  | { kind: "create"; input: CombinationCreate }
  | { kind: "update"; input: CombinationUpdate };
export function CombinationEditor({
  initial,
  catalog,
  staff,
  onClose,
  onSaved,
}: {
  initial: ServiceCombination | "new";
  catalog: Service[];
  staff: (Staff & { active?: boolean })[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const previous = initial === "new" ? undefined : initial;
  const original = {
    name: previous?.name ?? "",
    description: previous?.description ?? "",
    serviceIds: previous?.serviceIds ?? [],
    active: previous?.active ?? true,
    fixed: Boolean(previous?.fixedTerms),
    visibility:
      previous?.fixedTerms?.onlineBooking === true
        ? "public"
        : previous?.fixedTerms?.onlineBooking === false
          ? "team"
          : "",
    scope: previous?.fixedTerms?.staffIds ?? [],
    amounts: Object.fromEntries(
      (previous?.fixedTerms ? previous.serviceIds : []).map((id, index) => [
        id,
        centsInput(previous?.fixedTerms?.pricesCents[index] ?? 0),
      ]),
    ) as Record<string, string>,
  };
  const [values, setValues] = useState(original);
  const [discard, setDiscard] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const form = useId();
  const invalid = useRef<HTMLParagraphElement>(null);
  const [uncertain, setUncertain] = useState(false);
  const key = useRef(crypto.randomUUID());
  const packet = useRef<Packet | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pricesCents = values.serviceIds.map((id) => inputCents(values.amounts[id] ?? "") ?? -1);
  const unchangedIds =
    previous && JSON.stringify(previous.serviceIds) === JSON.stringify(values.serviceIds);
  const activeStaff = staff.filter((member) => member.active !== false);
  const staffChoices = [
    ...staff.map((member) => ({
      id: member.id,
      label:
        member.active === false
          ? `${member.displayName} · ${t("combinations.staffUnavailable")}`
          : member.displayName,
      active: member.active !== false,
    })),
    ...values.scope
      .filter((id) => !staff.some((member) => member.id === id))
      .map((id) => ({
        id,
        label: t("combinations.staffUnavailable"),
        active: false,
      })),
  ];
  const removingInternalTerms = previous?.fixedTerms?.onlineBooking === false && !values.fixed;
  const unchangedTerms = Boolean(
    previous?.fixedTerms &&
      values.visibility === original.visibility &&
      JSON.stringify(values.scope) === JSON.stringify(original.scope) &&
      unchangedIds &&
      pricesCents.every((price, index) => price === previous.fixedTerms?.pricesCents[index]),
  );

  const priceErrors =
    attempted && values.fixed
      ? new Set(values.serviceIds.filter((_, index) => (pricesCents[index] ?? -1) < 0))
      : new Set<string>();
  const staffError = attempted && values.fixed && values.scope.length === 0;
  const visibilityError = attempted && values.fixed && values.active && !values.visibility;
  const fields = {
    name: values.name,
    description: values.description.trim() || null,
    serviceIds: values.serviceIds,
    active: values.active,
    ...(values.fixed
      ? !values.active && unchangedTerms
        ? {}
        : {
            fixedTerms: {
              pricesCents,
              staffIds: values.scope,
              ...(values.visibility ? { onlineBooking: values.visibility === "public" } : {}),
            },
          }
      : previous?.fixedTerms
        ? { fixedTerms: null }
        : {}),
  };
  const valid =
    combinationCreateSchema.safeParse({ ...fields, idempotencyKey: key.current }).success &&
    (values.fixed
      ? (!values.active && unchangedIds) ||
        (values.serviceIds.every((id) =>
          catalog.some((service) => service.id === id && service.currency === "EUR"),
        ) &&
          values.scope.every((id) => activeStaff.some((member) => member.id === id)) &&
          (!values.active || Boolean(values.visibility)))
      : combinationAvailable(values.serviceIds, catalog, activeStaff) ||
        (!values.active && unchangedIds));
  const dirty = uncertain || JSON.stringify(values) !== JSON.stringify(original);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!packet.current)
        packet.current = previous
          ? {
              kind: "update",
              input: combinationUpdateSchema.parse({ ...fields, version: previous.version }),
            }
          : {
              kind: "create",
              input: combinationCreateSchema.parse({ ...fields, idempotencyKey: key.current }),
            };
      if (packet.current.kind === "create") return api().combinations.create(packet.current.input);
      if (!previous) throw new Error("Combination identity missing");
      return api().combinations.update(previous.id, packet.current.input);
    },
    onSuccess: () => {
      if (mounted.current) onSaved();
    },
    onError: (error) => {
      if (!mounted.current) return;
      if (
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500)
      )
        setUncertain(true);
      else {
        setUncertain(false);
        packet.current = undefined;
      }
    },
  });
  const disabled = mutation.isPending || uncertain;
  const close = () => {
    if (mutation.isPending) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const title = previous ? t("combinations.edit", { name: previous.name }) : t("combinations.new");
  return (
    <>
      <UnsavedGuard dirty={dirty || mutation.isPending} />
      <Sheet
        open
        title={title}
        size="lg"
        onOpenChange={(open) => {
          if (!open) close();
        }}
        footer={
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              form={form}
              disabled={mutation.isPending}
              loading={mutation.isPending}
            >
              {t(uncertain ? "combinations.retry" : "combinations.save")}
            </Button>
            <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={close}>
              {t(uncertain ? "combinations.discard" : "admin.cancel")}
            </Button>
          </div>
        }
      >
        <form
          id={form}
          method="post"
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid || uncertain) mutation.mutate();
            else {
              setAttempted(true);
              requestAnimationFrame(() => {
                const control = document
                  .getElementById(form)
                  ?.querySelector<HTMLElement>(
                    'input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"]',
                  );
                (control ?? invalid.current)?.focus();
              });
            }
          }}
        >
          <TextField
            label={t("combinations.name")}
            name="name"
            required
            value={values.name}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => {
              setValues({ ...values, name: event.target.value });
              mutation.reset();
            }}
          />
          <TextAreaField
            label={t("combinations.description")}
            name="description"
            value={values.description}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => {
              setValues({ ...values, description: event.target.value });
              mutation.reset();
            }}
          />
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name="active"
              checked={values.active}
              disabled={disabled || removingInternalTerms}
              onChange={(event) => {
                setValues({ ...values, active: event.target.checked });
                mutation.reset();
              }}
            />
            <span>{t(values.fixed ? "combinations.activeFixed" : "combinations.active")}</span>
          </label>
          <section aria-label={t("combinations.order")} className="space-y-3">
            <h3 className="font-medium">{t("combinations.order")}</h3>
            <p className="text-sm text-muted">{t("combinations.orderHelp")}</p>
            <ol className="list-decimal space-y-1 pl-5">
              {values.serviceIds.map((id) => (
                <li key={id}>
                  {catalog.find((s) => s.id === id)?.name ?? t("combinations.unavailable")}
                </li>
              ))}
            </ol>
          </section>
          <CatalogChoices
            catalog={catalog}
            selected={values.serviceIds}
            disabled={disabled}
            onChange={(serviceIds) => {
              setValues({ ...values, serviceIds });
              mutation.reset();
            }}
          />
          <label className="flex min-h-12 items-center gap-3">
            <input
              type="checkbox"
              name="fixed"
              checked={values.fixed}
              disabled={disabled}
              onChange={(event) =>
                setValues({
                  ...values,
                  fixed: event.target.checked,
                  active:
                    !event.target.checked && previous?.fixedTerms?.onlineBooking === false
                      ? false
                      : values.active,
                })
              }
            />
            <span>{t("combinations.fixedPrice")}</span>
          </label>
          {values.fixed && (
            <fieldset className="min-w-0 space-y-4 rounded-lg border border-line p-4">
              <legend className="px-1 font-medium">{t("combinations.fixedTerms")}</legend>
              {values.serviceIds.map((id) => (
                <TextField
                  key={id}
                  name={`amount-${id}`}
                  inputMode="decimal"
                  maxLength={10}
                  label={`${catalog.find((service) => service.id === id)?.name ?? t("combinations.unavailable")} (EUR)`}
                  value={values.amounts[id] ?? ""}
                  error={priceErrors.has(id) ? t("combinations.amountError") : undefined}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      amounts: { ...values.amounts, [id]: event.target.value },
                    })
                  }
                  disabled={disabled}
                />
              ))}
              <fieldset
                className="min-w-0"
                aria-describedby={staffError ? `${form}-staff-error` : undefined}
              >
                <legend className="text-sm font-medium">{t("combinations.fixedStaff")}</legend>
                {staffChoices.map((member) => (
                  <label key={member.id} className="flex min-h-12 items-center gap-3">
                    <input
                      type="checkbox"
                      name="staff"
                      aria-invalid={staffError || undefined}
                      aria-describedby={staffError ? `${form}-staff-error` : undefined}
                      value={member.id}
                      disabled={disabled || (!member.active && !values.scope.includes(member.id))}
                      checked={values.scope.includes(member.id)}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          scope: event.target.checked
                            ? [...values.scope, member.id]
                            : values.scope.filter((id) => id !== member.id),
                        })
                      }
                    />
                    <span>{member.label}</span>
                  </label>
                ))}
                {staffError && (
                  <p id={`${form}-staff-error`} className="text-sm text-danger-fg">
                    {t("combinations.staffError")}
                  </p>
                )}
              </fieldset>
              <SelectField
                name="visibility"
                label={t("combinations.visibility")}
                value={values.visibility}
                error={visibilityError ? t("combinations.visibilityError") : undefined}
                disabled={disabled}
                options={[
                  { value: "", label: t("combinations.visibilityChoose"), disabled: true },
                  { value: "public", label: t("combinations.live") },
                  { value: "team", label: t("combinations.teamOnly") },
                ]}
                onChange={(visibility) => setValues({ ...values, visibility })}
              />
            </fieldset>
          )}
          {attempted && !valid && (
            <p ref={invalid} tabIndex={-1} role="alert" className="text-sm text-danger-fg">
              {t(values.fixed ? "combinations.fixedHelp" : "combinations.validHelp")}
            </p>
          )}
          {uncertain && (
            <p role="alert" className="rounded-lg border border-warning-fg/30 bg-warning-soft p-4">
              {t("combinations.uncertain")}
            </p>
          )}
          {mutation.isError && !uncertain && (
            <p role="alert" className="text-danger-fg">
              {t("combinations.failed")}
            </p>
          )}
        </form>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        destructive
        title={t("combinations.discardTitle")}
        description={t("combinations.discardBody")}
        confirmLabel={t("combinations.discard")}
        cancelLabel={t("admin.cancel")}
        onConfirm={onClose}
      />
    </>
  );
}
