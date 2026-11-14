import { describe, expect, test } from "bun:test";
import { ApiError, NetworkError } from "~/lib/api/client";
import { describeProblem } from "./problems";

const api = (code: ConstructorParameters<typeof ApiError>[0], status = 409) =>
  new ApiError(code, status, code);

describe("describeProblem", () => {
  test("maps every 409 to a friendly key with a recovery", () => {
    expect(describeProblem(api("slot_taken"))).toEqual({
      messageKey: "problem.slotTaken",
      recovery: "pickAnotherTime",
    });
    expect(describeProblem(api("slot_unavailable"))).toEqual({
      messageKey: "problem.slotUnavailable",
      recovery: "pickAnotherTime",
    });
    expect(describeProblem(api("version_conflict"))).toEqual({
      messageKey: "problem.versionConflict",
      recovery: "reload",
    });
    expect(describeProblem(api("invalid_state"))).toEqual({
      messageKey: "problem.invalidState",
      recovery: "reload",
    });
    expect(describeProblem(api("has_future_appointments"))).toEqual({
      messageKey: "problem.hasFuture",
      recovery: "resolveAppointments",
    });
  });

  test("permission and lookup errors", () => {
    expect(describeProblem(api("forbidden", 403)).messageKey).toBe("problem.forbidden");
    expect(describeProblem(api("not_found", 404)).recovery).toBe("reload");
    expect(describeProblem(api("validation_error", 400)).messageKey).toBe("problem.validation");
  });

  test("network and unknown failures", () => {
    expect(describeProblem(new NetworkError())).toEqual({
      messageKey: "problem.offline",
      recovery: "retry",
    });
    expect(describeProblem(new Error("boom"))).toEqual({
      messageKey: "problem.generic",
      recovery: "retry",
    });
  });
});
