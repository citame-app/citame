import { DomainError } from "../errors";

/**
 * Maps a failed booking to a metric outcome. `slot_taken` is the interesting one: it is the
 * exclusion constraint doing its job under contention. Every other business refusal is `rejected`.
 */
export function bookingOutcome(error: unknown): "slot_taken" | "rejected" | "error" {
  if (error instanceof DomainError) return error.code === "slot_taken" ? "slot_taken" : "rejected";
  return "error";
}
