/**
 * A tiny Prometheus registry (counters, histograms, gauges, text exposition format 0.0.4).
 * No dependency on purpose: the surface we need is small, it is fully testable, and it runs
 * unchanged on Bun. Labels are declared up front and checked on every call, so a typo or an
 * unbounded value cannot silently create new series.
 */

type Labels = Record<string, string>;

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}

export interface Histogram {
  observe(labels: Labels, value: number): void;
}

export interface GaugeSample {
  labels: Labels;
  value: number;
}

export interface Registry {
  counter(name: string, help: string, labelNames: readonly string[]): Counter;
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram;
  /** A gauge is sampled when the registry renders, through `collect` (sync or async). */
  gauge(
    name: string,
    help: string,
    labelNames: readonly string[],
    collect: () => GaugeSample[] | Promise<GaugeSample[]>,
  ): void;
  /** Synchronous render: counters and histograms only (gauges need `renderAsync`). */
  render(): string;
  renderAsync(): Promise<string>;
}

export const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const escapeLabel = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
const escapeHelp = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");

function seriesKey(labelNames: readonly string[], labels: Labels): string {
  const given = Object.keys(labels);
  for (const key of given) {
    if (!labelNames.includes(key)) throw new Error(`Unknown label "${key}"`);
  }
  return labelNames.map((name) => labels[name] ?? "").join("\u0000");
}

function formatLabels(names: readonly string[], values: readonly string[], extra = ""): string {
  const pairs = names.map((name, i) => `${name}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) pairs.push(extra);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));

export function createRegistry(): Registry {
  const names = new Set<string>();
  const renderers: Array<() => string> = [];
  const asyncRenderers: Array<() => Promise<string>> = [];

  function claim(name: string) {
    if (names.has(name)) throw new Error(`Metric ${name} is already registered`);
    names.add(name);
  }

  return {
    counter(name, help, labelNames) {
      claim(name);
      const series = new Map<string, { values: string[]; count: number }>();
      if (labelNames.length === 0) series.set("", { values: [], count: 0 });
      renderers.push(() => {
        const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} counter`];
        for (const entry of series.values()) {
          lines.push(
            `${name}${formatLabels(labelNames, entry.values)} ${formatNumber(entry.count)}`,
          );
        }
        return lines.join("\n");
      });
      return {
        inc(labels = {}, by = 1) {
          const key = seriesKey(labelNames, labels);
          let entry = series.get(key);
          if (!entry) {
            entry = { values: labelNames.map((n) => labels[n] ?? ""), count: 0 };
            series.set(key, entry);
          }
          entry.count += by;
        },
      };
    },

    histogram(name, help, labelNames, buckets) {
      claim(name);
      const sorted = [...buckets].sort((a, b) => a - b);
      const series = new Map<
        string,
        { values: string[]; counts: number[]; sum: number; count: number }
      >();
      renderers.push(() => {
        const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} histogram`];
        for (const entry of series.values()) {
          sorted.forEach((bound, i) => {
            const labels = formatLabels(labelNames, entry.values, `le="${formatNumber(bound)}"`);
            lines.push(`${name}_bucket${labels} ${entry.counts[i] ?? 0}`);
          });
          lines.push(
            `${name}_bucket${formatLabels(labelNames, entry.values, 'le="+Inf"')} ${entry.count}`,
            `${name}_sum${formatLabels(labelNames, entry.values)} ${formatNumber(entry.sum)}`,
            `${name}_count${formatLabels(labelNames, entry.values)} ${entry.count}`,
          );
        }
        return lines.join("\n");
      });
      return {
        observe(labels, value) {
          const key = seriesKey(labelNames, labels);
          let entry = series.get(key);
          if (!entry) {
            entry = {
              values: labelNames.map((n) => labels[n] ?? ""),
              counts: sorted.map(() => 0),
              sum: 0,
              count: 0,
            };
            series.set(key, entry);
          }
          sorted.forEach((bound, i) => {
            if (value <= bound) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
          });
          entry.sum += value;
          entry.count += 1;
        },
      };
    },

    gauge(name, help, labelNames, collect) {
      claim(name);
      asyncRenderers.push(async () => {
        let samples: GaugeSample[];
        try {
          samples = await collect();
        } catch {
          // A broken collector must not take the whole scrape down: the series just disappears.
          return "";
        }
        const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} gauge`];
        for (const sample of samples) {
          const values = labelNames.map((n) => sample.labels[n] ?? "");
          lines.push(`${name}${formatLabels(labelNames, values)} ${formatNumber(sample.value)}`);
        }
        return lines.join("\n");
      });
    },

    render() {
      return `${renderers.map((r) => r()).join("\n")}\n`;
    },

    async renderAsync() {
      const gauges = await Promise.all(asyncRenderers.map((r) => r()));
      return `${[...renderers.map((r) => r()), ...gauges.filter(Boolean)].join("\n")}\n`;
    },
  };
}
