import { offsetToSnappedMinutes } from "./logic";

const THRESHOLD_PX = 5;

export function exceedsDragThreshold(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= THRESHOLD_PX;
}

export interface ColumnRect {
  staffId: string;
  date: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface DropTarget {
  staffId: string;
  date: string;
  /** Minutes since local midnight, snapped to the slot grid. */
  minutesOfDay: number;
}

/**
 * Where a dragged block would land. `grabOffsetY` is how far below the block's top edge the
 * pointer grabbed it, so the block follows the pointer without jumping.
 */
export function dropTarget(
  pointer: { x: number; y: number },
  grabOffsetY: number,
  columns: ColumnRect[],
  grid: { startHour: number; pxPerMinute: number; granularity: number },
): DropTarget | null {
  const column = columns.find(
    (c) =>
      pointer.x >= c.left && pointer.x < c.right && pointer.y >= c.top && pointer.y <= c.bottom,
  );
  if (!column) return null;
  const blockTop = pointer.y - grabOffsetY - column.top;
  const minutes = offsetToSnappedMinutes(blockTop, grid.pxPerMinute, grid.granularity);
  return {
    staffId: column.staffId,
    date: column.date,
    minutesOfDay: grid.startHour * 60 + minutes,
  };
}
