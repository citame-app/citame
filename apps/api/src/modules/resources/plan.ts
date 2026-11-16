export interface ResourceWindow {
  position: number;
  start: number;
  end: number;
  quantity: number;
}
export interface OccupiedUnit {
  unitIndex: number;
  start: number;
  end: number;
}
function validWindow(row: { start: number; end: number }) {
  return Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start;
}
export type ResourceUnitPlan = { position: number; unitIndex: number }[];
export type ResourceCalendar = (requests: ResourceWindow[]) => ResourceUnitPlan | null;
/** Compile a day's occupied units once; candidate slots reuse the indexed ranges. */
export function createResourceCalendar(
  capacity: number,
  occupied: OccupiedUnit[],
): ResourceCalendar | null {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) return null;
  const units: Array<{ start: number; end: number }[]> = Array.from({ length: capacity }, () => []);
  for (const row of occupied) {
    if (
      !validWindow(row) ||
      !Number.isInteger(row.unitIndex) ||
      row.unitIndex < 0 ||
      row.unitIndex >= capacity
    )
      return null;
    units[row.unitIndex]?.push({ start: row.start, end: row.end });
  }
  for (const ranges of units) {
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return (requests) => {
    const ordered = [...requests].sort((a, b) => a.start - b.start || a.position - b.position);
    if (
      ordered.some(
        (row, i) =>
          !validWindow(row) ||
          !Number.isInteger(row.quantity) ||
          row.quantity < 1 ||
          row.quantity > capacity ||
          (i > 0 && (ordered[i - 1]?.end ?? 0) > row.start),
      )
    )
      return null;
    const overlaps = (ranges: { start: number; end: number }[], start: number, end: number) => {
      let lo = 0,
        hi = ranges.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((ranges[mid]?.end ?? Infinity) <= start) lo = mid + 1;
        else hi = mid;
      }
      return (ranges[lo]?.start ?? Infinity) < end;
    };
    const plan: { position: number; unitIndex: number }[] = [];
    for (const request of ordered) {
      let left = request.quantity;
      for (let unitIndex = 0; unitIndex < capacity && left > 0; unitIndex++) {
        if (!overlaps(units[unitIndex] ?? [], request.start, request.end)) {
          plan.push({ position: request.position, unitIndex });
          left--;
        }
      }
      if (left) return null;
    }
    return plan;
  };
}
/** Each request is one sequential service's full resource window, including cleanup. */
export function allocateResourceUnits(
  capacity: number,
  requests: ResourceWindow[],
  occupied: OccupiedUnit[],
): ResourceUnitPlan | null {
  return createResourceCalendar(capacity, occupied)?.(requests) ?? null;
}
/** Interval colouring without fixed unit assignments: a lower capacity is allowed only if all visits still fit. */
export function repackResourceUnits(
  capacity: number,
  rows: { id: string; start: number; end: number }[],
  inProgress: OccupiedUnit[] = [],
): { id: string; unitIndex: number }[] | null {
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 20 ||
    rows.some((row) => !validWindow(row)) ||
    inProgress.some(
      (row) =>
        !validWindow(row) ||
        !Number.isInteger(row.unitIndex) ||
        row.unitIndex < 0 ||
        row.unitIndex >= capacity,
    )
  )
    return null;
  const ends = Array.from({ length: capacity }, () => -Infinity);
  for (const row of inProgress)
    ends[row.unitIndex] = Math.max(ends[row.unitIndex] ?? -Infinity, row.end);
  const result: { id: string; unitIndex: number }[] = [];
  for (const row of [...rows].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  )) {
    const index = ends.findIndex((end) => end <= row.start);
    if (index < 0) return null;
    ends[index] = row.end;
    result.push({ id: row.id, unitIndex: index });
  }
  return result;
}

/** A pooled resource may recolour future interchangeable units; test peak demand rather than old unit labels. */
export function createResourceCapacityCalendar(
  capacity: number,
  occupied: OccupiedUnit[],
): ((requests: ResourceWindow[]) => boolean) | null {
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 20 ||
    occupied.some((row) => !validWindow(row))
  )
    return null;
  const changes = new Map<number, number>();
  for (const row of occupied) {
    changes.set(row.start, (changes.get(row.start) ?? 0) + 1);
    changes.set(row.end, (changes.get(row.end) ?? 0) - 1);
  }
  const times = [...changes.keys()].sort((a, b) => a - b);
  let used = 0;
  const loads = times.map((time) => {
    used += changes.get(time) ?? 0;
    return used;
  });
  let size = 1;
  while (size < loads.length) size *= 2;
  const tree = Array.from({ length: size * 2 }, () => 0);
  for (const [i, n] of loads.entries()) tree[size + i] = n;
  for (let i = size - 1; i > 0; i--) tree[i] = Math.max(tree[i * 2] ?? 0, tree[i * 2 + 1] ?? 0);
  const bound = (value: number, inclusive: boolean) => {
    let lo = 0,
      hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const t = times[mid] ?? Infinity;
      if (t < value || (inclusive && t === value)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const peak = (from: number, to: number) => {
    let lo = from + size,
      hi = to + size,
      max = 0;
    while (lo < hi) {
      if (lo & 1) max = Math.max(max, tree[lo++] ?? 0);
      if (hi & 1) max = Math.max(max, tree[--hi] ?? 0);
      lo >>= 1;
      hi >>= 1;
    }
    return max;
  };
  return (requests) => {
    const rows = [...requests].sort((a, b) => a.start - b.start || a.position - b.position);
    return rows.every((row, i) => {
      if (
        !validWindow(row) ||
        !Number.isInteger(row.quantity) ||
        row.quantity < 1 ||
        row.quantity > capacity ||
        (i > 0 && (rows[i - 1]?.end ?? 0) > row.start)
      )
        return false;
      const first = bound(row.start, true),
        last = bound(row.end, false);
      const maximum = Math.max(loads[first - 1] ?? 0, peak(first, last));
      return maximum + row.quantity <= capacity;
    });
  };
}
