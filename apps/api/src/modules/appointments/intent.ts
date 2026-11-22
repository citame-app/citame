import { createHash } from "node:crypto";
import {
  bookingIntentKey,
  type CreateAppointmentRequest,
  intakeBookingIdentity,
} from "@sob/contracts";

export function appointmentIntentFingerprint(request: CreateAppointmentRequest): string {
  const intake = intakeBookingIdentity(request);
  return createHash("sha256")
    .update(
      bookingIntentKey(request) +
        (intake ? `\nintake:${intake}` : "") +
        (request.peakPriceReview ? `\npeak-price:${request.peakPriceReview}` : "") +
        (request.promotion
          ? `\npromotion:${request.promotion.code}:${request.promotion.reviewHash}`
          : ""),
    )
    .digest("hex");
}
