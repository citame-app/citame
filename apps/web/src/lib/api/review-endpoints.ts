import {
  adminReviewsSchema,
  ownReviewsSchema,
  publicReviewsSchema,
  type ReviewCreate,
  type ReviewEdit,
  type ReviewModeration,
  type ReviewRequestQuery,
  reviewEmailRequestSchema,
  reviewPrivateSchema,
  reviewRequestsSchema,
  reviewSocialSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";

export const reviewRequestQueryKey = ["reviews", "requests"] as const;

export function reviewEndpoints(client: ApiClient) {
  return {
    public: (query: { before?: string; serviceId?: string } = {}) =>
      client.get("/reviews", publicReviewsSchema, { query }),
    own: (before?: string, appointmentId?: string) =>
      client.get("/me/reviews", ownReviewsSchema, { query: { before, appointmentId } }),
    create: (input: ReviewCreate) => client.post("/me/reviews", input, reviewPrivateSchema),
    edit: (id: string, input: ReviewEdit) =>
      client.put(`/me/reviews/${id}`, input, reviewPrivateSchema),
    withdraw: (id: string, version: number) =>
      client.post(`/me/reviews/${id}/withdraw`, { version }, reviewPrivateSchema),
    revokeSocial: (id: string, version: number) =>
      client.post(`/me/reviews/${id}/revoke-social`, { version }, reviewPrivateSchema),
    social: (id: string) =>
      client.get(`/admin/reviews/${id}/social`, reviewSocialSchema, { cache: "no-store" }),
    admin: (query: { before?: string; status?: string } = {}) =>
      client.get("/admin/reviews", adminReviewsSchema, { query }),
    requests: (query: ReviewRequestQuery) =>
      client.get("/admin/reviews/requests", reviewRequestsSchema, { query, cache: "no-store" }),
    requestEmail: (appointmentId: string) =>
      client.post(`/admin/reviews/requests/${appointmentId}/email`, {}, reviewEmailRequestSchema),
    moderate: (id: string, input: ReviewModeration) =>
      client.put(`/admin/reviews/${id}/moderation`, input, reviewPrivateSchema),
    reply: (id: string, version: number, reply: string | null) =>
      client.put(`/admin/reviews/${id}/reply`, { version, reply }, reviewPrivateSchema),
  };
}
