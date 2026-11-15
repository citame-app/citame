import type { Checkout } from "@sob/contracts";
import type { Translator } from "~/i18n";
import { formatMoney } from "~/lib/format";

/** Build only receipt data. Do not clone the admin page, cash drawer or payment forms. */
export function printableReceipt(
  doc: Document,
  sale: Checkout,
  locale: string,
  t: Translator,
  timeZone = "UTC",
): HTMLElement {
  const main = doc.createElement("main");
  main.style.cssText =
    "font:14px/1.6 system-ui,sans-serif;color:#171717;background:#fff;padding:24px;max-width:720px;margin:auto";
  const text = (tag: string, value: string) => {
    const node = doc.createElement(tag);
    node.textContent = value;
    return node;
  };
  main.append(
    text("h1", "Sisters of Beauty"),
    text("h2", t("commerce.receipt")),
    text("p", sale.id),
    text(
      "p",
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
        new Date(sale.createdAt),
      ),
    ),
    text("p", t(`commerce.status.${sale.status}`)),
  );
  const table = doc.createElement("table");
  table.style.width = "100%";
  for (const line of sale.lines) {
    const row = doc.createElement("tr");
    row.append(
      text("td", `${line.description} × ${line.quantity}`),
      text("td", formatMoney(line.quantity * line.unitAmountCents, sale.currency, locale)),
    );
    table.append(row);
  }
  main.append(table);
  const totals = [
    ["commerce.discount", -sale.discountCents],
    ["commerce.tip", sale.tipCents],
    ["commerce.tax", sale.taxCents],
    ["commerce.total", sale.totalCents],
    ["commerce.paid", sale.paidCents],
    ["commerce.refunded", sale.refundedCents],
    ["commerce.balance", sale.balanceCents],
  ] as const;
  for (const [key, amount] of totals) {
    if (!amount && !["commerce.total", "commerce.paid", "commerce.balance"].includes(key)) continue;
    const row = doc.createElement("p");
    row.style.cssText = "display:flex;justify-content:space-between;gap:16px";
    row.append(text("span", t(key)), text("strong", formatMoney(amount, sale.currency, locale)));
    main.append(row);
  }
  return main;
}
export function printReceipt(sale: Checkout, locale: string, t: Translator, timeZone: string) {
  printDocument(`${t("commerce.receipt")} ${sale.id}`, locale, (doc) =>
    printableReceipt(doc, sale, locale, t, timeZone),
  );
}
export function printDocument(
  title: string,
  locale: string,
  build: (doc: Document) => HTMLElement,
) {
  document.querySelectorAll("iframe[data-sob-print-frame]").forEach((frame) => {
    frame.remove();
  });
  const active = document.activeElement;
  const frame = document.createElement("iframe");
  frame.dataset.sobPrintFrame = "";
  frame.title = title;
  frame.setAttribute("aria-hidden", "true");
  frame.sandbox.add("allow-same-origin", "allow-modals");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  document.body.append(frame);
  const doc = frame.contentDocument;
  const target = frame.contentWindow;
  if (!doc || !target) {
    frame.remove();
    return;
  }
  doc.title = title;
  doc.documentElement.lang = locale;
  doc.body.append(build(doc));
  const cleanup = () => {
    frame.remove();
    if (active instanceof HTMLElement) active.focus();
  };
  target.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(cleanup, 60_000);
  try {
    target.focus();
    target.print();
  } catch {
    cleanup();
  }
}
