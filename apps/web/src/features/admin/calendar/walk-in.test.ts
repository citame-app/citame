import { describe, expect, test } from "bun:test";
import { buildWalkInRequest, validateWalkIn, type WalkInValues } from "./walk-in";

const base: WalkInValues = {
  clientMode: "existing",
  clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
  newName: "",
  newPhone: "",
  serviceIds: ["0198f5a0-7b1c-7000-8000-000000000101"],
  staffId: "0198f5a0-7b1c-7000-8000-000000000201",
  startsAt: "2026-03-09T12:00:00.000Z",
  notes: "",
  override: false,
};

describe("validateWalkIn", () => {
  test("a complete form is valid", () => {
    expect(validateWalkIn(base)).toEqual({});
  });

  test("an existing client must be picked, a new one needs a name", () => {
    expect(validateWalkIn({ ...base, clientId: "" })).toEqual({ client: "required" });
    expect(validateWalkIn({ ...base, clientMode: "new", newName: " " })).toEqual({
      client: "required",
    });
    expect(
      validateWalkIn({ ...base, clientMode: "new", newName: "Lucia", newPhone: "12" }),
    ).toEqual({ phone: "invalid" });
    expect(validateWalkIn({ ...base, clientMode: "new", newName: "Lucia", newPhone: "" })).toEqual(
      {},
    );
  });

  test("needs services, a professional and a time", () => {
    expect(validateWalkIn({ ...base, serviceIds: [], staffId: "", startsAt: "" })).toEqual({
      services: "required",
      staff: "required",
      time: "required",
    });
  });
});

describe("buildWalkInRequest", () => {
  test("existing client sends clientId only", () => {
    expect(buildWalkInRequest(base)).toEqual({
      staffId: base.staffId,
      serviceIds: base.serviceIds,
      startsAt: base.startsAt,
      clientId: base.clientId,
    });
  });

  test("new client sends the inline client, trims notes and forwards the override", () => {
    expect(
      buildWalkInRequest({
        ...base,
        clientMode: "new",
        newName: " Lucia ",
        newPhone: " +54 9 11 5555-0000 ",
        notes: " allergy ",
        override: true,
      }),
    ).toEqual({
      staffId: base.staffId,
      serviceIds: base.serviceIds,
      startsAt: base.startsAt,
      client: { name: "Lucia", phone: "+54 9 11 5555-0000" },
      notes: "allergy",
      override: true,
    });
  });
});
