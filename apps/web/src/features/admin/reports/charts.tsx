import type { ReportSummary } from "@sob/contracts";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useI18n } from "~/i18n/react";
import { dayOfMonth, formatMoney, monthShort } from "~/lib/format";

/** Charts only render after mount: Recharts measures the DOM, and SSR output would never match. */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

const AXIS = { fontSize: 12, fill: "var(--fg-muted)" } as const;
const tooltipStyle = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--fg)",
} as const;

const shortDate = (date: string, locale: string) =>
  `${dayOfMonth(date)} ${monthShort(date, locale)}`;

/** One series, one hue (the brand accent). Thin bars with rounded tops, quiet grid. */
export function RevenueChart({
  series,
  currency,
}: {
  series: ReportSummary["series"];
  currency: string;
}) {
  const { locale } = useI18n();
  const mounted = useMounted();
  if (!mounted) return <div className="h-64" />;
  const data = series.map((d) => ({ date: d.date, revenue: d.revenueCents / 100 }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => shortDate(v, locale)}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={16}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => formatMoney(v * 100, currency, locale)}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "var(--surface-sunken)" }}
            labelFormatter={(v) => shortDate(String(v), locale)}
            formatter={(v) => formatMoney(Number(v) * 100, currency, locale)}
          />
          <Bar
            dataKey="revenue"
            fill="var(--accent)"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive="auto"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Stacked by status with a 2px surface gap; the legend is always present (identity is never color alone). */
export function StatusChart({
  series,
  labels,
}: {
  series: ReportSummary["series"];
  labels: Record<"completed" | "no_show" | "cancelled" | "booked", string>;
}) {
  const { locale } = useI18n();
  const mounted = useMounted();
  if (!mounted) return <div className="h-64" />;
  const data = series.map((d) => ({ date: d.date, ...d.byStatus }));
  const stroke = { stroke: "var(--surface)", strokeWidth: 2 } as const;
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => shortDate(v, locale)}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={16}
          />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "var(--surface-sunken)" }}
            labelFormatter={(v) => shortDate(String(v), locale)}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--fg-muted)" }} />
          <Bar
            dataKey="completed"
            name={labels.completed}
            stackId="s"
            fill="var(--success-fg)"
            {...stroke}
            maxBarSize={28}
          />
          <Bar
            dataKey="booked"
            name={labels.booked}
            stackId="s"
            fill="var(--accent)"
            {...stroke}
            maxBarSize={28}
          />
          <Bar
            dataKey="no_show"
            name={labels.no_show}
            stackId="s"
            fill="var(--warning-fg)"
            {...stroke}
            maxBarSize={28}
          />
          <Bar
            dataKey="cancelled"
            name={labels.cancelled}
            stackId="s"
            fill="var(--border-strong)"
            {...stroke}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
