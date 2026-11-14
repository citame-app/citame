import { type CreateAppointmentRequest, phoneSchema } from "@sob/contracts";

export interface WalkInValues {
  clientMode: "existing" | "new";
  clientId: string;
  newName: string;
  newPhone: string;
  serviceIds: string[];
  staffId: string;
  startsAt: string;
  notes: string;
  /** Staff and owners may book inside the minimum-notice window. */
  override: boolean;
}

export type WalkInErrors = Partial<
  Record<"client" | "phone" | "services" | "staff" | "time", "required" | "invalid">
>;

export function validateWalkIn(values: WalkInValues): WalkInErrors {
  const errors: WalkInErrors = {};
  if (values.clientMode === "existing" ? values.clientId === "" : values.newName.trim() === "") {
    errors.client = "required";
  }
  if (
    values.clientMode === "new" &&
    values.newPhone.trim() !== "" &&
    !phoneSchema.safeParse(values.newPhone).success
  ) {
    errors.phone = "invalid";
  }
  if (values.serviceIds.length === 0) errors.services = "required";
  if (values.staffId === "") errors.staff = "required";
  if (values.startsAt === "") errors.time = "required";
  return errors;
}

export function buildWalkInRequest(values: WalkInValues): CreateAppointmentRequest {
  const phone = values.newPhone.trim();
  const notes = values.notes.trim();
  return {
    staffId: values.staffId,
    serviceIds: values.serviceIds,
    startsAt: values.startsAt,
    ...(values.clientMode === "existing"
      ? { clientId: values.clientId }
      : { client: { name: values.newName.trim(), ...(phone ? { phone } : {}) } }),
    ...(notes ? { notes } : {}),
    ...(values.override ? { override: true } : {}),
  };
}
