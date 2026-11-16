import { idSchema } from "@sob/contracts";
import { z } from "zod";
import { publicOrigin } from "~/lib/public-origin";
export const bookingEntrySelectionSchema = z
  .object({
    serviceIds: z
      .array(idSchema)
      .max(24)
      .refine((ids) => new Set(ids).size === ids.length, "Choose each treatment once"),
    staffId: idSchema.optional(),
  })
  .strict();
export type BookingEntrySelection = z.infer<typeof bookingEntrySelectionSchema>;
function entry(origin: string, input: BookingEntrySelection, path: "/book" | "/widget") {
  const selection = bookingEntrySelectionSchema.parse(input);
  const url = new URL(path, publicOrigin(origin));
  if (selection.serviceIds.length) url.searchParams.set("services", selection.serviceIds.join(","));
  if (selection.staffId) url.searchParams.set("staff", selection.staffId);
  return url.toString();
}
export const bookingEntryUrl = (origin: string, input: BookingEntrySelection) =>
  entry(origin, input, "/book");
export const bookingWidgetUrl = (origin: string, input: BookingEntrySelection) =>
  entry(origin, input, "/widget");
const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
export function bookingWidgetSnippet(
  origin: string,
  input: BookingEntrySelection,
  salonName: string,
) {
  return `<iframe src="${escapeAttribute(bookingWidgetUrl(origin, input))}" title="${escapeAttribute(salonName)}" width="100%" height="640" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" style="border:0;border-radius:16px"></iframe>`;
}
