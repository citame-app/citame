import type { InventoryClassification, InventoryClassificationReorder } from "@sob/contracts";
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/ui/button";
import { ChevronDownIcon, ChevronUpIcon, GripIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";

type Target = { id: string; after: boolean };
type Drag = {
  pointer: number;
  start: number;
  y: number;
  x: number;
  id: string;
  rows: InventoryClassification[];
  generation: string;
};

export function classificationMoveProposal(
  rows: InventoryClassification[],
  generation: string,
  id: string,
  target: Target,
) {
  const source = rows.find((row) => row.id === id);
  const next = rows.filter((row) => row.id !== id);
  const index = next.findIndex((row) => row.id === target.id);
  if (!source || index < 0) return;
  next.splice(index + Number(target.after), 0, source);
  if (next.every((row, index) => rows[index]?.id === row.id)) return;
  return {
    generation,
    kind: source.kind,
    parentId: source.parentId,
    entries: next.map(({ id, version }) => ({ id, version })),
  };
}

export function classificationDropTarget(
  container: HTMLUListElement,
  source: string,
  x: number,
  y: number,
): Target | null {
  const bounds = container.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top - 6 || y > bounds.bottom + 6)
    return null;
  let last: string | undefined;
  for (const child of container.children) {
    if (!(child instanceof HTMLElement) || !child.dataset.entry || child.dataset.entry === source)
      continue;
    const rect = child.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return { id: child.dataset.entry, after: false };
    last = child.dataset.entry;
  }
  return last ? { id: last, after: true } : null;
}

function scrollContainer(list: HTMLElement): HTMLElement {
  for (let node = list.parentElement; node; node = node.parentElement) {
    if (
      node.scrollHeight > node.clientHeight &&
      /auto|scroll/.test(getComputedStyle(node).overflowY)
    )
      return node;
  }
  return document.documentElement;
}

export function ClassificationOrderList({
  rows,
  generation,
  ready,
  onMove,
  className,
  render,
}: {
  rows: InventoryClassification[];
  generation: string;
  ready: boolean;
  onMove: (input: InventoryClassificationReorder) => void;
  className?: string;
  render: (entry: InventoryClassification, movement: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const target = useRef<Target | null>(null);
  const animation = useRef<{ order: string; layout: Map<string, number> } | null>(null);
  const [active, setActive] = useState(false);
  const [marker, setMarker] = useState<Target | null>(null);
  const stop = () => {
    drag.current = null;
    target.current = null;
    setMarker(null);
    setActive(false);
  };
  const canMove = ready && rows.length > 1;

  function commit(input: InventoryClassificationReorder) {
    if (list.current && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const layout = new Map<string, number>();
      for (const child of list.current.children) {
        if (child instanceof HTMLElement && child.dataset.entry)
          layout.set(child.dataset.entry, child.offsetTop);
      }
      animation.current = { order: rows.map((entry) => entry.id).join(), layout };
    }
    onMove(input);
  }

  useLayoutEffect(() => {
    const pending = animation.current;
    if (!pending || !list.current || pending.order === rows.map((entry) => entry.id).join()) return;
    animation.current = null;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const child of list.current.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.entry) continue;
      const before = pending.layout.get(child.dataset.entry);
      if (before === undefined || before === child.offsetTop) continue;
      child.animate([{ translate: `0 ${before - child.offsetTop}px` }, { translate: "0 0" }], {
        duration: 150,
        easing: "ease-out",
      });
    }
  }, [rows]);

  useEffect(() => {
    const container = list.current;
    if (!container || !active) return;
    const scroll = scrollContainer(container);
    let frame = 0;
    let last = performance.now();
    let lastY = Number.NaN;
    let lastX = Number.NaN;
    let lastScroll = Number.NaN;
    function tick(now: number) {
      const current = drag.current;
      if (!current || !container) return;
      const rect =
        scroll === document.documentElement
          ? { top: 0, bottom: window.innerHeight }
          : scroll.getBoundingClientRect();
      const height = rect.bottom - rect.top;
      const edge = Math.min(54, height / 3);
      if (Math.abs(current.y - current.start) > 5 && edge > 0) {
        const speed =
          current.y < rect.top + edge
            ? -Math.min(1, (rect.top + edge - current.y) / edge)
            : Math.max(0, Math.min(1, (current.y - rect.bottom + edge) / edge));
        scroll.scrollTop += speed * Math.min(now - last, 35) * 0.55;
        if (current.y !== lastY || current.x !== lastX || scroll.scrollTop !== lastScroll) {
          lastY = current.y;
          lastX = current.x;
          lastScroll = scroll.scrollTop;
          const next = classificationDropTarget(container, current.id, current.x, current.y);
          if (next?.id !== target.current?.id || next?.after !== target.current?.after) {
            target.current = next;
            setMarker(next);
          }
        }
      }
      last = now;
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  function begin(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (!canMove || !event.isPrimary || event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      start: event.clientY,
      y: event.clientY,
      x: event.clientX,
      id,
      rows,
      generation,
    };
    setActive(true);
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    const source = drag.current;
    if (!source || source.pointer !== event.pointerId) return;
    const destination =
      list.current && Math.abs(source.start - event.clientY) > 5
        ? classificationDropTarget(list.current, source.id, event.clientX, event.clientY)
        : null;
    stop();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!destination || !canMove) return;
    const input = classificationMoveProposal(
      source.rows,
      source.generation,
      source.id,
      destination,
    );
    if (input) commit(input);
  }

  return (
    <ul ref={list} className={`relative ${className ?? ""}`}>
      {rows.map((entry, index) => {
        const movement = (delta: -1 | 1) => {
          const neighbor = rows[index + delta];
          if (!canMove || !neighbor) return;
          const input = classificationMoveProposal(rows, generation, entry.id, {
            id: neighbor.id,
            after: delta === 1,
          });
          if (input) commit(input);
        };
        return (
          <li
            key={entry.id}
            data-entry={entry.id}
            className={
              marker?.id !== entry.id
                ? undefined
                : marker.after
                  ? "relative after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent"
                  : "relative before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent"
            }
          >
            {render(
              entry,
              rows.length > 1 && (
                <div className="flex shrink-0 flex-wrap items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 !p-0"
                    aria-label={t("inventory.classification.moveUp", { name: entry.name })}
                    aria-disabled={!canMove || index === 0}
                    onClick={() => movement(-1)}
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 !p-0"
                    aria-label={t("inventory.classification.moveDown", { name: entry.name })}
                    aria-disabled={!canMove || index === rows.length - 1}
                    onClick={() => movement(1)}
                  >
                    <ChevronDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 !p-0 touch-none cursor-grab select-none active:cursor-grabbing"
                    aria-label={t("inventory.classification.drag", { name: entry.name })}
                    aria-disabled={!canMove}
                    onPointerDown={(event) => begin(event, entry.id)}
                    onPointerMove={(event) => {
                      if (drag.current?.pointer === event.pointerId) {
                        drag.current.y = event.clientY;
                        drag.current.x = event.clientX;
                      }
                    }}
                    onPointerUp={finish}
                    onLostPointerCapture={stop}
                    onPointerCancel={stop}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && drag.current) {
                        event.stopPropagation();
                        event.currentTarget.releasePointerCapture(drag.current.pointer);
                        stop();
                      }
                      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        movement(event.key === "ArrowUp" ? -1 : 1);
                      }
                    }}
                  >
                    <GripIcon />
                  </Button>
                </div>
              ),
            )}
          </li>
        );
      })}
    </ul>
  );
}
