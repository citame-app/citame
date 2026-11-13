/** English is the source catalog: its keys define what every other catalog must provide. */
export const en = {
  "common.greeting": "Hello, {name}",
  "booking.summary.services_one": "{count} service",
  "booking.summary.services_other": "{count} services",
} as const;

export type MessageKey = keyof typeof en;
