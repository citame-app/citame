import {
  type PortfolioEdit,
  type PortfolioUpload,
  portfolioAdminPhotoSchema,
  portfolioAdminSchema,
  portfolioPublicSchema,
  portfolioRemovedSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function portfolioEndpoints(client: ApiClient) {
  return {
    public: (query: { before?: string; serviceId?: string } = {}) =>
      client.get("/portfolio", portfolioPublicSchema, { query }),
    admin: () => client.get("/admin/portfolio", portfolioAdminSchema),
    upload: (input: PortfolioUpload) =>
      client.post("/admin/portfolio", input, portfolioAdminPhotoSchema),
    edit: (id: string, input: PortfolioEdit) =>
      client.put(`/admin/portfolio/${id}`, input, portfolioAdminPhotoSchema),
    publish: (id: string, version: number) =>
      client.post(
        `/admin/portfolio/${id}/publish`,
        { version, publicationConfirmed: true },
        portfolioAdminPhotoSchema,
      ),
    unpublish: (id: string, version: number) =>
      client.post(`/admin/portfolio/${id}/unpublish`, { version }, portfolioAdminPhotoSchema),
    remove: (id: string, version: number) =>
      client.post(
        `/admin/portfolio/${id}/remove`,
        { version, confirmation: true },
        portfolioRemovedSchema,
      ),
  };
}
