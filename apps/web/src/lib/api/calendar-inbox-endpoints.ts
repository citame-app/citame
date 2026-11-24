import {
  CALENDAR_INBOX_SCOPE_HEADER,
  type CalendarInboxQuery,
  calendarInboxSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";

export function calendarInboxEndpoints(client: ApiClient) {
  return {
    list: (query: CalendarInboxQuery = {}, signal?: AbortSignal, accessScope?: string) =>
      client.get("/admin/notifications/inbox", calendarInboxSchema, {
        query: { ...query },
        signal,
        cache: "no-store",
        ...(accessScope ? { headers: { [CALENDAR_INBOX_SCOPE_HEADER]: accessScope } } : {}),
      }),
    archive: (ids: string[], archived: boolean, accessScope?: string) =>
      client.post(
        "/admin/notifications/inbox/archive",
        { ids, archived },
        z.object({ ok: z.literal(true) }),
        {
          cache: "no-store",
          ...(accessScope ? { headers: { [CALENDAR_INBOX_SCOPE_HEADER]: accessScope } } : {}),
        },
      ),
  };
}
