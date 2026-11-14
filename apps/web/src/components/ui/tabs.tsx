import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
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
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(String(next))}>
      <BaseTabs.List
        aria-label={label}
        className="mb-5 flex gap-1 overflow-x-auto border-b border-line"
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
