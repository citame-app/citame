import { useEffect } from "react";

const property = "--sheet-footer-height";
const heights = new Map<symbol, number>();
let previous = "";

/** Keep notices above every open sheet's actions, including nested or resizing panels. */
export function useSheetFooterInset(open: boolean, footer: HTMLElement | null, centered = false) {
  useEffect(() => {
    if (!open || !footer) return;
    const root = footer.ownerDocument.documentElement;
    const key = Symbol();
    if (!heights.size) previous = root.style.getPropertyValue(property);
    let active = true;
    const publish = () => {
      if (heights.size) root.style.setProperty(property, `${Math.max(...heights.values())}px`);
      else if (previous) root.style.setProperty(property, previous);
      else root.style.removeProperty(property);
    };
    const measure = () => {
      if (!active) return;
      const bounds = footer.getBoundingClientRect();
      const height = centered
        ? Math.max(bounds.height, window.innerHeight - bounds.top)
        : bounds.height;
      heights.set(key, Number.isFinite(height) ? Math.max(0, Math.ceil(height)) : 0);
      publish();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(footer);
    if (centered && footer.parentElement) observer?.observe(footer.parentElement);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      heights.delete(key);
      publish();
    };
  }, [open, footer, centered]);
}
