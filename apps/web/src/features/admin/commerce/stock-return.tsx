import { type Checkout, type StockReturnInput, stockReturnSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";

function readReturn(key: string, userId: string) {
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) return null;
  const command = stockReturnSchema.parse(JSON.parse(raw));
  if (command.actorUserId !== userId || !command.generation)
    throw new Error("Stock return could not be verified");
  return command;
}

function clearReturn(key: string, userId: string, command: StockReturnInput) {
  if (readReturn(key, userId)?.idempotencyKey === command.idempotencyKey)
    window.sessionStorage.removeItem(key);
}

export function StockReturn({ checkout }: { checkout: Checkout }) {
  const { t } = useI18n();
  const me = useQuery({ queryKey: ["commerce", "return-actor"], queryFn: () => api().me() });
  const userId = me.data?.user.id;
  return (
    <details>
      <summary className="cursor-pointer py-2 font-medium">{t("inventory.return")}</summary>
      <p className="my-2 text-sm text-muted">{t("inventory.returnHelp")}</p>
      {userId ? (
        <ReturnForm key={`${userId}:${checkout.id}`} checkout={checkout} userId={userId} />
      ) : (
        <p role="status">{t(me.isError ? "inventory.error" : "admin.loading")}</p>
      )}
    </details>
  );
}

function ReturnForm({ checkout, userId }: { checkout: Checkout; userId: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const storageKey = `citame:stock-return:${encodeURIComponent(userId)}:${checkout.id}`;
  const lines = checkout.lines.filter((line) => line.kind === "product");
  const [selection, setSelection] = useState(lines[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<"quantity" | "reason">();
  const [stored, setStored] = useState(() => {
    try {
      return { command: readReturn(storageKey, userId), failed: false };
    } catch {
      return { command: null, failed: true };
    }
  });
  const busy = useRef(false);
  const save = useMutation({
    mutationFn: async (command: StockReturnInput) => {
      const productId = lines.find((line) => line.id === command.checkoutLineId)?.productId;
      const result = await api().inventory.returnStock(command);
      if (!productId || result.id !== productId) throw new Error("Unexpected returned product");
      clearReturn(storageKey, userId, command);
    },
    onSuccess: async () => {
      setStored({ command: null, failed: false });
      setQuantity("1");
      setReason("");
      await queries.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: async (error, command) => {
      if (error instanceof ApiError && error.code === "sync_generation_changed") {
        await queries.invalidateQueries({
          queryKey: ["commerce", "admin", "checkout", checkout.id],
        });
      } else if (
        error instanceof ApiError &&
        ["validation_error", "invalid_state", "not_found"].includes(error.code)
      ) {
        try {
          clearReturn(storageKey, userId, command);
          setStored({ command: null, failed: false });
        } catch {
          setStored({ command, failed: true });
        }
      }
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  const command = stored.command;
  const obsolete =
    Boolean(command && checkout.stockReturnGeneration) &&
    command?.generation !== checkout.stockReturnGeneration;
  const selected = lines.find((line) => line.id === (command?.checkoutLineId ?? selection));
  const setDraft = (change: () => void) => {
    change();
    save.reset();
    setInvalid(undefined);
  };
  return (
    <form
      method="post"
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || !online || obsolete || stored.failed || !checkout.stockReturnGeneration)
          return;
        try {
          let pending = readReturn(storageKey, userId);
          if (pending && pending.idempotencyKey !== command?.idempotencyKey) {
            setStored({ command: pending, failed: false });
            return;
          }
          pending ??= command;
          if (!pending) {
            const parsed = stockReturnSchema.safeParse({
              checkoutLineId: selection,
              quantity: /^\d+$/.test(quantity) ? Number(quantity) : undefined,
              reason,
              generation: checkout.stockReturnGeneration,
              actorUserId: userId,
              idempotencyKey: crypto.randomUUID(),
            });
            if (!parsed.success || !selected || parsed.data.quantity > selected.quantity) {
              const field =
                !parsed.success && parsed.error.issues[0]?.path[0] === "reason"
                  ? "reason"
                  : "quantity";
              setInvalid(field);
              const control = event.currentTarget.elements.namedItem(field);
              if (control instanceof HTMLInputElement) control.focus();
              return;
            }
            pending = parsed.data;
          }
          window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
          setStored({ command: pending, failed: false });
          busy.current = true;
          save.mutate(pending);
        } catch {
          setStored({ command, failed: true });
        }
      }}
    >
      <SelectField
        label={t("inventory.returnLine")}
        value={command?.checkoutLineId ?? selection}
        options={lines.map((line) => ({ value: line.id, label: line.description }))}
        disabled={Boolean(command) || save.isPending}
        onChange={(value) => setDraft(() => setSelection(value))}
      />
      <TextField
        label={t("inventory.quantity")}
        name="quantity"
        error={invalid === "quantity" ? t("inventory.returnQuantityError") : undefined}
        type="number"
        inputMode="numeric"
        min={1}
        max={selected?.quantity}
        step={1}
        required
        value={command ? String(command.quantity) : quantity}
        readOnly={Boolean(command) || save.isPending}
        onChange={(event) => setDraft(() => setQuantity(event.target.value))}
      />
      <TextField
        label={t("inventory.reason")}
        name="reason"
        error={invalid === "reason" ? t("inventory.movementReasonError") : undefined}
        minLength={3}
        maxLength={300}
        required
        value={command?.reason ?? reason}
        readOnly={Boolean(command) || save.isPending}
        onChange={(event) => setDraft(() => setReason(event.target.value))}
      />
      {stored.failed || (save.isError && !obsolete) ? (
        <p role="alert">
          {t(
            stored.failed
              ? "inventory.movementStorage"
              : command && !obsolete
                ? "inventory.movementPending"
                : "inventory.error",
          )}
        </p>
      ) : null}
      {save.isSuccess && <p role="status">{t("inventory.returnDone")}</p>}
      {obsolete && command ? (
        <>
          <p role="status">{t("inventory.movementRestored")}</p>
          <Button
            type="button"
            variant="secondary"
            disabled={stored.failed || save.isPending}
            onClick={() => {
              try {
                clearReturn(storageKey, userId, command);
                setStored({ command: null, failed: false });
                save.reset();
              } catch {
                setStored({ command, failed: true });
              }
            }}
          >
            {t("inventory.movementDiscard")}
          </Button>
        </>
      ) : (
        <Button
          type="submit"
          disabled={!online || !checkout.stockReturnGeneration || stored.failed || save.isPending}
        >
          {t(command ? "inventory.movementRetry" : "inventory.return")}
        </Button>
      )}
    </form>
  );
}
