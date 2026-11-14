/**
 * In-process counters of the notification pipeline, ready for the Phase 8 observability work:
 * `snapshot()` is plain data and `toPrometheus()` renders the text exposition format. They
 * count events of THIS process; the queue itself (`/admin/notifications/stats`) is the
 * cross-process truth.
 */
export const METRIC_NAMES = [
  "claimed",
  "sent",
  "skipped",
  "retried",
  "dead_lettered",
  "lease_lost",
  "errors",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export interface Metrics {
  inc(name: MetricName, by?: number): void;
  snapshot(): Record<MetricName, number>;
  toPrometheus(): string;
}

export function createMetrics(): Metrics {
  const counters = Object.fromEntries(METRIC_NAMES.map((n) => [n, 0])) as Record<
    MetricName,
    number
  >;
  return {
    inc(name, by = 1) {
      counters[name] += by;
    },
    snapshot: () => ({ ...counters }),
    toPrometheus: () =>
      `${METRIC_NAMES.map(
        (n) =>
          `# TYPE sob_notifications_${n}_total counter\nsob_notifications_${n}_total ${counters[n]}`,
      ).join("\n")}\n`,
  };
}

/** Shared by the API process and the standalone worker entrypoint. */
export const processMetrics = createMetrics();
