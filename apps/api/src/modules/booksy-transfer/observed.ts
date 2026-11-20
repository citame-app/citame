import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import type { BooksyTransfer } from "@sob/contracts";
import { parseBooksyDayHours } from "./hours";

interface StaffCapture {
  kind: string;
  businessId: string;
  capturedAt: string;
  url: string;
  name: string;
  text: string;
  declaredServices?: string;
  fields?: { field: string; value: string }[];
  services?: { source: string; text: string; color?: string }[];
}
const minutes = (text: string) => {
  const match = /^(?:(\d+)h\s*)?(?:(\d+)min)?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) throw new Error("Unrecognized duration");
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
};
const price = (text: string) => {
  const normalized = text.replaceAll("\u00a0", " ").trim();
  if (!/^\d[\d.]*,\d{2}\s*€$/.test(normalized)) throw new Error("Unverified fixed price");
  return Number(normalized.replaceAll(".", "").replace(",", "").replace(/\s*€$/, ""));
};
function color(style: string | undefined) {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(style ?? "");
  return match
    ? `#${match
        .slice(1)
        .map((v) => Number(v).toString(16).padStart(2, "0"))
        .join("")}`
    : null;
}
const staffId = (url: string) => new URL(url).pathname.match(/\/staff\/members\/([^/]+)/)?.[1];
/** Converts only grounded list fields; unresolved records stay in the bundle and block cutover. */
export async function prepareObservedBooksy(root: string, businessId: string, fromDate: string) {
  const artifacts: BooksyTransfer["artifacts"] = [];
  const captures: unknown[] = [];
  for (const file of (await readdir(root)).sort()) {
    if (!/^[a-z-]+-[a-f0-9]{64}\.json$/.test(file)) continue;
    if ((await lstat(`${root}/${file}`)).isSymbolicLink())
      throw new Error("Source captures cannot be symlinks");
    const bytes = await readFile(`${root}/${file}`);
    const doc = JSON.parse(bytes.toString("utf8"));
    if (typeof doc.kind !== "string" || !doc.kind.startsWith("booksy-")) continue;
    const sourceMatch =
      doc.businessId === undefined &&
      typeof doc.url === "string" &&
      new URL(doc.url).hostname === "booksy.com" &&
      new URL(doc.url).pathname.startsWith(`/pro/es-es/${businessId}/`);
    if (doc.businessId !== businessId && !sourceMatch) continue;
    artifacts.push({
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    captures.push(doc);
  }
  const profiles = new Map<string, StaffCapture>();
  const hours = new Map<string, StaffCapture>();
  for (const raw of captures) {
    const d = raw as StaffCapture;
    const id = d.url ? staffId(d.url) : null;
    if (!id) continue;
    if (d.kind === "booksy-staff-detail" && d.services) {
      const old = profiles.get(id);
      const complete = d.services.length === Number(d.declaredServices?.match(/\d+/)?.[0]);
      const oldComplete =
        old && old.services?.length === Number(old.declaredServices?.match(/\d+/)?.[0]);
      if (
        !old ||
        (complete && (!oldComplete || d.capturedAt > old.capturedAt)) ||
        (!complete && !oldComplete && d.services.length > (old.services?.length ?? 0))
      )
        profiles.set(id, d);
    }
    if (
      d.kind === "booksy-staff-hours" &&
      ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"].every((day) =>
        d.text.includes(day),
      )
    ) {
      const old = hours.get(id);
      if (!old || d.capturedAt > old.capturedAt) hours.set(id, d);
    }
  }
  const coverage = Object.fromEntries(
    [
      "appointments",
      "services",
      "staff",
      "clients",
      "hours",
      "timeOff",
      "resources",
      "inventory",
      "waitlist",
      "passes",
      "giftCards",
      "consents",
      "attachments",
      "finance",
    ].map((kind) => [
      kind,
      {
        state: "not_captured",
        expected: null,
        evidence: ["No complete verified source for this entity"],
      },
    ]),
  ) as BooksyTransfer["coverage"];
  const input: BooksyTransfer = {
    version: 1,
    businessId,
    capturedAt: new Date().toISOString(),
    timezone: "Europe/Madrid",
    fromDate,
    horizon: {
      lastAppointmentAt: null,
      lastAppointmentProven: false,
      evidence: [
        "Calendar weeks were observed; absence after the last visible appointment is not proof of global source completeness",
      ],
    },
    coverage,
    artifacts,
    staff: [],
    services: [],
    clients: [],
    appointments: [],
    assignments: [],
    hours: [],
    timeOff: [],
    unprojected: [],
  };
  const serviceCandidates = new Map<
    string,
    Map<string, { source: string; text: string; color?: string }>
  >();
  for (const [id, d] of profiles) {
    input.staff.push({
      sourceId: id,
      name: d.name,
      active: true,
      maxConcurrent: null,
      raw: d as unknown as Record<string, unknown>,
    });
    if (d.services?.length !== Number(d.declaredServices?.match(/\d+/)?.[0]))
      input.unprojected.push({
        kind: "incomplete_staff_services",
        sourceId: id,
        raw: d as unknown as Record<string, unknown>,
      });
    for (const row of d.services ?? []) {
      const variants = serviceCandidates.get(row.source) ?? new Map();
      variants.set(row.text, row);
      serviceCandidates.set(row.source, variants);
    }
  }
  for (const [ref, variants] of serviceCandidates) {
    const id = ref.replace(/^services-list-item-/, "");
    if (variants.size !== 1) {
      input.unprojected.push({
        kind: "staff_specific_service_terms",
        sourceId: id,
        raw: { variants: [...variants.values()] },
      });
      continue;
    }
    const row = [...variants.values()][0]!;
    const lines = row.text
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    try {
      if (lines.length !== 3) throw new Error("Unexpected service list row");
      // A list does not prove buffers, processing, variants or combo membership.
      // Preserve the candidate intact; do not silently invent those native booking terms.
      input.unprojected.push({
        kind: "service_configuration_pending",
        sourceId: id,
        raw: {
          observed: row,
          candidate: {
            name: lines[0]!,
            color: color(row.color),
            durationMinutes: minutes(lines[1]!),
            priceCents: price(lines[2]!),
            currency: "EUR",
          },
          unknownFields: [
            "description",
            "category",
            "buffer",
            "processing",
            "variants",
            "comboMembership",
            "photos",
            "resourceConfiguration",
          ],
        },
      });
    } catch {
      input.unprojected.push({
        kind: "service_terms_unresolved",
        sourceId: id,
        raw: { observed: row },
      });
    }
  }
  const masterRows = new Map<string, unknown>();
  const masterCaptures = captures.filter(
    (raw) => (raw as { kind: string }).kind === "booksy-master-services",
  ) as { rows: { sourceId: string }[]; capturedAt: string }[];
  for (const capture of masterCaptures.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)))
    for (const row of capture.rows) masterRows.set(row.sourceId, row);
  if (masterRows.size) {
    input.unprojected = input.unprojected.filter(
      (row) => row.kind !== "service_configuration_pending" || !masterRows.has(row.sourceId),
    );
    for (const [id, row] of masterRows)
      input.unprojected.push({
        kind: "master_service_configuration_pending",
        sourceId: id,
        raw: row as Record<string, unknown>,
      });
  }
  for (const [id, d] of profiles)
    input.unprojected.push({
      kind: "staff_service_assignments_pending",
      sourceId: id,
      raw: { assignments: d.services ?? [] },
    });
  const serviceIds = new Set(input.services.map((s) => s.sourceId));
  for (const [id, d] of profiles)
    for (const row of d.services ?? []) {
      const serviceRef = row.source.replace(/^services-list-item-/, "");
      if (serviceIds.has(serviceRef)) input.assignments.push({ staffRef: id, serviceRef });
    }
  const days = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  for (const [id, d] of hours) {
    const lines = d.text.split("\n").map((x) => x.trim());
    for (const [index, day] of days.entries()) {
      const at = lines.indexOf(day);
      if (at === -1) continue;
      const next = lines.findIndex(
        (line, i) => i > at && (days.includes(line) || line.startsWith("IR A ")),
      );
      const section = lines.slice(at + 1, next === -1 ? undefined : next);
      const windows = parseBooksyDayHours(section);
      if (windows === null) {
        input.unprojected.push({
          kind: "working_hours_unresolved",
          sourceId: `${id}:${day}`,
          raw: { source: d.url, day, lines: section },
        });
        continue;
      }
      for (const [position, window] of windows.entries())
        input.hours.push({
          sourceId: `${id}:${index}:${position}`,
          staffRef: id,
          weekday: index,
          ...window,
          raw: { source: d.url, day, lines: section },
        });
    }
  }
  const cards = new Map<string, unknown[]>();
  for (const raw of captures) {
    const d = raw as {
      kind: string;
      calendarDate?: string;
      capturedAt: string;
      groups?: { day: string; cards: { sourceCardId: string; text: string }[] }[];
    };
    if (d.kind === "booksy-calendar-agenda")
      for (const group of d.groups ?? [])
        for (const card of group.cards) {
          const own = cards.get(card.sourceCardId) ?? [];
          own.push({
            calendarDate: d.calendarDate,
            capturedAt: d.capturedAt,
            day: group.day,
            ...card,
          });
          cards.set(card.sourceCardId, own);
        }
  }
  for (const [id, observations] of cards)
    input.unprojected.push({
      kind: "calendar_card_requires_reservation_and_client_mapping",
      sourceId: id,
      raw: { observations },
    });
  for (const raw of captures) {
    const d = raw as { kind: string; header?: string };
    if (d.kind === "booksy-appointment-detail")
      input.unprojected.push({
        kind: "appointment_detail_requires_projection",
        sourceId:
          d.header?.match(/\d{6,}/)?.[0] ??
          createHash("sha256").update(JSON.stringify(d)).digest("hex"),
        raw: d as unknown as Record<string, unknown>,
      });
  }
  const kinds = new Set([
    "booksy-calendar-agenda",
    "booksy-staff-detail",
    "booksy-staff-hours",
    "booksy-master-services",
    "booksy-appointment-detail",
  ]);
  for (const raw of captures) {
    const value = raw as { kind?: string };
    if (value.kind && !kinds.has(value.kind))
      input.unprojected.push({
        kind: value.kind,
        sourceId: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        raw: value as Record<string, unknown>,
      });
  }
  input.coverage.staff = {
    state: "partial",
    expected: null,
    evidence: [
      "All profiles visible in the active staff list; archived profiles and permissions are not verified",
    ],
  };
  input.coverage.services = {
    state: "partial",
    expected: null,
    evidence: [
      "Union of verified staff service lists; master catalog and full service configuration remain to be reconciled",
    ],
  };
  input.coverage.hours = {
    state: "partial",
    expected: null,
    evidence: [`${hours.size} staff schedule views captured; exceptions are not verified`],
  };
  input.coverage.appointments = {
    state: "partial",
    expected: null,
    evidence: [
      `${cards.size} distinct calendar service/block references archived; reservation and client mappings are not verified`,
    ],
  };
  return {
    input,
    summary: {
      profiles: input.staff.length,
      services: input.services.length,
      observedServices: Math.max(serviceCandidates.size, masterRows.size),
      observedAssignments: [...profiles.values()].reduce(
        (sum, profile) => sum + (profile.services?.length ?? 0),
        0,
      ),
      assignments: input.assignments.length,
      hours: input.hours.length,
      calendarReferences: cards.size,
      artifacts: artifacts.length,
      unresolved: input.unprojected.length,
      nativeAppointments: 0,
    },
  };
}
