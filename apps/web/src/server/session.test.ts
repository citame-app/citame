import { describe, expect, mock, test } from "bun:test";
import type { MeResponse } from "@sob/contracts";
import { ApiError, NetworkError } from "../lib/api/client";
import { resolveSession } from "./session";

const me = { user: { id: "u1", role: "client" } } as unknown as MeResponse;

describe("resolveSession", () => {
  test("returns the signed-in user", async () => {
    expect(await resolveSession(async () => me)).toBe(me);
  });

  test("401 means signed out, quietly", async () => {
    const log = mock(() => {});
    const session = await resolveSession(async () => {
      throw new ApiError("unauthorized", 401, "no");
    }, log);
    expect(session).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  test("429 is NOT 'signed out': it propagates so the visit can be answered with a rate-limit page", async () => {
    await expect(
      resolveSession(async () => {
        throw new ApiError("rate_limited", 429, "slow down", 17);
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 17 });
  });

  test("other failures are logged and degrade to signed out so public pages still render", async () => {
    const log = mock(() => {});
    const session = await resolveSession(async () => {
      throw new NetworkError();
    }, log);
    expect(session).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
