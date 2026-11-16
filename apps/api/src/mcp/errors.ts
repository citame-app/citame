import type { ErrorCode } from "@sob/contracts";
import { DomainError } from "../errors";
import { rootLogger } from "../observability/logger";

/**
 * Turns a domain failure into text an agent can act on. The REST layer sends a code and a
 * message to a program; here the reader is a model, so each failure also says what to do next.
 */
const NEXT_STEP: Partial<Record<ErrorCode, string>> = {
  booking_promotion_changed:
    "Ask the customer to review the current offer and discounted deposit in the web booking confirmation. Preserve the request identifier; do not silently remove the promotion or create another visit.",
  promotion_timing_mismatch:
    "Keep the appointment's saved promotional weekday, local start window and original booking lead. Do not remove its discount or cancel/rebook without the customer's explicit review. Ask the salon for help when no qualifying time is suitable.",
  intake_required:
    "The customer must complete the current required forms in the salon's web booking flow. Never invent answers or confirm consent on their behalf. Retry after they complete the forms.",
  booking_intent_conflict:
    "This requestId already contains another confirmed statement. Call list_my_appointments to recover the visit. Do not silently replace answers or generate a new requestId to duplicate the booking.",
  slot_taken:
    "Someone else booked that time first. Call find_availability again for the same date and pick another slot.",
  slot_unavailable:
    "That time cannot be booked (outside working hours, time off, or the notice window). Call find_availability and use one of the returned slots exactly.",
  validation_error: "Fix the arguments and call the tool again.",
  not_found:
    "Check the id: list_services, find_availability and list_my_appointments return valid ids.",
  invalid_state:
    "The appointment is not in a state that allows this. Call list_my_appointments to see its status.",
  forbidden: "This account is not allowed to do that. Do not retry.",
  version_conflict:
    "Call list_services for current service terms or list_my_appointments for an existing visit. Ask the customer to review any changed price or duration before retrying.",
  has_future_appointments: "There are upcoming appointments that block this.",
};

export interface ToolFailure {
  code: ErrorCode;
  message: string;
}

export function toolFailure(error: unknown): ToolFailure {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  rootLogger.error("mcp tool failed", { err: error });
  return { code: "internal_error", message: "The salon system had an unexpected problem." };
}

/**
 * MCP tool result flagged as an error, with the next step spelled out. The machine-readable
 * code travels in `_meta`, not in `structuredContent`: clients validate structured content
 * against the tool's output schema, and an error is not an instance of it.
 */
export function errorResult(failure: ToolFailure) {
  const hint = NEXT_STEP[failure.code];
  const text = hint ? `${failure.message}. ${hint}` : failure.message;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    _meta: { error: { code: failure.code, message: failure.message } },
  };
}
