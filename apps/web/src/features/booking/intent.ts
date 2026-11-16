import { bookingIntentKey } from "@sob/contracts";

/** Retain each submitted intent for this form's lifetime, including when revisiting a draft. */
export function createBookingIntent(makeId: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  return <T extends Parameters<typeof bookingIntentKey>[0]>(input: T) => {
    const key = bookingIntentKey(input);
    const previous = ids.get(key);
    if (previous) return previous;
    const id = makeId();
    ids.set(key, id);
    return id;
  };
}
