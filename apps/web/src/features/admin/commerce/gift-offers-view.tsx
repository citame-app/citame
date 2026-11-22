import {
  type GiftEligibleService,
  type GiftOffer,
  type GiftOfferUpdate,
  giftOfferThemeSchema,
  giftOfferWriteSchema,
  type PublicGiftOffer,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { GiftOfferCard } from "~/features/booking/gift-storefront";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { GiftServicePicker } from "./gift-service-picker";
import { invalidateCommerce } from "./invalidate";
import { centsInput, inputCents } from "./money";

export function GiftOffersView() {
  const { t } = useI18n();
  const [editing, setEditing] = useState<GiftOffer | "new" | null>(null);
  const offers = useQuery({
    queryKey: ["gift-cards", "offers"],
    queryFn: () => api().giftCards.offers(),
  });
  return (
    <section className="space-y-4" aria-label={t("gift.storefront.templates")}>
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-heading">{t("gift.storefront.templates")}</h3>
        {!editing && (
          <Button onClick={() => setEditing("new")}>{t("gift.storefront.newTemplate")}</Button>
        )}
      </div>
      {editing ? (
        <GiftOfferEditor
          key={editing === "new" ? "new" : editing.id}
          offer={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : offers.isPending ? (
        <Skeleton className="h-32" />
      ) : offers.isError ? (
        <ErrorState error={offers.error} onRetry={() => void offers.refetch()} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {offers.data.offers.map((offer) => (
            <li
              key={offer.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4"
            >
              <div className="min-w-0">
                <p className="font-semibold">{offer.name}</p>
                <p className="text-sm text-muted">
                  {t(offer.published ? "gift.storefront.published" : "gift.storefront.draft")}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setEditing(offer)}>
                {t("gift.storefront.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GiftOfferEditor({ offer, onClose }: { offer?: GiftOffer; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const online = useOnline();
  const heading = useId();
  const [id] = useState(() => offer?.id ?? crypto.randomUUID());
  const [name, setName] = useState(offer?.name ?? "");
  const [description, setDescription] = useState(offer?.description ?? "");
  const [amount, setAmount] = useState(offer ? centsInput(offer.amountCents) : "");
  const [price, setPrice] = useState(offer ? centsInput(offer.priceCents) : "");
  const [days, setDays] = useState(offer?.validityDays?.toString() ?? "");
  const [theme, setTheme] = useState<GiftOffer["theme"]>(offer?.theme ?? "rose");
  const [published, setPublished] = useState(offer?.published ?? false);
  const [selected, setSelected] = useState<GiftEligibleService[] | null>(null);
  const catalog = useQuery({
    queryKey: ["gift-cards", "eligible-services"],
    queryFn: ({ signal }) => api().giftCards.eligibleServices(signal),
    enabled: Boolean(offer?.eligibleServiceIds.length),
  });
  const services =
    selected ??
    (offer?.eligibleServiceIds ?? []).map(
      (id) =>
        catalog.data?.services.find((service) => service.id === id) ?? {
          id,
          name: t("gift.inactiveService"),
        },
    );
  const [validation, setValidation] = useState(false);
  const save = useMutation({
    mutationFn: (input: GiftOfferUpdate) => api().giftCards.saveOffer(id, input),
    onSuccess: () => {
      void invalidateCommerce(queryClient);
      onClose();
    },
  });
  const terms = giftOfferWriteSchema.safeParse({
    name,
    description,
    amountCents: inputCents(amount),
    priceCents: inputCents(price),
    validityDays: days.trim() === "" ? null : Number(days),
    eligibleServiceIds: services.map(({ id }) => id),
    published,
    theme,
    version: offer?.version ?? 0,
  });
  const preview: PublicGiftOffer | undefined = terms.success
    ? {
        id,
        name: terms.data.name,
        description: terms.data.description,
        theme,
        amountCents: terms.data.amountCents,
        priceCents: terms.data.priceCents,
        validityDays: terms.data.validityDays,
        version: terms.data.version,
        eligibleServices: services,
      }
    : undefined;
  return (
    <form
      aria-labelledby={heading}
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setValidation(true);
        if (online && !save.isPending && terms.success) save.mutate(terms.data);
      }}
    >
      <h4 id={heading} className="font-semibold">
        {t(offer ? "gift.storefront.edit" : "gift.storefront.newTemplate")}
      </h4>
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={save.isPending}>
        <legend className="sr-only">{t("gift.storefront.templates")}</legend>
        <TextField
          label={t("gift.label")}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField
          label={t("gift.storefront.design")}
          value={theme}
          options={giftOfferThemeSchema.options.map((value) => ({
            value,
            label: t(`gift.storefront.theme.${value}`),
          }))}
          onChange={(value) => setTheme(giftOfferThemeSchema.parse(value))}
        />
        <TextField
          label={t("gift.amount")}
          required
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label={t("gift.storefront.salePrice")}
          required
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
        <TextField
          label={t("gift.storefront.validity")}
          type="number"
          min={1}
          max={730}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <TextAreaField
          label={t("gift.storefront.description")}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <GiftServicePicker disabled={save.isPending} selected={services} onChange={setSelected} />
        <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:col-span-2">
          <input
            type="checkbox"
            checked={published}
            onChange={(event) => setPublished(event.target.checked)}
          />
          {t("gift.storefront.publish")}
        </label>
      </fieldset>
      {preview && <GiftOfferCard offer={preview} />}
      {validation && !terms.success && (
        <p role="alert" className="text-danger-fg">
          {t("gift.storefront.invalid")}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-danger-fg">
          {t("gift.storefront.saveError")}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!online || save.isPending}>
          {t("gift.storefront.save")}
        </Button>
        <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
          {t("gift.back")}
        </Button>
      </div>
    </form>
  );
}
