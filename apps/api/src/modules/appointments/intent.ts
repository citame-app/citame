import { createHash } from "node:crypto";
import { bookingIntentKey, type CreateAppointmentRequest } from "@sob/contracts";

export function appointmentIntentFingerprint(request: CreateAppointmentRequest): string {
  return createHash("sha256").update(bookingIntentKey(request)).digest("hex");
}
