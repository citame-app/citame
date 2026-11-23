import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { appointmentContextSchema, calendarAppointmentSchema } from "@sob/contracts";
import { z } from "zod";
import { fingerprint, sourceUuid } from "../modules/booksy-transfer/plan";
import {
  type BooksySourceReadModel,
  booksyCents,
  sourceInstant,
} from "../modules/booksy-transfer/source-read-model";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { privateWriteVerified } from "../modules/booksy-transfer/vault";

const ref = z.string().regex(/^\d+$/);
const instant = z.iso.datetime();
const common = z.object({
  capturedAt: instant,
  date: z.iso.date(),
  timezone: z.literal("Europe/Madrid"),
});
const textEvidence = common.extend({ ref: z.string(), text: z.string(), textSha256: z.string() });
const card = textEvidence.extend({
  source: z.literal("booksy_visible_calendar_card"),
  appointmentRef: ref,
  columnResource: ref,
  itemElementId: z.string().regex(/^cc-\d+$/),
});
const drawer = textEvidence.extend({
  source: z.literal("booksy_visible_drawer"),
  calendarRange: z.object({ start: z.string(), end: z.string() }),
});
const assignment = common.extend({
  source: z.literal("booksy_visible_appointment_assignment"),
  ref: z.string(),
  fields: z
    .array(
      z.object({
        label: z.enum(["Inicio", "Fin", "Empleado", "Recurso"]),
        value: z.string().min(1),
      }),
    )
    .length(4),
});
const profile = common.extend({
  source: z.literal("booksy_visible_customer_profile"),
  bookingRef: z.string(),
  customerRef: ref,
  name: z.string().min(1),
  phone: z.string().min(1),
  matchedNameAndPhone: z.literal(true),
});
const notes = textEvidence.extend({
  source: z.literal("booksy_visible_notes"),
  fields: z.array(z.object({ placeholder: z.string().nullable(), value: z.string() })),
});
export const visibleBookingEnvelope = z.object({
  kind: z.literal("booksy-reviewed-visible-booking"),
  businessId: z.string(),
  parentHash: z.string().regex(/^[a-f0-9]{64}$/),
  originals: z.array(z.object({ bytes: z.base64(), sha256: z.string() })).length(5),
});
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").normalize("NFC");
const localPhone = (s: string) => s.replace(/\D/g, "").replace(/^(?:0034|34)(?=\d{9}$)/, "");

/** Accept only a reviewed visible single service with an independently identified customer and assignment. */
export function appendVisibleBooking(
  model: BooksySourceReadModel,
  documents: unknown[],
  evidence: BooksySourceReadModel["base"]["artifacts"][number],
  holdContact = false,
  holdAmount = false,
) {
  const c = card.parse(documents[0]);
  const d = drawer.parse(documents[1]);
  const a = assignment.parse(documents[2]);
  const p = profile.parse(documents[3]);
  const n = notes.parse(documents[4]);
  const groupRef = c.appointmentRef;
  const itemRef = c.itemElementId.slice(3);
  if (
    [c, d, a, n].some((row) => row.ref !== `a-${groupRef}` || row.date !== c.date) ||
    p.bookingRef !== c.ref ||
    p.date !== c.date ||
    c.date < model.fromDate ||
    c.date > model.throughDate
  )
    throw new Error("Visible evidence disagrees on reservation identity or day");
  if ([c, d, n].some((row) => sha256(row.text) !== row.textSha256))
    throw new Error("Visible evidence text has changed");
  if (
    model.groups.some((g) => g.sourceId === groupRef) ||
    model.appointments.some((row) => row.sourceCopy?.itemRef === itemRef)
  )
    throw new Error("The visible line or its reservation is already archived");
  const fields = new Map(a.fields.map((field) => [field.label, normalize(field.value)]));
  const { start, end } = d.calendarRange;
  if (
    fields.size !== 4 ||
    fields.get("Inicio") !== start ||
    fields.get("Fin") !== end ||
    !c.text.includes(`${start}`) ||
    !c.text.includes(`${end}`)
  )
    throw new Error("Visible card and assigned times differ");
  const startsAt = sourceInstant(`${c.date}T${start}`);
  const endsAt = sourceInstant(`${c.date}T${end}`);
  const durationMinutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
  const lines = d.text.split("\n").map(normalize).filter(Boolean);
  const header = lines.indexOf("RESERVA DE GRUPO");
  const serviceName = lines[header + 2];
  const price = lines[header + 4];
  const hourLabel = `${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 ? ` ${durationMinutes % 60}min` : ""}`;
  if (
    header < 0 ||
    !serviceName ||
    !price ||
    lines[0] !== "CONFIRMADO" ||
    durationMinutes <= 0 ||
    (lines[header + 3] !== `${durationMinutes}min` &&
      !(holdAmount && durationMinutes >= 60 && lines[header + 3] === hourLabel)) ||
    lines[header + 5] !== "Extras" ||
    lines[header + 6] !== "Inicio" ||
    !c.text.includes(serviceName) ||
    lines.filter((line) => line === "Extras").length !== 1
  )
    throw new Error("The visible service, flags or payment description need a fresh review");
  let financialHold:
    | {
        displayedService: string;
        discount: string;
        displayedTotal: string;
        displayedDue: string;
      }
    | undefined;
  if (holdAmount) {
    const discount = lines.indexOf("Descuento");
    const total = lines.indexOf("Total");
    const due = lines.indexOf("A pagar");
    const discountLabel = lines[discount + 1];
    const displayedTotal = lines[total + 1];
    const displayedDue = lines[due + 1];
    if (
      !lines.includes("Empleado elegido manualmente") ||
      discount <= header ||
      total !== discount + 2 ||
      due !== total + 2 ||
      !discountLabel?.startsWith("-") ||
      booksyCents(discountLabel.slice(1)) <= 0 ||
      booksyCents(price) !== 0 ||
      !displayedTotal ||
      booksyCents(displayedTotal) !== 0 ||
      !displayedDue ||
      booksyCents(displayedDue) !== 0
    )
      throw new Error("The visible discount and zero amounts need a fresh review");
    financialHold = {
      displayedService: price,
      discount: discountLabel,
      displayedTotal,
      displayedDue,
    };
  } else if (
    !lines.includes("Asignado por sistema") ||
    !lines.some((line) => line.startsWith("Tasa de cancelación"))
  )
    throw new Error("The visible service, flags or payment description need a fresh review");
  const services = model.base.services.filter((row) => normalize(row.name) === serviceName);
  const person = model.base.staff.find((row) => row.sourceId === c.columnResource);
  const client = model.base.clients.find((row) => row.sourceId === p.customerRef);
  const pools = model.resources.filter(
    (row) => typeof row.name === "string" && normalize(row.name) === fields.get("Recurso"),
  );
  const service = services[0];
  const resourceRef = pools[0]?.id;
  if (
    services.length !== 1 ||
    pools.length !== 1 ||
    typeof resourceRef !== "number" ||
    !service ||
    !person ||
    normalize(person.name) !== fields.get("Empleado") ||
    !model.base.assignments.some(
      (row) => row.staffRef === person.sourceId && row.serviceRef === service.sourceId,
    ) ||
    !z
      .object({ resources: z.array(z.number()) })
      .parse(service.raw)
      .resources.includes(resourceRef)
  )
    throw new Error(
      "Visible professional, service or resource does not uniquely match the source catalogue",
    );
  if (
    !lines.includes(normalize(p.name)) ||
    localPhone(p.phone).length !== 9 ||
    !lines.some((line) => localPhone(line) === localPhone(p.phone))
  )
    throw new Error("Visible appointment and customer profile details differ");
  const verifiedContact =
    client &&
    normalize(client.name) === normalize(p.name) &&
    client.phone &&
    localPhone(client.phone) === localPhone(p.phone)
      ? client
      : undefined;
  if (!verifiedContact && !holdContact)
    throw new Error(
      "Visible customer does not match the archived contact; resolve the identity before importing",
    );
  const provisional: BooksySourceReadModel["base"]["clients"][number] | undefined = verifiedContact
    ? undefined
    : {
        sourceId: `visible-booking-contact:${itemRef}`,
        name: `${normalize(p.name)} · identidad pendiente`,
        phone: null,
        email: null,
        notes: null,
        bookingAccess: "blocked",
        raw: {
          kind: "booksy-contact-hold",
          conflictingCustomerRef: p.customerRef,
          groupRef,
          evidenceSha256: evidence.sha256,
        },
      };
  if (provisional && model.base.clients.some((row) => row.sourceId === provisional.sourceId))
    throw new Error("A temporary contact already exists for this line");
  const contact = verifiedContact ?? provisional!;
  const internalNote = n.fields.find((f) => f.placeholder?.startsWith("Nota interna"));
  const businessMessage = n.fields.find((f) => f.placeholder === "Mensaje para el cliente");
  if (!internalNote || !businessMessage) throw new Error("Visible note fields are incomplete");
  const id = (kind: string, value: string) => sourceUuid(model.businessId, kind, value);
  const ownId = id("sourceAppointments", itemRef);
  const staffId = id("staff", person.sourceId);
  const serviceId = id("services", service.sourceId);
  const capturedAt = [c.capturedAt, d.capturedAt, a.capturedAt, p.capturedAt, n.capturedAt]
    .sort()
    .at(-1)!;
  const appointment = calendarAppointmentSchema.parse({
    id: ownId,
    staffId,
    clientId: id("clients", contact.sourceId),
    startsAt,
    endsAt,
    status: "booked",
    notes: null,
    version: 1,
    services: [
      {
        serviceId,
        name: serviceName,
        durationMinutes,
        bufferMinutes: 0,
        priceCents: booksyCents(price),
        ...(financialHold ? { sourceUnpriced: true } : {}),
        currency: "EUR",
      },
    ],
    clientName: contact.name,
    serviceNames: [serviceName],
    serviceColors: service.color ? { [serviceId]: service.color } : {},
    serviceBadges: [
      {
        servicePosition: 0,
        requested: false,
        paid: false,
        invoiced: false,
        billingSource: null,
        internalNote: Boolean(internalNote.value),
        customerComment: false,
      },
    ],
    resources: [{ name: fields.get("Recurso"), quantity: 1 }],
    sourceCopy: {
      system: "booksy",
      businessId: model.businessId,
      groupRef,
      itemRef,
      capturedAt,
      readOnly: true,
    },
    createdAt: capturedAt,
    updatedAt: capturedAt,
  });
  const context = appointmentContextSchema.parse({
    businessMessage: businessMessage.value || null,
    customerComment: null,
    rows: [
      {
        servicePosition: 0,
        requestedStaffId: null,
        internalNote: internalNote.value || null,
        customerComment: null,
        paid: null,
        invoiced: null,
        version: 1,
        source: "booksy",
        sourceRef: `${model.businessId}:${itemRef}:0`,
      },
    ],
  });
  return {
    ...model,
    base: {
      ...model.base,
      artifacts: [...model.base.artifacts, evidence],
      clients: provisional ? [...model.base.clients, provisional] : model.base.clients,
      unprojected: [
        ...model.base.unprojected,
        ...(provisional
          ? [
              {
                kind: "booksy_contact_identity_conflict",
                sourceId: provisional.sourceId,
                raw: provisional.raw,
              },
            ]
          : []),
        ...(financialHold
          ? [
              {
                kind: "booksy_visible_discount_requires_review",
                sourceId: itemRef,
                raw: { groupRef, evidenceSha256: evidence.sha256, ...financialHold },
              },
            ]
          : []),
      ],
    },
    appointments: [...model.appointments, appointment].sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt),
    ),
    groups: [
      ...model.groups,
      {
        sourceId: groupRef,
        ids: [ownId],
        raw: {
          kind: "booksy-reviewed-visible-booking",
          itemRef,
          resourceRef,
          evidenceSha256: evidence.sha256,
          contactPending: Boolean(provisional),
          ...(financialHold ? { financialHold } : {}),
        },
      },
    ],
    contexts: {
      ...model.contexts,
      [ownId]: { ...context, businessMessage: context.businessMessage ?? null },
    },
    summary: {
      ...model.summary,
      groups: model.summary.groups + 1,
      bookedServices: model.summary.bookedServices + 1,
      clients: model.summary.clients + Number(Boolean(provisional)),
    },
  } satisfies BooksySourceReadModel;
}

export function verifyReviewedVisibleBooking(
  model: BooksySourceReadModel,
  group: BooksySourceReadModel["groups"][number],
  parent: BooksySourceReadModel,
  envelope: z.infer<typeof visibleBookingEnvelope>,
  artifact: BooksySourceReadModel["base"]["artifacts"][number],
) {
  if (
    envelope.businessId !== model.businessId ||
    parent.businessId !== model.businessId ||
    fingerprint(parent) !== envelope.parentHash ||
    group.raw.evidenceSha256 !== artifact.sha256 ||
    group.raw.kind !== envelope.kind
  )
    throw new Error("Visible reservation evidence does not belong to this snapshot");
  const documents = envelope.originals.map((original) => {
    const bytes = Buffer.from(original.bytes, "base64");
    if (sha256(bytes) !== original.sha256)
      throw new Error("Visible reservation observation changed");
    return JSON.parse(bytes.toString("utf8"));
  });
  const rebuilt = appendVisibleBooking(
    parent,
    documents,
    artifact,
    group.raw.contactPending === true,
    Boolean(group.raw.financialHold),
  );
  const rebuiltGroup = rebuilt.groups.at(-1);
  const appointmentId = rebuiltGroup?.ids[0];
  if (!rebuiltGroup || !appointmentId || fingerprint(group) !== fingerprint(rebuiltGroup))
    throw new Error("Reviewed visible reservation differs from the rebuilt group");
  const line = model.appointments.find(({ id }) => id === appointmentId);
  const rebuiltLine = rebuilt.appointments.find(({ id }) => id === appointmentId);
  const context = model.contexts[appointmentId];
  if (
    !line?.sourceCopy ||
    !rebuiltLine ||
    !context ||
    fingerprint(line) !== fingerprint(rebuiltLine) ||
    fingerprint(context) !== fingerprint(rebuilt.contexts[appointmentId])
  )
    throw new Error("Reviewed visible reservation differs from the rebuilt line");
  return {
    itemRef: line.sourceCopy.itemRef,
    observedAt: line.sourceCopy.capturedAt,
    evidenceSha256: artifact.sha256,
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const holdContact = args.includes("--hold-contact");
    const holdAmount = args.includes("--hold-amount");
    const [snapshotName, ...files] = args.filter(
      (arg) => arg !== "--hold-contact" && arg !== "--hold-amount",
    );
    if (!snapshotName || files.length !== 5)
      throw new Error(
        "Expected snapshot and the card, drawer, assignment, customer and notes observations in that order",
      );
    const snapshot = await realpath(snapshotName);
    const root = dirname(snapshot);
    const info = await stat(root);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Expected operator-owned private archive");
    const parentHash = /^source-snapshot-([a-f0-9]{64})\.json$/.exec(basename(snapshot))?.[1];
    const model = JSON.parse(await readFile(snapshot, "utf8")) as BooksySourceReadModel;
    if (!parentHash || fingerprint(model) !== parentHash)
      throw new Error("Source snapshot hash differs");
    const originals = await Promise.all(
      files.map(async (file) => {
        const path = await realpath(file);
        if (
          dirname(path) !== join(root, "ui-reconciliation") ||
          ((await stat(path)).mode & 0o077) !== 0
        )
          throw new Error("Evidence must be private in the reconciliation directory");
        const bytes = await readFile(path);
        return { name: basename(path), sha256: sha256(bytes), bytes: bytes.toString("base64") };
      }),
    );
    const kind = "booksy-reviewed-visible-booking";
    const envelope = JSON.stringify(
      { kind, businessId: model.businessId, parentHash, originals },
      null,
      2,
    );
    const sha = sha256(envelope);
    const artifact = {
      path: `visible-booking-${sha}.json`,
      bytes: Buffer.byteLength(envelope),
      sha256: sha,
    };
    const next = appendVisibleBooking(
      model,
      originals.map((row) => JSON.parse(Buffer.from(row.bytes, "base64").toString("utf8"))),
      artifact,
      holdContact,
      holdAmount,
    );
    const hash = fingerprint(next);
    const nextFile = join(root, `source-snapshot-${hash}.json`);
    const bundleFile = join(root, `bundle-visible-${fingerprint(next.base)}.json`);
    const manifest = {
      version: 1,
      businessId: model.businessId,
      fromDate: model.fromDate,
      timezone: "Europe/Madrid",
      complete: false,
      artifacts: [{ ...artifact, kind }],
      limitations: [
        holdAmount
          ? "One independently verified visible reservation line. The displayed discount and zero total require amount review before collection. Full coverage remains unproven."
          : "One independently verified visible reservation line. Original payment shown as an uncollected cancellation fee is not a sale. Full coverage remains unproven.",
      ],
    } satisfies BooksyArchiveManifest;
    const manifestFile = join(root, `manifest-visible-${fingerprint(manifest)}.json`);
    await privateWriteVerified(join(root, artifact.path), envelope);
    await privateWriteVerified(nextFile, JSON.stringify(next, null, 2));
    await privateWriteVerified(bundleFile, JSON.stringify(next.base, null, 2));
    await privateWriteVerified(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(
      JSON.stringify({
        hash,
        nextFile,
        bundleFile,
        manifestFile,
        groups: next.summary.groups,
        lines: next.summary.bookedServices,
        unresolvedContact: next.summary.clients !== model.summary.clients,
        canCutOver: false,
      }),
    );
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Visible booking evidence has an unexpected shape"
        : error instanceof Error
          ? error.message
          : "Visible booking preparation failed",
    );
    process.exitCode = 1;
  }
}
