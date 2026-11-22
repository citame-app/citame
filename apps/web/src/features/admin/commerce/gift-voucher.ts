import type { GiftCard } from "@sob/contracts";
import type { Translator } from "~/i18n";
import { formatMoney } from "~/lib/format";
import { printDocument } from "./print-receipt";

type Voucher = Pick<
  GiftCard,
  | "label"
  | "amountCents"
  | "availableCents"
  | "currency"
  | "status"
  | "expiresAt"
  | "eligibleServices"
  | "offerTheme"
>;
export function printableGiftVoucher(
  doc: Document,
  card: Voucher,
  code: string,
  locale: string,
  t: Translator,
  timeZone: string,
) {
  const main = doc.createElement("main");
  main.style.cssText =
    "font:16px/1.6 system-ui,sans-serif;color:#171717;background:#fff;padding:32px;max-width:720px;margin:auto";
  if (card.offerTheme) {
    const accents = { rose: "#a14468", sage: "#3d7459", ink: "#26354f" };
    main.style.borderTop = `6px solid ${accents[card.offerTheme]}`;
  }
  const append = (tag: string, value: string) => {
    const node = doc.createElement(tag);
    node.textContent = value;
    main.append(node);
  };
  append("h1", "Sisters of Beauty");
  append("h2", t("gift.title"));
  append("p", card.label);
  append("p", t(`gift.status.${card.status}`));
  append("p", t("gift.value", { amount: formatMoney(card.amountCents, "EUR", locale) }));
  append("p", t("gift.available", { amount: formatMoney(card.availableCents, "EUR", locale) }));
  if (card.eligibleServices?.length)
    append(
      "p",
      t("gift.restrictedServices", {
        services: card.eligibleServices.map((service) => service.name).join(", "),
      }),
    );
  append("pre", code);
  append("p", t("gift.codeHelp"));
  append(
    "p",
    card.expiresAt
      ? t("gift.expires", {
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
          }).format(new Date(card.expiresAt)),
        })
      : t("gift.noExpiry"),
  );
  return main;
}
export function printGiftVoucher(
  card: GiftCard,
  code: string,
  locale: string,
  t: Translator,
  timeZone: string,
) {
  printDocument(t("gift.title"), locale, (doc) =>
    printableGiftVoucher(doc, card, code, locale, t, timeZone),
  );
}
