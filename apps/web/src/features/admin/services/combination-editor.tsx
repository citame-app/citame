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
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { combinationAvailable } from "~/features/booking/combination-choices";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
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
  staff: Staff[];
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
  };
  const [values, setValues] = useState(original);
  const [discard, setDiscard] = useState(false);
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
  const fields = { ...values, description: values.description.trim() || null };
  const unchangedIds =
    previous && JSON.stringify(previous.serviceIds) === JSON.stringify(values.serviceIds);
  const valid =
    combinationCreateSchema.safeParse({ ...fields, idempotencyKey: key.current }).success &&
    (combinationAvailable(values.serviceIds, catalog, staff) || (!values.active && unchangedIds));
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
              disabled={mutation.isPending || (!valid && !uncertain)}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {t(uncertain ? "combinations.retry" : "combinations.save")}
            </Button>
            <Button variant="ghost" disabled={mutation.isPending} onClick={close}>
              {t(uncertain ? "combinations.discard" : "admin.cancel")}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <TextField
            label={t("combinations.name")}
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
              checked={values.active}
              disabled={disabled}
              onChange={(event) => {
                setValues({ ...values, active: event.target.checked });
                mutation.reset();
              }}
            />
            <span>{t("combinations.active")}</span>
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
          {!valid && (
            <p role="status" className="text-sm text-muted">
              {t("combinations.validHelp")}
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
        </div>
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
