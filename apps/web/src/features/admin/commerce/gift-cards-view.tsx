import {
  type GiftCard,
  type GiftCardPurchaseInput,
  type GiftEligibleService,
  giftCardCodeSchema,
  giftCardStatusSchema,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney, localDateOf } from "~/lib/format";
import { localDayBounds } from "~/lib/zoned";
import { CheckoutPanel } from "./checkout-panel";
import { GiftBalanceChecker } from "./gift-balance-checker";
import { GiftOfferOrderForm } from "./gift-offer-order";
import { GiftOffersView } from "./gift-offers-view";
import { GiftServicePicker } from "./gift-service-picker";
import { printGiftVoucher } from "./gift-voucher";
import { invalidateCommerce } from "./invalidate";
import { inputCents } from "./money";
export type GiftNavigation = {
  review?: { actorId: string; offerId: string };
  cardId?: string;
  setCard: (id?: string) => void;
};

export function GiftCardsView({
  mode,
  role,
  accessPreset,
  giftNavigation,
}: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  giftNavigation?: GiftNavigation;
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<GiftCard["status"] | undefined>();
  const [searchInput, setSearchInput] = useState("");
  const search = /^SOB(?:[ -]|[A-F0-9]+$)/i.test(searchInput.trim()) ? "" : searchInput;
  const [creating, setCreating] = useState(false);
  const [purchaseLocked, setPurchaseLocked] = useState(false);
  const [selected, setSelected] = useState<string | null>(giftNavigation?.cardId ?? null);
  const [pendingOffer, setPendingOffer] = useState(false);
  const [showOffers, setShowOffers] = useState(false);
  const canEditOffers = mode === "admin" && permissionsFor(role, accessPreset).editCatalog;
  const cards = useQuery({
    queryKey: ["gift-cards", mode, "list", page, search, status, pendingOffer],
    queryFn: () => api().giftCards.list(mode, page, search, status, pendingOffer),
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
  if (showOffers && canEditOffers)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setShowOffers(false)}>
          {t("gift.back")}
        </Button>
        <GiftOffersView />
      </div>
    );
  if (selected)
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          onClick={() => {
            setSelected(null);
            if (giftNavigation?.cardId) giftNavigation.setCard();
          }}
        >
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
          disabled={purchaseLocked || unavailable || (mode === "client" && !capabilities.isSuccess)}
          onClick={() => setCreating(!creating)}
        >
          {t(mode === "admin" ? "gift.new" : "gift.buy")}
        </Button>
      </div>
      {unavailable && <p className="text-sm text-muted">{t("gift.purchaseUnavailable")}</p>}
      {creating && (
        <GiftPurchaseForm
          mode={mode}
          onLockChange={setPurchaseLocked}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
      {mode === "client" && giftNavigation?.review && (
        <GiftOfferOrderForm
          key={giftNavigation.review.offerId}
          {...giftNavigation.review}
          onOrder={(id) => {
            setSelected(id);
            giftNavigation.setCard(id);
          }}
        />
      )}
      {mode === "admin" && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">{t("gift.title")}</legend>
          <Button
            variant={pendingOffer ? "secondary" : "primary"}
            aria-pressed={!pendingOffer}
            onClick={() => {
              setPendingOffer(false);
              setPage(1);
            }}
          >
            {t("gift.title")}
          </Button>
          <Button
            variant={pendingOffer ? "primary" : "secondary"}
            aria-pressed={pendingOffer}
            onClick={() => {
              setPendingOffer(true);
              setStatus(undefined);
              setPage(1);
            }}
          >
            {t("gift.storefront.pending")}
          </Button>
          {canEditOffers && (
            <Button
              variant="secondary"
              disabled={purchaseLocked}
              onClick={() => setShowOffers(true)}
            >
              {t("gift.storefront.templates")}
            </Button>
          )}
        </fieldset>
      )}
      <GiftBalanceChecker mode={mode} />
      <TextField
        label={t("gift.search")}
        value={searchInput}
        onChange={(event) => {
          const value = event.target.value;
          const code = giftCardCodeSchema.safeParse(value);
          setSearchInput(code.success ? code.data.slice(-4) : value);
          setPage(1);
        }}
      />
      {!pendingOffer && (
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
      )}
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
              <Button
                variant="secondary"
                disabled={purchaseLocked}
                onClick={() => setSelected(card.id)}
              >
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
  onLockChange,
  onCreated,
}: {
  mode: CommerceMode;
  onLockChange: (locked: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { t, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [validating, setValidating] = useState(false);
  const formTitle = useId();
  const [selectedServices, setSelectedServices] = useState<GiftEligibleService[]>([]);
  const amountCents = inputCents(amount);
  const salePriceCents = mode === "admin" && price.trim() ? inputCents(price) : undefined;
  const amountInvalid = (amountCents ?? 0) <= 0;
  const priceInvalid = salePriceCents !== undefined && (salePriceCents ?? 0) <= 0;
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState("");
  const [buyer, setBuyer] = useState("");
  const [search, setSearch] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const packet = useRef<GiftCardPurchaseInput | null>(null);
  const clients = useQuery({
    ...clientsQuery({ search, pageSize: 20, sort: "name", order: "asc" }),
    enabled: mode === "admin" && search.trim().length > 0,
  });
  const save = useMutation({
    mutationFn: (request: GiftCardPurchaseInput) => api().giftCards.purchase(request, mode),
    onSuccess: (purchase) => {
      onLockChange(false);
      void invalidateCommerce(queries);
      onCreated(purchase.card.id);
    },
    onError: (error) => {
      // A response may have been lost after the server committed the purchase.
      const outcomeUnknown = uncertain || !(error instanceof ApiError) || error.status >= 500;
      setUncertain(outcomeUnknown);
      if (!outcomeUnknown) {
        packet.current = null;
        onLockChange(false);
      }
    },
  });
  const locked = save.isPending || uncertain;
  return (
    <form
      aria-labelledby={formTitle}
      className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        setValidating(true);
        if (save.isPending || !online) return;
        if (!uncertain && (amountInvalid || priceInvalid)) {
          const first = event.currentTarget.elements.namedItem(
            amountInvalid ? "gift-value" : "gift-price",
          );
          if (first instanceof HTMLInputElement) first.focus();
          return;
        }
        if (amountCents === null) return;
        packet.current ??= {
          amountCents,
          label: label.trim() || t("gift.title"),
          idempotencyKey: crypto.randomUUID(),
          ...(mode === "admin"
            ? {
                ...(salePriceCents !== undefined && salePriceCents !== null
                  ? { purchasePriceCents: salePriceCents }
                  : {}),
                ...(buyer ? { buyerClientId: buyer } : {}),
                ...(selectedServices.length
                  ? { eligibleServiceIds: selectedServices.map(({ id }) => id) }
                  : {}),
                expiresAt: expiry ? localDayBounds(expiry, timeZone).to : null,
              }
            : {}),
        };
        onLockChange(true);
        save.mutate(packet.current);
      }}
    >
      <h3 id={formTitle} className="font-semibold sm:col-span-2">
        {t("gift.new")}
      </h3>
      <TextField
        label={t("gift.amount")}
        name="gift-value"
        value={amount}
        inputMode="decimal"
        disabled={locked}
        error={validating && amountInvalid ? t("gift.positiveAmount") : undefined}
        onChange={(event) => {
          setAmount(event.target.value);
          save.reset();
        }}
      />
      {mode === "admin" && (
        <TextField
          label={t("gift.salePrice")}
          hint={t("gift.salePriceHelp")}
          name="gift-price"
          value={price}
          inputMode="decimal"
          disabled={locked}
          error={validating && priceInvalid ? t("gift.positiveAmount") : undefined}
          onChange={(event) => {
            setPrice(event.target.value);
            save.reset();
          }}
        />
      )}
      <TextField
        label={t("gift.label")}
        value={label}
        maxLength={120}
        disabled={locked}
        onChange={(event) => {
          setLabel(event.target.value);
          save.reset();
        }}
      />
      {mode === "admin" && (
        <>
          <GiftServicePicker
            disabled={locked}
            selected={selectedServices}
            onChange={(services) => {
              setSelectedServices(services);
              save.reset();
            }}
          />
          <TextField
            label={t("gift.validThrough")}
            type="date"
            value={expiry}
            disabled={locked}
            onChange={(event) => {
              setExpiry(event.target.value);
              save.reset();
            }}
          />
          <TextField
            label={t("gift.searchBuyer")}
            value={search}
            disabled={locked}
            onChange={(event) => {
              setSearch(event.target.value);
              setBuyer("");
              save.reset();
            }}
          />
          {clients.isError ? (
            <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
          ) : (
            <SelectField
              label={t("gift.buyer")}
              value={buyer}
              disabled={locked}
              options={[
                { value: "", label: t("gift.walkIn") },
                ...(clients.data?.clients ?? []).map((client) => ({
                  value: client.id,
                  label: client.name,
                })),
              ]}
              onChange={(value) => {
                setBuyer(value);
                save.reset();
              }}
            />
          )}
        </>
      )}
      {save.isError && (
        <p role="alert" className="text-danger-fg">
          {t(uncertain ? "gift.purchaseUncertain" : "gift.error")}
        </p>
      )}
      <Button type="submit" disabled={!online || save.isPending}>
        {t(uncertain ? "gift.retryPurchase" : "gift.create")}
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
        {!!current.eligibleServices?.length && (
          <p>
            {t("gift.restrictedServices", {
              services: current.eligibleServices.map((service) => service.name).join(", "),
            })}
          </p>
        )}
        {current.purchasePriceCents !== undefined &&
          current.purchasePriceCents !== current.amountCents && (
            <p>{t("gift.paidPrice", { amount: money(current.purchasePriceCents) })}</p>
          )}
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
            : current.offerValidityDays
              ? t("gift.storefront.duration", { days: current.offerValidityDays })
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
