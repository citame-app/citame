import {
  adminReviewsSchema,
  ownReviewsSchema,
  publicReviewsSchema,
  type ReviewCreate,
  type ReviewEdit,
  type ReviewModeration,
  reviewPrivateSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function reviewEndpoints(client: ApiClient) {
  return {
    public: (query: { before?: string; serviceId?: string } = {}) =>
      client.get("/reviews", publicReviewsSchema, { query }),
    own: (before?: string) => client.get("/me/reviews", ownReviewsSchema, { query: { before } }),
    create: (input: ReviewCreate) => client.post("/me/reviews", input, reviewPrivateSchema),
    edit: (id: string, input: ReviewEdit) =>
      client.put(`/me/reviews/${id}`, input, reviewPrivateSchema),
    withdraw: (id: string, version: number) =>
      client.post(`/me/reviews/${id}/withdraw`, { version }, reviewPrivateSchema),
    admin: (query: { before?: string; status?: string } = {}) =>
      client.get("/admin/reviews", adminReviewsSchema, { query }),
    moderate: (id: string, input: ReviewModeration) =>
      client.put(`/admin/reviews/${id}/moderation`, input, reviewPrivateSchema),
    reply: (id: string, version: number, reply: string | null) =>
      client.put(`/admin/reviews/${id}/reply`, { version, reply }, reviewPrivateSchema),
  };
}
