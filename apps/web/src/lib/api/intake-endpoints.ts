import {
  type IntakeDefinition,
  type IntakeSubmissionInput,
  intakeAdminFormSchema,
  intakeFormsSchema,
  intakeRequirementsSchema,
  intakeSubmissionSchema,
  intakeSubmissionsSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export const intakeAdminQueryKey = ["intake", "admin"] as const;
export const intakeHistoryQueryKey = ["intake", "history"] as const;

export function intakeEndpoints(client: ApiClient) {
  return {
    forms: (signal?: AbortSignal) =>
      client.get("/admin/intake-forms", intakeFormsSchema, { signal }),
    create: (input: { idempotencyKey: string; definition: IntakeDefinition }) =>
      client.post("/admin/intake-forms", input, intakeAdminFormSchema),
    save: (id: string, version: number, definition: IntakeDefinition) =>
      client.put(`/admin/intake-forms/${id}`, { version, definition }, intakeAdminFormSchema),
    publish: (id: string, version: number) =>
      client.post(`/admin/intake-forms/${id}/publish`, { version }, intakeAdminFormSchema),
    archive: (id: string, version: number) =>
      client.post(`/admin/intake-forms/${id}/archive`, { version }, intakeAdminFormSchema),
    requirements: (serviceIds: string[], clientId?: string) =>
      client.get("/intake/requirements", intakeRequirementsSchema, {
        query: { serviceIds: serviceIds.join(","), clientId },
      }),
    history: (clientId?: string, before?: string, signal?: AbortSignal) =>
      client.get(
        clientId ? `/admin/clients/${clientId}/intake` : "/me/intake",
        intakeSubmissionsSchema,
        { query: { before }, signal },
      ),
    response: (id: string) => client.get(`/intake/submissions/${id}`, intakeSubmissionSchema),
    submit: (input: IntakeSubmissionInput, clientId?: string) =>
      client.post(
        clientId ? `/admin/clients/${clientId}/intake` : "/me/intake",
        input,
        intakeSubmissionSchema,
      ),
  };
}
