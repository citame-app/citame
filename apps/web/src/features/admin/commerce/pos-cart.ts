import type { CreateCheckoutInput, Service } from "@sob/contracts";
import { inputCents } from "./money";

export interface ReceiptItem {
  key: string;
  kind: "service" | "product" | "custom";
  id?: string;
  name: string;
  priceCents: number;
  quantity: string;
  available?: number;
  service?: Service;
}

export function extraIsEligible(extra: Service, items: ReceiptItem[]) {
  if (extra.catalog?.kind !== "addon") return true;
  const allowed = extra.catalog.allowedServiceIds;
  return items.some((item) => {
    const base = item.service;
    return (
      base &&
      base.catalog?.kind !== "addon" &&
      (allowed.includes(base.id) ||
        (base.catalog?.kind === "variant" && allowed.includes(base.catalog.parentServiceId)))
    );
  });
}

/** Only custom lines transmit an amount. Catalog prices and availability are authoritative on the server. */
export function receiptInput(
  items: ReceiptItem[],
  discount: string,
  discountType: "fixed" | "percent",
  tip: string,
) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * Number(item.quantity), 0);
  const parsedDiscount = inputCents(discount);
  const tipCents = inputCents(tip);
  const discountCents =
    parsedDiscount === null
      ? null
      : discountType === "percent"
        ? Math.round((subtotal * parsedDiscount) / 10000)
        : parsedDiscount;
  const valid =
    items.length > 0 &&
    items.length <= 100 &&
    Number.isSafeInteger(subtotal) &&
    subtotal <= 2_147_483_647 &&
    items.every(
      (item) =>
        Number.isInteger(Number(item.quantity)) &&
        Number(item.quantity) >= 1 &&
        Number(item.quantity) <= Math.min(1000, item.available ?? 1000) &&
        (!item.service || extraIsEligible(item.service, items)),
    ) &&
    parsedDiscount !== null &&
    (discountType !== "percent" || parsedDiscount <= 10000) &&
    discountCents !== null &&
    discountCents <= subtotal &&
    tipCents !== null &&
    subtotal - discountCents + tipCents <= 999999999;
  const lines: CreateCheckoutInput["lines"] = items.map((item) =>
    item.kind === "product"
      ? { kind: "product", productId: item.id, quantity: Number(item.quantity), taxBasisPoints: 0 }
      : item.kind === "service"
        ? {
            kind: "service",
            serviceId: item.id,
            quantity: Number(item.quantity),
            taxBasisPoints: 0,
          }
        : {
            kind: "custom",
            description: item.name,
            unitAmountCents: item.priceCents,
            quantity: Number(item.quantity),
            taxBasisPoints: 0,
          },
  );
  return {
    valid,
    subtotal,
    discountCents: discountCents ?? 0,
    tipCents: tipCents ?? 0,
    total: subtotal - (discountCents ?? 0) + (tipCents ?? 0),
    lines,
  };
}
