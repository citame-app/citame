import { describe, expect, test } from "bun:test";
import { createRegistry } from "./metrics";

describe("metrics registry", () => {
  test("counters render with labels, escaped values and a stable order", () => {
    const registry = createRegistry();
    const requests = registry.counter("sob_demo_total", "Demo counter.", ["method", "route"]);
    requests.inc({ method: "GET", route: "/a" });
    requests.inc({ method: "GET", route: "/a" }, 2);
    requests.inc({ method: "POST", route: 'q"uote\\back\nline' });

    const text = registry.render();
    expect(text).toContain("# HELP sob_demo_total Demo counter.");
    expect(text).toContain("# TYPE sob_demo_total counter");
    expect(text).toContain('sob_demo_total{method="GET",route="/a"} 3');
    expect(text).toContain('sob_demo_total{method="POST",route="q\\"uote\\\\back\\nline"} 1');
  });

  test("counters without labels render a bare value, even before the first increment", () => {
    const registry = createRegistry();
    registry.counter("sob_plain_total", "Plain.", []);
    expect(registry.render()).toContain("sob_plain_total 0");
  });

  test("histograms are cumulative and carry sum, count and +Inf", () => {
    const registry = createRegistry();
    const h = registry.histogram("sob_latency_seconds", "Latency.", ["route"], [0.1, 0.5, 1]);
    h.observe({ route: "/x" }, 0.05);
    h.observe({ route: "/x" }, 0.3);
    h.observe({ route: "/x" }, 2);

    const text = registry.render();
    expect(text).toContain('sob_latency_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('sob_latency_seconds_bucket{route="/x",le="0.5"} 2');
    expect(text).toContain('sob_latency_seconds_bucket{route="/x",le="1"} 2');
    expect(text).toContain('sob_latency_seconds_bucket{route="/x",le="+Inf"} 3');
    expect(text).toContain('sob_latency_seconds_sum{route="/x"} 2.35');
    expect(text).toContain('sob_latency_seconds_count{route="/x"} 3');
  });

  test("gauges are read at render time through their collector", async () => {
    const registry = createRegistry();
    let value = 1;
    registry.gauge("sob_up", "Up.", [], () => [{ labels: {}, value }]);
    expect(await registry.renderAsync()).toContain("sob_up 1");
    value = 0;
    expect(await registry.renderAsync()).toContain("sob_up 0");
  });

  test("a failing gauge collector never breaks the scrape", async () => {
    const registry = createRegistry();
    registry.gauge("sob_broken", "Broken.", [], () => {
      throw new Error("boom");
    });
    registry.counter("sob_ok_total", "Ok.", []).inc({});
    const text = await registry.renderAsync();
    expect(text).toContain("sob_ok_total 1");
    expect(text).not.toContain("sob_broken ");
  });

  test("registering a name twice is a programming error", () => {
    const registry = createRegistry();
    registry.counter("sob_dup_total", "x", []);
    expect(() => registry.counter("sob_dup_total", "x", [])).toThrow(/already registered/);
  });

  test("unknown or missing labels are rejected so cardinality cannot explode silently", () => {
    const registry = createRegistry();
    const c = registry.counter("sob_strict_total", "x", ["route"]);
    expect(() => c.inc({ other: "a" })).toThrow(/label/);
  });
});
