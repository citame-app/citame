import { idSchema, localDateSchema, reportQuerySchema } from "@sob/contracts";
import { presetRange, REPORT_PRESETS, type ReportPreset } from "./logic";

export interface ReportsSearch {
  preset: ReportPreset | "custom";
  from?: string;
  to?: string;
  staff?: string;
  currency?: string;
}

export function validateReportsSearch(raw: Record<string, unknown>): ReportsSearch {
  const preset =
    raw.preset === "custom" ? "custom" : (REPORT_PRESETS.find((p) => p === raw.preset) ?? "last30");
  const from = localDateSchema.safeParse(raw.from);
  const to = localDateSchema.safeParse(raw.to);
  const staff = idSchema.safeParse(raw.staff);
  return {
    preset,
    ...(preset === "custom" && from.success ? { from: from.data } : {}),
    ...(preset === "custom" && to.success ? { to: to.data } : {}),
    ...(staff.success ? { staff: staff.data } : {}),
    ...(typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency)
      ? { currency: raw.currency }
      : {}),
  };
}

export function resolveRange(search: ReportsSearch, today: string): { from: string; to: string } {
  if (search.preset === "custom" && search.from && search.to)
    return { from: search.from, to: search.to };
  return presetRange(search.preset === "custom" ? "last30" : search.preset, today);
}

export function rangeError(range: { from: string; to: string }): "order" | "tooLong" | null {
  const parsed = reportQuerySchema.safeParse(range);
  if (parsed.success) return null;
  return range.to < range.from ? "order" : "tooLong";
}
