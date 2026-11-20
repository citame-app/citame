import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestValkey, type TestValkey } from "../../test/valkey";
import { valkeySecondaryStorage } from "./secondary-storage";

let v: TestValkey;

beforeAll(async () => {
  v = await createTestValkey("secondary-storage");
});
afterAll(async () => {
  await v.close();
});
beforeEach(async () => {
  await v.clear();
});

function storage(prefix = v.prefix) {
  return valkeySecondaryStorage(v.client, prefix);
}

describe("valkeySecondaryStorage", () => {
  test("stores and reads a value under the configured prefix", async () => {
    const s = storage();
    await s.set("session-token", '{"user":1}');
    expect(await s.get("session-token")).toBe('{"user":1}');
    expect(await v.client.get(`${v.prefix}session-token`)).toBe('{"user":1}');
  });

  test("returns null for a missing key", async () => {
    expect(await storage().get("nope")).toBeNull();
  });

  test("applies the TTL in seconds when given, and none otherwise", async () => {
    const s = storage();
    await s.set("with-ttl", "v", 120);
    await s.set("no-ttl", "v");
    const ttl = await v.client.ttl(`${v.prefix}with-ttl`);
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
    expect(await v.client.ttl(`${v.prefix}no-ttl`)).toBe(-1);
  });

  test("delete removes the key", async () => {
    const s = storage();
    await s.set("k", "v");
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });

  test("getAndDelete returns the value exactly once", async () => {
    const s = storage();
    await s.set("once", "v");
    expect(await s.getAndDelete("once")).toBe("v");
    expect(await s.getAndDelete("once")).toBeNull();
  });

  test("increment is atomic, returns the new count and sets the TTL only once", async () => {
    const s = storage();
    const counts = await Promise.all(Array.from({ length: 25 }, () => s.increment("counter", 60)));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const ttl = await v.client.ttl(`${v.prefix}counter`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test("increment rejects a non-positive or fractional TTL", async () => {
    await expect(storage().increment("c", 0)).rejects.toThrow(/positive integer/);
    await expect(storage().increment("c", 1.5)).rejects.toThrow(/positive integer/);
  });

  test("different prefixes are isolated", async () => {
    await storage(`${v.prefix}a:`).set("k", "from-a");
    expect(await storage(`${v.prefix}b:`).get("k")).toBeNull();
  });
});
