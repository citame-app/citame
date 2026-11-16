import type { Promotion, ReviewSocial, Service } from "@sob/contracts";
import { createTranslator, type Locale } from "~/i18n";
import { formatDuration, formatMoney } from "~/lib/format";
export type CreativeSource =
  | { kind: "service"; service: Service }
  | { kind: "promotion"; promotion: Promotion; service: Service }
  | { kind: "review"; review: ReviewSocial };
export class CreativeSourceError extends Error {}
export function creativeSourceSignature(source: CreativeSource) {
  if (source.kind !== "promotion") return JSON.stringify(source);
  const { usedCount: _usage, ...terms } = source.promotion;
  return JSON.stringify({ ...source, promotion: terms });
}
export interface CreativeModel {
  kind: CreativeSource["kind"];
  eyebrow: string;
  title: string;
  emphasis: string;
  paragraphs: string[];
  caption: string;
  serviceIds: string[];
  attribution?: string;
  reviewExcerpted: boolean;
}
function excerpt(value: string, limit: number) {
  const characters = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
  ].map((part) => part.segment);
  if (characters.length <= limit) return { text: value, shortened: false };
  let text = characters.slice(0, limit).join("");
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > text.length * 0.7) text = text.slice(0, lastSpace);
  return { text: `${text.trimEnd()}…`, shortened: true };
}
export function creativeModel(
  source: CreativeSource,
  options: { locale: Locale; timeZone: string; now: Date },
): CreativeModel {
  const { locale, timeZone, now } = options;
  const t = createTranslator(locale);
  if (source.kind === "review") {
    const review = source.review;
    const quote = excerpt(review.body, 280);
    const emphasis = t("social.rating", { rating: review.rating });
    return {
      kind: "review",
      eyebrow: t("social.reviewEyebrow"),
      title: t("social.reviewTitle"),
      emphasis,
      paragraphs: [quote.text],
      attribution: review.publicName,
      reviewExcerpted: quote.shortened,
      caption: [t("social.reviewEyebrow"), emphasis, review.body, review.publicName].join("\n\n"),
      serviceIds: [],
    };
  }
  const service = source.service;
  if (service.catalog?.kind === "addon" || service.durationMinutes <= 0)
    throw new CreativeSourceError("Choose a standalone treatment or variant");
  const price = formatMoney(service.priceCents, service.currency, locale);
  if (source.kind === "service") {
    const details = t("social.serviceDetails", {
      price,
      duration: formatDuration(service.durationMinutes, locale),
    });
    return {
      kind: "service",
      eyebrow: t("social.serviceEyebrow"),
      title: service.name,
      emphasis: details,
      paragraphs: service.description
        ? [excerpt(service.description, 360).text, t("social.priceNote")]
        : [t("social.priceNote")],
      caption: [service.name, details, service.description, t("social.priceNote")]
        .filter(Boolean)
        .join("\n\n"),
      serviceIds: [service.id],
      reviewExcerpted: false,
    };
  }
  const promotion = source.promotion;
  if (
    !promotion.active ||
    (promotion.endsAt && Date.parse(promotion.endsAt) <= now.getTime()) ||
    (promotion.usageLimit !== null && promotion.usedCount >= promotion.usageLimit) ||
    !promotion.eligibleKinds.includes("service") ||
    (promotion.serviceIds.length && !promotion.serviceIds.includes(service.id)) ||
    service.currency !== "EUR"
  )
    throw new CreativeSourceError("This offer cannot advertise the selected service");
  const value =
    promotion.kind === "percent"
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
          promotion.value / 10000,
        )
      : formatMoney(
          Math.min(
            promotion.value,
            service.priceCents,
            promotion.maximumDiscountCents ?? Number.MAX_SAFE_INTEGER,
          ),
          "EUR",
          locale,
        );
  const money = (amount: number) => formatMoney(amount, "EUR", locale);
  const date = (instant: string) =>
    `${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(instant))} (${timeZone})`;
  const conditions = [
    t("social.code", { code: promotion.code }),
    t("social.forService", { name: service.name }),
    ...(promotion.minimumSpendCents
      ? [t("social.minimum", { amount: money(promotion.minimumSpendCents) })]
      : []),
    ...(promotion.maximumDiscountCents !== null
      ? [t("social.cap", { amount: money(promotion.maximumDiscountCents) })]
      : []),
    ...(promotion.perClientLimit !== null
      ? [t("social.perClient", { count: promotion.perClientLimit })]
      : []),
    ...(promotion.usageLimit !== null
      ? [t("social.totalUses", { count: promotion.usageLimit })]
      : []),
    ...(promotion.startsAt ? [t("social.from", { date: date(promotion.startsAt) })] : []),
    ...(promotion.endsAt ? [t("social.until", { date: date(promotion.endsAt) })] : []),
    t("social.notStacked"),
  ];
  const emphasis = t("social.upTo", { value });
  return {
    kind: "promotion",
    eyebrow: t("social.offerEyebrow"),
    title: promotion.name,
    emphasis,
    paragraphs: conditions,
    caption: [promotion.name, emphasis, ...conditions].join("\n\n"),
    serviceIds: [service.id],
    reviewExcerpted: false,
  };
}
