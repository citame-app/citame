import type { TranslationKey } from "~/i18n";
import { ApiError, NetworkError } from "~/lib/api/client";

export type Recovery = "pickAnotherTime" | "reload" | "retry" | "resolveAppointments" | "none";

export interface Problem {
  messageKey: TranslationKey;
  recovery: Recovery;
}

/** Turns any failure of an admin mutation into a friendly message and the way out of it. */
export function describeProblem(error: unknown): Problem {
  if (error instanceof NetworkError) return { messageKey: "problem.offline", recovery: "retry" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "client_merged":
        return { messageKey: "merge.alias", recovery: "reload" };
      case "promotion_timing_mismatch":
        return { messageKey: "timedPromotions.mismatch", recovery: "pickAnotherTime" };
      case "intake_required":
        return { messageKey: "intake.changed", recovery: "reload" };
      case "booking_intent_conflict":
        return { messageKey: "intake.conflict", recovery: "none" };
      case "online_booking_paused":
        return { messageKey: "booking.paused.title", recovery: "none" };
      case "slot_taken":
        return { messageKey: "problem.slotTaken", recovery: "pickAnotherTime" };
      case "slot_unavailable":
        return { messageKey: "problem.slotUnavailable", recovery: "pickAnotherTime" };
      case "version_conflict":
        return { messageKey: "problem.versionConflict", recovery: "reload" };
      case "invalid_state":
        return { messageKey: "problem.invalidState", recovery: "reload" };
      case "has_future_appointments":
        return { messageKey: "problem.hasFuture", recovery: "resolveAppointments" };
      case "forbidden":
        return { messageKey: "problem.forbidden", recovery: "none" };
      case "not_found":
        return { messageKey: "problem.notFound", recovery: "reload" };
      case "validation_error":
        return { messageKey: "problem.validation", recovery: "none" };
      case "rate_limited":
        return { messageKey: "problem.rateLimited", recovery: "retry" };
    }
  }
  return { messageKey: "problem.generic", recovery: "retry" };
}
