import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareObservedBooksy } from "./observed";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("observed schedule conversion keeps breaks and preserves every unresolved calendar record", async () => {
  root = await mkdtemp(join(tmpdir(), "citame-booksy-observed-"));
  // Collector filenames and payloads are intentionally retained in their original shape.
  const { writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const write = async (prefix: string, document: unknown) => {
    const bytes = JSON.stringify(document);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(root!, `${prefix}-${hash}.json`), bytes);
  };
  const profile = {
    kind: "booksy-staff-detail",
    businessId: "synthetic",
    capturedAt: "2026-11-17T12:00:00Z",
    url: "https://booksy.com/pro/es-es/synthetic/staff/members/1",
    name: "Synthetic professional",
    text: "",
    declaredServices: "Servicios (0)",
    services: [],
  };
  await write("staff", profile);
  await write("hours", {
    ...profile,
    kind: "booksy-staff-hours",
    text: "Lunes\n09:30 - 18:30\n9h\nDescanso\n13:45 - 14:45\n1h\nMartes\nInactivo\n-\nMiércoles\nInactivo\n-\nJueves\nInactivo\n-\nViernes\nInactivo\n-\nSábado\nInactivo\n-\nDomingo\nInactivo\n-\nIR A HORARIOS",
  });
  await write("agenda", {
    kind: "booksy-calendar-agenda",
    businessId: "synthetic",
    capturedAt: "2026-11-17T12:00:00Z",
    calendarDate: "Wed Nov 18 2026",
    groups: [
      { day: "mié., 18 nov.", cards: [{ sourceCardId: "card-1", text: "Unknown source fields" }] },
    ],
  });
  const result = await prepareObservedBooksy(root, "synthetic", "2026-11-18");
  expect(result.input.hours.map((r) => [r.start, r.end])).toEqual([
    ["09:30", "13:45"],
    ["14:45", "18:30"],
  ]);
  expect(result.summary.calendarReferences).toBe(1);
  expect(result.input.appointments).toHaveLength(0);
  expect(
    result.input.unprojected.some(
      (row) =>
        row.kind === "calendar_card_requires_reservation_and_client_mapping" &&
        row.sourceId === "card-1",
    ),
  ).toBe(true);
  expect(result.input.horizon.lastAppointmentProven).toBe(false);
});
