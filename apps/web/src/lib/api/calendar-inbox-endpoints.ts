import { type CalendarInboxQuery, calendarInboxSchema } from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";

export function calendarInboxEndpoints(client: ApiClient) {
  return {
    list: (query: CalendarInboxQuery = {}, signal?: AbortSignal) =>
      client.get("/admin/notifications/inbox", calendarInboxSchema, {
        query: { ...query },
        signal,
        cache: "no-store",
      }),
    archive: (ids: string[], archived: boolean) =>
      client.post(
        "/admin/notifications/inbox/archive",
        { ids, archived },
        z.object({ ok: z.literal(true) }),
      ),
  };
}
