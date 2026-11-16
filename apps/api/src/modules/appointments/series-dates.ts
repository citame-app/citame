import type { AppointmentSeriesInput } from "@sob/contracts";
import { DomainError } from "../../errors";

/** Derive each date from the original day, rather than a previously clamped month. */
export function seriesStartsAt(
  input: Pick<AppointmentSeriesInput, "startsAt" | "cadence" | "interval" | "count">,
  timezone: string,
): string[] {
  try {
    const first = Temporal.Instant.from(input.startsAt).toZonedDateTimeISO(timezone);
    const date = first.toPlainDate();
    const time = first.toPlainTime();
    return Array.from({ length: input.count }, (_, i) => {
      if (i === 0) return new Date(first.epochMilliseconds).toISOString();
      const next = date.add(
        input.cadence === "weekly" ? { weeks: input.interval * i } : { months: input.interval * i },
      );
      const zoned = next
        .toPlainDateTime(time)
        .toZonedDateTime(timezone, { disambiguation: "reject" });
      return new Date(zoned.epochMilliseconds).toISOString();
    });
  } catch {
    throw new DomainError(
      "validation_error",
      "A recurring visit has an ambiguous or nonexistent local time; choose a different start time",
    );
  }
}
