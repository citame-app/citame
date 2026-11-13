/** English is the source catalog: its keys define what every other catalog must provide. */
export const en = {
  "common.greeting": "Hello, {name}",
  "booking.summary.services_one": "{count} service",
  "booking.summary.services_other": "{count} services",
  "common.dismiss": "Dismiss",
  "common.retry": "Try again",
  "field.password.show": "Show password",
  "field.password.hide": "Hide password",
  "error.generic.title": "Something went wrong",
  "error.generic.body": "We could not complete that. Please try again in a moment.",
  "error.offline.title": "You appear to be offline",
  "error.offline.body": "Check your connection and try again.",
  "error.offline.banner": "You are offline. Some actions are unavailable.",
  "error.rateLimited.title": "Too many attempts",
  "error.rateLimited.body_one": "Please wait {count} second and try again.",
  "error.rateLimited.body_other": "Please wait {count} seconds and try again.",
} as const;

export type MessageKey = keyof typeof en;
