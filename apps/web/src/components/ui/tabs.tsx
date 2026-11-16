import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "~/lib/cn";

export interface TabItem {
  value: string;
  label: string;
}

/** Controlled tabs: the active value usually lives in the URL so tabs are deep-linkable. */
export function Tabs({
  label,
  items,
  value,
  onValueChange,
  children,
}: {
  label: string;
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const labels = items.map((item) => item.label).join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: translations can resize tabs while the active value stays the same
  useEffect(() => {
    const list = listRef.current;
    const activeTab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !activeTab) return;
    let active = true;
    const reveal = () => {
      if (!active) return;
      const tab = activeTab.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      if (tab.left < bounds.left) list.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right) list.scrollLeft += tab.right - bounds.right;
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(list);
    observer?.observe(activeTab);
    window.addEventListener("resize", reveal);
    reveal();
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", reveal);
    };
  }, [value, labels]);
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(String(next))}>
      <BaseTabs.List
        ref={listRef}
        aria-label={label}
        className="app-tabs mb-5 flex gap-1 overflow-x-auto border-b border-line"
      >
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={cn(
              "relative -mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-2 border-transparent px-4 text-[0.95rem] font-medium text-muted transition-colors",
              "hover:text-fg data-active:border-accent data-active:text-accent-text",
            )}
          >
            {item.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return <BaseTabs.Panel value={value}>{children}</BaseTabs.Panel>;
}
