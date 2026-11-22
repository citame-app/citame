import { PROFILE_MEDIA_GALLERY_LIMIT, type ProfileMediaWrite } from "@sob/contracts";
import { type Database, salonProfileMedia, salonSettings } from "@sob/db";
import { and, asc, eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { normalizeClientPhoto } from "../clients/photo-image";
import { getSalonSettings, toPublicBusinessProfile } from "./service";

const metadata = {
  id: salonProfileMedia.id,
  version: salonProfileMedia.version,
  kind: salonProfileMedia.kind,
  alt: salonProfileMedia.alt,
  width: salonProfileMedia.width,
  height: salonProfileMedia.height,
};
const byCreation = [asc(salonProfileMedia.createdAt), asc(salonProfileMedia.id)] as const;

function mediaRows(db: Pick<Database, "select">) {
  return db
    .select({ ...metadata, published: salonProfileMedia.published })
    .from(salonProfileMedia)
    .orderBy(...byCreation);
}

export function reviewPublicProfile(db: Database) {
  return db.transaction(async (tx) => {
    const snapshot = toPublicBusinessProfile(await getSalonSettings(tx, "share"));
    const images = snapshot.profile
      ? await tx
          .select(metadata)
          .from(salonProfileMedia)
          .where(eq(salonProfileMedia.published, true))
          .orderBy(...byCreation)
      : undefined;
    return { ...snapshot, images };
  });
}

export function reviewProfileMedia(db: Database, generation: string) {
  return db.transaction(async (tx) => {
    const settings = await getSalonSettings(tx, "share");
    return { generation, revision: settings.updatedAt.toISOString(), images: await mediaRows(tx) };
  });
}

export async function readProfileImage(
  db: Database,
  id: string,
  version: string,
  isPublic: boolean,
) {
  const read = (executor: Pick<Database, "select">) =>
    executor
      .select({ image: salonProfileMedia.image })
      .from(salonProfileMedia)
      .where(
        and(
          eq(salonProfileMedia.id, id),
          eq(salonProfileMedia.version, version),
          isPublic ? eq(salonProfileMedia.published, true) : undefined,
        ),
      );
  const [row] = await (isPublic
    ? db.transaction(async (tx) => {
        if (!toPublicBusinessProfile(await getSalonSettings(tx, "share")).profile) return [];
        return read(tx);
      })
    : read(db));
  if (!row) throw new DomainError("not_found", "Profile image not found");
  return new Response(new Uint8Array(row.image), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function saveProfileMedia(
  db: Database,
  input: ProfileMediaWrite,
  principal: Principal,
  generation: string,
) {
  requireRole(principal, "owner");
  if (input.generation !== generation)
    throw new DomainError(
      "version_conflict",
      "The salon was restored. Refresh before saving images.",
    );
  const { action } = input;
  const photo = action.mode === "upload" ? await normalizeClientPhoto(action.imageBase64) : null;
  return db.transaction(async (tx) => {
    const settings = await getSalonSettings(tx, "update");
    const actor = await loadPrincipal(tx, principal.userId);
    if (!actor) throw new DomainError("forbidden", "The account is unavailable");
    requireRole(actor, "owner");
    if (Date.parse(input.expectedRevision) !== settings.updatedAt.getTime())
      throw new DomainError(
        "version_conflict",
        "The images or profile changed. Refresh before saving.",
      );
    const images = await mediaRows(tx);
    const targetId = action.mode === "upload" ? action.replaceId : action.id;
    const target = images.find((row) => row.id === targetId);
    if (targetId && !target) throw new DomainError("not_found", "Profile image not found");
    const id = target?.id ?? crypto.randomUUID();
    const version = crypto.randomUUID();
    if (action.mode === "upload" && photo) {
      if (target && target.kind !== action.kind)
        throw new DomainError("validation_error", "The image type cannot change");
      if (!target) {
        const count = images.filter(({ kind }) => kind === action.kind).length;
        if (count >= (action.kind === "gallery" ? PROFILE_MEDIA_GALLERY_LIMIT : 1))
          throw new DomainError("validation_error", "No more images fit in this section");
      }
      const { image, width, height } = photo;
      const values = { alt: action.alt, image, width, height, published: false, version };
      if (target)
        await tx.update(salonProfileMedia).set(values).where(eq(salonProfileMedia.id, id));
      else await tx.insert(salonProfileMedia).values({ id, kind: action.kind, ...values });
    } else if (action.mode === "publication") {
      if (target?.published === action.published)
        return { generation, revision: settings.updatedAt.toISOString(), images };
      await tx
        .update(salonProfileMedia)
        .set({ published: action.published, version })
        .where(eq(salonProfileMedia.id, id));
    } else {
      await tx.delete(salonProfileMedia).where(eq(salonProfileMedia.id, id));
    }
    const updatedAt = new Date(Math.max(Date.now(), settings.updatedAt.getTime() + 1));
    await tx.update(salonSettings).set({ updatedAt }).where(eq(salonSettings.id, 1));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: `settings.profile_image_${action.mode}`,
      entity: "salon_profile_media",
      entityId: id,
    });
    return { generation, revision: updatedAt.toISOString(), images: await mediaRows(tx) };
  });
}
