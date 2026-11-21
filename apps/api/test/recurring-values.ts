/** Public test fixtures. None of these values is a deployment credential or bank reference. */
export const RECURRING_FIXTURE = {
  baseURL: "http://localhost:4273",
  apiPort: 4300,
  ownerEmail: "recurring-owner@example.com",
  clientEmail: "recurring-client@example.com",
  password: "correct horse battery staple",
  secret: "sq7HjrUOBfKmC576ILgskD5srU870gJ7",
  reference: "120c14ed9f7264383434fc1154559f1e2bcc2b1c",
  haircut: "0198f5a0-7b1c-7000-8000-000000000101",
  importedBillingDate: "2026-11-26",
  importedBillingAppointments: [
    "0198f5a0-7b1c-7000-8000-00000000ba01",
    "0198f5a0-7b1c-7000-8000-00000000ba02",
  ],
  importedUnknownPaymentAppointments: [
    "0198f5a0-7b1c-7000-8000-00000000ba03",
    "0198f5a0-7b1c-7000-8000-00000000ba04",
  ],
} as const;
