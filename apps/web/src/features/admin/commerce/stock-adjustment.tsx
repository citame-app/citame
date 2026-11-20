import { type Product, type StockMovementInput, stockMovementInputSchema } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";

const kinds = ["receive", "consume", "count"] as const;

function readMovement(key: string): StockMovementInput | null {
  const saved = window.sessionStorage.getItem(key);
  return saved === null ? null : stockMovementInputSchema.parse(JSON.parse(saved));
}

function clearMovement(key: string, command: StockMovementInput) {
  if (JSON.stringify(readMovement(key)) === JSON.stringify(command)) {
    window.sessionStorage.removeItem(key);
  }
}

export function StockAdjustment({
  product,
  userId,
  onSaved,
}: {
  product: Product;
  userId?: string;
  onSaved: (product: Product) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const heading = useId();
  const key = userId ? `citame:stock:${encodeURIComponent(userId)}:${product.id}` : undefined;
  const [stored, setStored] = useState(() => {
    try {
      return { command: key ? readMovement(key) : null, failed: false };
    } catch {
      return { command: null, failed: true };
    }
  });
  const [kind, setKind] = useState<StockMovementInput["kind"]>("receive");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<"quantity" | "reason">();
  const busy = useRef(false);
  const save = useMutation({
    mutationFn: async (command: StockMovementInput) => {
      if (!key || command.actorUserId !== userId)
        throw new Error("Stock movement account could not be verified");
      const result = await api().inventory.move(product.id, command);
      if (
        result.id !== product.id ||
        result.inventoryGeneration !== command.generation ||
        result.version <= command.version
      )
        throw new Error("Unexpected stock movement result");
      clearMovement(key, command);
      return result;
    },
    onSuccess: async (result) => {
      setStored({ command: null, failed: false });
      setQuantity("");
      setReason("");
      toast.success(t("inventory.saved"));
      await onSaved(result);
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  const rejection =
    save.error instanceof ApiError &&
    save.error.status === 409 &&
    ["version_conflict", "invalid_state", "sync_generation_changed"].includes(save.error.code)
      ? save.error.code
      : null;
  const review = useMutation({
    mutationFn: async (command: StockMovementInput | null) => {
      const current = await api().inventory.get(product.id);
      if (
        current.id !== product.id ||
        !current.inventoryGeneration ||
        (rejection === "sync_generation_changed" &&
          current.inventoryGeneration === command?.generation)
      )
        throw new Error("Unable to verify current stock");
      if (rejection === "sync_generation_changed") {
        const history = await api().inventory.movements(product.id, 1);
        if (history.inventoryGeneration !== current.inventoryGeneration)
          throw new Error("Stock history changed while reviewing");
        return { current, history };
      }
      if (key && command) clearMovement(key, command);
      return { current, history: null };
    },
    onSuccess: async ({ current, history }) => {
      if (history) return;
      setStored({ command: null, failed: false });
      setQuantity("");
      setReason("");
      save.reset();
      await onSaved(current);
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  const command = stored.command;
  const submitting = save.isPending || review.isPending;
  const needsReview = rejection !== null || (!product.inventoryGeneration && !command);
  const restored = review.data?.history ? review.data : undefined;
  return (
    <form
      method="post"
      aria-labelledby={heading}
      className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || submitting || !online || !key || stored.failed || needsReview) return;
        try {
          let pending = readMovement(key);
          if (pending && (!command || pending.idempotencyKey !== command.idempotencyKey)) {
            setStored({ command: pending, failed: false });
            return;
          }
          if (!pending && command) {
            // A previous view may have acknowledged it while this form was opening.
            // Reusing the exact command safely returns its original result.
            pending = command;
            window.sessionStorage.setItem(key, JSON.stringify(pending));
          } else if (!pending) {
            const parsed = stockMovementInputSchema.safeParse({
              kind,
              quantity: /^\d+$/.test(quantity.trim()) ? Number(quantity) : undefined,
              reason,
              version: product.version,
              generation: product.inventoryGeneration,
              actorUserId: userId,
              idempotencyKey: crypto.randomUUID(),
            });
            if (!parsed.success) {
              const field = parsed.error.issues[0]?.path[0] === "reason" ? "reason" : "quantity";
              setInvalid(field);
              const control = event.currentTarget.elements.namedItem(field);
              if (control instanceof HTMLInputElement) control.focus();
              return;
            }
            pending = parsed.data;
            window.sessionStorage.setItem(key, JSON.stringify(pending));
          }
          setStored({ command: pending, failed: false });
          busy.current = true;
          save.mutate(pending);
        } catch {
          setStored({ command, failed: true });
        }
      }}
    >
      <h3 id={heading} className="font-semibold sm:col-span-2">
        {t("inventory.movement")}
      </h3>
      <p className="text-sm text-muted sm:col-span-2">
        {t("inventory.onHand", { count: product.stockOnHand })} ·{" "}
        {t("inventory.reserved", { count: product.stockReserved })}
      </p>
      <SelectField
        name="kind"
        label={t("inventory.movement")}
        value={command?.kind ?? kind}
        options={kinds.map((value) => ({ value, label: t(`inventory.${value}`) }))}
        onChange={(value) => {
          setKind(value as StockMovementInput["kind"]);
          setInvalid(undefined);
        }}
        disabled={Boolean(command) || submitting}
      />
      <TextField
        name="quantity"
        label={t("inventory.quantity")}
        value={command ? String(command.quantity) : quantity}
        inputMode="numeric"
        required
        disabled={Boolean(command) || submitting}
        error={invalid === "quantity" ? t("inventory.movementQuantityError") : undefined}
        onChange={(event) => {
          setQuantity(event.target.value);
          setInvalid(undefined);
        }}
      />
      <TextField
        name="reason"
        label={t("inventory.reason")}
        value={command?.reason ?? reason}
        required
        minLength={3}
        maxLength={300}
        disabled={Boolean(command) || submitting}
        error={invalid === "reason" ? t("inventory.movementReasonError") : undefined}
        onChange={(event) => {
          setReason(event.target.value);
          setInvalid(undefined);
        }}
      />
      {stored.failed || !key ? (
        <p role="alert" className="sm:col-span-2">
          {t("inventory.movementStorage")}
        </p>
      ) : review.isError ? (
        <p role="alert" className="sm:col-span-2">
          {t("inventory.error")}
        </p>
      ) : needsReview ? (
        <p role="alert" className="sm:col-span-2">
          {t(
            rejection === "sync_generation_changed"
              ? "inventory.movementRestored"
              : "inventory.movementRefresh",
          )}
        </p>
      ) : command ? (
        <p role="status" className="sm:col-span-2">
          {t(submitting ? "inventory.movementSending" : "inventory.movementPending")}
        </p>
      ) : null}
      {restored?.history && (
        <section className="space-y-2 sm:col-span-2">
          <h4 className="font-semibold">{t("inventory.movementCurrentHistory")}</h4>
          <p>
            {t("inventory.onHand", { count: restored.current.stockOnHand })} ·{" "}
            {t("inventory.reserved", { count: restored.current.stockReserved })}
          </p>
          {restored.history.movements.length ? (
            <ul className="max-h-44 space-y-1 overflow-y-auto">
              {restored.history.movements.map((movement) => (
                <li key={movement.id}>
                  {movement.quantityDelta} · {movement.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("pos.noMovements")}</p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={!online || !command || stored.failed}
            onClick={() => {
              if (!command || !key || busy.current) return;
              try {
                clearMovement(key, command);
                setStored({ command: null, failed: false });
                save.reset();
                review.reset();
                void onSaved(restored.current);
              } catch {
                setStored({ command, failed: true });
              }
            }}
          >
            {t("inventory.movementDiscard")}
          </Button>
        </section>
      )}
      {needsReview ? (
        <Button
          type="button"
          disabled={submitting || !online || stored.failed}
          onClick={() => {
            if (busy.current) return;
            busy.current = true;
            review.mutate(command);
          }}
        >
          {t("inventory.movementReview")}
        </Button>
      ) : (
        <Button type="submit" disabled={submitting || !online || !key || stored.failed}>
          {t(command ? "inventory.movementRetry" : "inventory.record")}
        </Button>
      )}
    </form>
  );
}
