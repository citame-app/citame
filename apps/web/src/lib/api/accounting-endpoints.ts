import {
  type CommissionPayoutInput,
  type CommissionPolicyInput,
  commissionPayoutSchema,
  commissionPolicySchema,
  commissionStatementSchema,
  type SalesReportQuery,
  salesReportSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function accountingEndpoints(client: ApiClient) {
  return {
    policy: (id: string) =>
      client.get(`/admin/accounting/staff/${id}/policy`, commissionPolicySchema),
    setPolicy: (id: string, body: CommissionPolicyInput) =>
      client.put(`/admin/accounting/staff/${id}/policy`, body, commissionPolicySchema),
    statement: (id: string, page = 1, payoutPage = 1) =>
      client.get(`/admin/accounting/staff/${id}/statement`, commissionStatementSchema, {
        query: { page, payoutPage },
      }),
    payout: (id: string, body: CommissionPayoutInput) =>
      client.post(`/admin/accounting/staff/${id}/payouts`, body, commissionPayoutSchema),
    sales: async (query: SalesReportQuery) => {
      const report = await client.get("/admin/accounting/sales", salesReportSchema, { query });
      if (query.clientId && !report.client) throw new Error("Missing client scope in sales report");
      return report;
    },
  };
}
