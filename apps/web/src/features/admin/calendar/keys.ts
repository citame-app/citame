export type Shortcut =
  | "today"
  | "previous"
  | "next"
  | "day"
  | "week"
  | "month"
  | "list"
  | "new"
  | "refresh"
  | "help";

const MAP: Record<string, Shortcut> = {
  t: "today",
  ArrowLeft: "previous",
  "[": "previous",
  ArrowRight: "next",
  "]": "next",
  d: "day",
  w: "week",
  m: "month",
  l: "list",
  n: "new",
  r: "refresh",
  "?": "help",
};

export function shortcutFor(event: {
  key: string;
  typing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): Shortcut | null {
  if (event.typing || event.ctrlKey || event.metaKey || event.altKey) return null;
  return MAP[event.key] ?? MAP[event.key.toLowerCase()] ?? null;
}

/** Keyboard alternative to dragging: Alt+Up/Down moves by one slot, Alt+Left/Right by one column. */
export function keyboardMove(input: {
  key: string;
  altKey: boolean;
  startsAt: string;
  staffId: string;
  staffIds: string[];
  granularity: number;
}): { startsAt: string; staffId: string } | null {
  if (!input.altKey) return null;
  const step = input.granularity * 60_000;
  const at = Date.parse(input.startsAt);
  switch (input.key) {
    case "ArrowDown":
      return { startsAt: new Date(at + step).toISOString(), staffId: input.staffId };
    case "ArrowUp":
      return { startsAt: new Date(at - step).toISOString(), staffId: input.staffId };
    case "ArrowLeft":
    case "ArrowRight": {
      const index = input.staffIds.indexOf(input.staffId);
      const next = input.staffIds[index + (input.key === "ArrowRight" ? 1 : -1)];
      return next ? { startsAt: input.startsAt, staffId: next } : null;
    }
    default:
      return null;
  }
}
