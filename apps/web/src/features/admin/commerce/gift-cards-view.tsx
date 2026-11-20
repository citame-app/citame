import {
  type GiftCard,
  giftCardStatusSchema,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney, localDateOf } from "~/lib/format";
import { localDayBounds } from "~/lib/zoned";
import { CheckoutPanel } from "./checkout-panel";
import { GiftBalanceChecker } from "./gift-balance-checker";
import { printGiftVoucher } from "./gift-voucher";
import { invalidateCommerce } from "./invalidate";
import { inputCents } from "./money";
export function GiftCardsView({
  mode,
  role,
  accessPreset,
}: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<GiftCard["status"] | undefined>();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const cards = useQuery({
    queryKey: ["gift-cards", mode, "list", page, search, status],
    queryFn: () => api().giftCards.list(mode, page, search, status),
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
  const capabilities = useQuery({
    queryKey: ["commerce", mode, "capabilities"],
    queryFn: () => api().commerce.capabilities(mode),
  });
  const unavailable =
    mode === "client" &&
    capabilities.isSuccess &&
    !capabilities.data.card &&
    !capabilities.data.bizum;
  if (selected)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelected(null)}>
          {t("gift.back")}
        </Button>
        <GiftDetail id={selected} mode={mode} role={role} accessPreset={accessPreset} />
      </div>
    );
  return (
    <section aria-label={t("gift.title")} className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("gift.title")}</h2>
          <p className="text-muted">{t("gift.lead")}</p>
        </div>
        <Button
          disabled={unavailable || (mode === "client" && !capabilities.isSuccess)}
          onClick={() => setCreating(!creating)}
        >
          {t(mode === "admin" ? "gift.new" : "gift.buy")}
        </Button>
      </div>
      {unavailable && <p className="text-sm text-muted">{t("gift.purchaseUnavailable")}</p>}
      {creating && (
        <GiftPurchaseForm
          mode={mode}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
      <GiftBalanceChecker mode={mode} />
      <TextField
        label={t("gift.search")}
        value={search}
        onChange={(event) => {
          const value = event.target.value;
          setSearch(
            /^SOB[ -]/i.test(value) && value.replace(/[ -]/g, "").length >= 27
              ? value.replace(/[ -]/g, "").slice(-4)
              : value,
          );
          setPage(1);
        }}
      />
      <SelectField
        label={t("inventory.filter")}
        value={status ?? ""}
        options={[
          { value: "", label: t("pos.allStatuses") },
          ...giftCardStatusSchema.options.map((value) => ({
            value,
            label: t(`gift.status.${value}`),
          })),
        ]}
        onChange={(v) => {
          setStatus(v ? (v as GiftCard["status"]) : undefined);
          setPage(1);
        }}
      />
      {cards.isPending ? (
        <Skeleton className="h-48" />
      ) : cards.isError ? (
        <ErrorState error={cards.error} onRetry={() => void cards.refetch()} />
      ) : cards.data.cards.length === 0 ? (
        <EmptyState title={t("gift.empty")} description={t("gift.emptyHelp")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {cards.data.cards.map((card) => (
            <li key={card.id} className="space-y-2 rounded-xl border border-line bg-surface p-4">
              <h3 className="font-semibold">{card.label || t("gift.title")}</h3>
              <p className="text-sm text-muted">
                •••• {card.codeLast4} · {t(`gift.status.${card.status}`)}
              </p>
              <p>
                {t("gift.available", { amount: formatMoney(card.availableCents, "EUR", locale) })}
              </p>
              <p className="text-sm text-muted">
                {t("gift.reserved", { amount: formatMoney(card.reservedCents, "EUR", locale) })}
              </p>
              <Button variant="secondary" onClick={() => setSelected(card.id)}>
                {t("gift.details")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {cards.data && <Pages page={page} total={cards.data.pagination.total} onChange={setPage} />}
    </section>
  );
}
function Pages({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="secondary" disabled={page === 1} onClick={() => onChange(page - 1)}>
        {t("inventory.previous")}
      </Button>
      <span className="self-center">{page}</span>
      <Button variant="secondary" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>
        {t("inventory.next")}
      </Button>
    </div>
  );
}
function GiftPurchaseForm({
  mode,
  onCreated,
}: {
  mode: CommerceMode;
  onCreated: (id: string) => void;
}) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState("");
  const [buyer, setBuyer] = useState("");
  const [search, setSearch] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const clients = useQuery({
    ...clientsQuery({ search, pageSize: 20, sort: "name", order: "asc" }),
    enabled: mode === "admin" && search.trim().length > 0,
  });
  const save = useMutation({
    mutationFn: () => {
      const amountCents = inputCents(amount);
      if (amountCents === null || amountCents <= 0) throw new Error("Invalid gift value");
      return api().giftCards.purchase(
        {
          amountCents,
          label: label.trim() || t("gift.title"),
          idempotencyKey: key,
          ...(mode === "admin"
            ? {
                ...(buyer ? { buyerClientId: buyer } : {}),
                expiresAt: expiry ? localDayBounds(expiry, timeZone).to : null,
              }
            : {}),
        },
        mode,
      );
    },
    onSuccess: (purchase) => {
      void invalidateCommerce(queries);
      onCreated(purchase.card.id);
    },
  });
  const reset = () => {
    setKey(crypto.randomUUID());
    save.reset();
  };
  return (
    <form
      className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("gift.new")}</h3>
      <TextField
        label={t("gift.amount")}
        value={amount}
        inputMode="decimal"
        onChange={(event) => {
          setAmount(event.target.value);
          reset();
        }}
      />
      <TextField
        label={t("gift.label")}
        value={label}
        maxLength={120}
        onChange={(event) => {
          setLabel(event.target.value);
          reset();
        }}
      />
      {mode === "admin" && (
        <>
          <TextField
            label={t("gift.validThrough")}
            type="date"
            value={expiry}
            onChange={(event) => {
              setExpiry(event.target.value);
              reset();
            }}
          />
          <TextField
            label={t("gift.searchBuyer")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setBuyer("");
              reset();
            }}
          />
          {clients.isError ? (
            <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
          ) : (
            <SelectField
              label={t("gift.buyer")}
              value={buyer}
              options={[
                { value: "", label: t("gift.walkIn") },
                ...(clients.data?.clients ?? []).map((client) => ({
                  value: client.id,
                  label: client.name,
                })),
              ]}
              onChange={(value) => {
                setBuyer(value);
                reset();
              }}
            />
          )}
        </>
      )}
      {save.isError && (
        <p role="alert" className="text-danger-fg">
          {t("gift.error")}
        </p>
      )}
      <Button type="submit" disabled={!online || save.isPending}>
        {t("gift.create")}
      </Button>
    </form>
  );
}
function GiftDetail({
  id,
  mode,
  role,
  accessPreset,
}: {
  id: string;
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t, locale, timeZone } = useI18n();
  const [page, setPage] = useState(1);
  const card = useQuery({
    queryKey: ["gift-cards", mode, id],
    queryFn: () => api().giftCards.get(id, mode),
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || query.state.data?.reservedCents ? 3000 : 30_000,
  });
  const history = useQuery({
    queryKey: ["gift-cards", mode, id, "movements", page, card.data?.version],
    queryFn: () => api().giftCards.movements(id, mode, page),
    enabled: Boolean(card.data),
  });
  if (card.isPending) return <Skeleton className="h-48" />;
  if (card.isError) return <ErrorState error={card.error} onRetry={() => void card.refetch()} />;
  const current = card.data;
  const money = (value: number) => formatMoney(value, "EUR", locale);
  return (
    <section aria-label={t("gift.details")} className="space-y-5">
      <h2 className="text-heading">{current.label || t("gift.title")}</h2>
      <p role="status">{t(`gift.status.${current.status}`)}</p>
      <div className="rounded-xl border border-line bg-surface p-4">
        <p>{t("gift.value", { amount: money(current.amountCents) })}</p>
        <p className="font-semibold">
          {t("gift.available", { amount: money(current.availableCents) })}
        </p>
        <p>{t("gift.reserved", { amount: money(current.reservedCents) })}</p>
        <p className="text-sm text-muted">
          {current.expiresAt
            ? t("gift.expires", {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone,
                }).format(new Date(current.expiresAt)),
              })
            : t("gift.noExpiry")}
        </p>
      </div>
      {current.status === "pending" ? (
        <p>{t("gift.pendingHelp")}</p>
      ) : current.status !== "void" ? (
        <GiftCode key={current.codeRevision} card={current} mode={mode} />
      ) : null}
      {mode === "admin" && permissionsFor(role, accessPreset).refunds && (
        <GiftRecovery key={`${current.id}-${current.version}`} card={current} mode={mode} />
      )}
      <details open={current.status === "pending"}>
        <summary className="cursor-pointer py-2 font-medium">{t("gift.purchaseReceipt")}</summary>
        <CheckoutPanel id={current.checkoutId} mode={mode} role={role} />
      </details>
      <h3 className="font-semibold">{t("gift.history")}</h3>
      {history.isPending ? (
        <Skeleton className="h-20" />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {history.data.movements.map((move) => (
              <li key={move.id} className="flex flex-wrap justify-between gap-3 py-3">
                <span>{t(`gift.movement.${move.kind}`)}</span>
                <span>
                  {move.amountCents > 0 ? "+" : ""}
                  {money(move.amountCents)}
                </span>
              </li>
            ))}
          </ul>
          <Pages page={page} total={history.data.pagination.total} onChange={setPage} />
        </>
      )}
    </section>
  );
}
function GiftCode({ card, mode }: { card: GiftCard; mode: CommerceMode }) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const reveal = useMutation({
    mutationFn: () => api().giftCards.reveal(card.id, mode),
    onSuccess: () => setVisible(true),
  });
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <Button
        variant="secondary"
        disabled={!online || reveal.isPending}
        onClick={() => (visible ? setVisible(false) : reveal.mutate())}
      >
        {t(visible ? "gift.hide" : "gift.reveal")}
      </Button>
      {reveal.isError && <p role="alert">{t("gift.error")}</p>}
      {visible && reveal.data && (
        <>
          <p className="text-sm text-muted">{t("gift.codeHelp")}</p>
          <fieldset
            className="select-all break-all rounded-md bg-sunken p-3 font-mono text-lg"
            aria-label={t("gift.code")}
          >
            <legend className="sr-only">{t("gift.code")}</legend>
            <code>{reveal.data.code}</code>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(reveal.data.code)
                  .then(() => setCopied("done"))
                  .catch(() => setCopied("failed"));
                if (!navigator.clipboard) setCopied("failed");
              }}
            >
              {t("gift.copy")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => printGiftVoucher(card, reveal.data.code, locale, t, timeZone)}
            >
              {t("gift.print")}
            </Button>
          </div>
          {copied && <p role="status">{t(copied === "done" ? "gift.copied" : "gift.copyError")}</p>}
        </>
      )}
    </div>
  );
}
function GiftRecovery({ card, mode }: { card: GiftCard; mode: CommerceMode }) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [expiry, setExpiry] = useState(
    card.expiresAt
      ? localDateOf(new Date(Date.parse(card.expiresAt) - 1).toISOString(), timeZone)
      : "",
  );
  const [reason, setReason] = useState("");
  const changed = () => void invalidateCommerce(queries);
  const saveExpiry = useMutation({
    mutationFn: () =>
      api().giftCards.expiry(
        card.id,
        {
          expiresAt: expiry ? localDayBounds(expiry, timeZone).to : null,
          reason: reason.trim(),
          version: card.version,
        },
        mode,
      ),
    onSuccess: changed,
  });
  const reissue = useMutation({
    mutationFn: () =>
      api().giftCards.reissue(card.id, { reason: reason.trim(), version: card.version }, mode),
    onSuccess: changed,
  });
  return (
    <details>
      <summary className="cursor-pointer py-2 font-medium">{t("gift.manage")}</summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          saveExpiry.mutate();
        }}
      >
        <TextField
          label={t("gift.validThrough")}
          type="date"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
        />
        <TextField
          label={t("gift.reason")}
          value={reason}
          minLength={3}
          required
          maxLength={300}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          type="submit"
          disabled={
            !online || saveExpiry.isPending || reissue.isPending || reason.trim().length < 3
          }
        >
          {t("gift.saveExpiry")}
        </Button>
        <p className="text-sm text-muted sm:col-span-2">{t("gift.reissueHelp")}</p>
        <Button
          variant="secondary"
          disabled={
            !online ||
            reissue.isPending ||
            saveExpiry.isPending ||
            reason.trim().length < 3 ||
            card.status === "pending" ||
            card.status === "void"
          }
          onClick={() => reissue.mutate()}
        >
          {t("gift.reissue")}
        </Button>
        {(saveExpiry.isError || reissue.isError) && (
          <p role="alert" className="text-danger-fg">
            {t("gift.error")}
          </p>
        )}
      </form>
    </details>
  );
}
