import { auditLog, type Database } from "@sob/db";

/** A database handle or a transaction: the recorder only needs `insert`. */
export type AuditExecutor = Pick<Database, "insert">;

export interface AuditEntry {
  actorUserId: string | null;
  /** Dotted verb, for example `appointment.create`. */
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|credential|hash/i;

/**
 * Removes anything that looks like a credential, at any depth. A defensive net so a careless
 * caller cannot persist passwords or tokens in the audit trail; callers should still pass only
 * the facts worth keeping (ids, changed fields).
 */
export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !SECRET_KEY.test(key))
          .map(([key, v]) => [key, clean(v)]),
      );
    }
    return value;
  };
  return clean(metadata) as Record<string, unknown>;
}

export async function recordAudit(db: AuditExecutor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    metadata: redactMetadata(entry.metadata ?? {}),
  });
}
