import type { AdminStaff } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { UserIcon } from "~/components/ui/icons";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { cn } from "~/lib/cn";
import { staffQuery } from "~/lib/queries";
import { preparePrivatePhoto } from "../clients/prepare-photo";

type PortraitChange =
  | { kind: "upload"; file: File; version: string | null }
  | { kind: "remove"; version: string }
  | { kind: "publish"; published: boolean; version: string };

export function StaffPortrait({ member, size }: { member: AdminStaff; size: 32 | 64 }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft text-accent-soft-fg",
        size === 32 ? "size-8" : "size-16",
      )}
    >
      {member.portraitVersion ? (
        <img
          alt=""
          src={`/api/admin/staff/${member.id}/portrait?v=${member.portraitVersion}`}
          width={size}
          height={size}
          loading={size === 32 ? "lazy" : "eager"}
          className="size-full object-cover"
        />
      ) : (
        <UserIcon width={size / 2} height={size / 2} />
      )}
    </span>
  );
}

export function StaffPortraitEditor({ member }: { member: AdminStaff }) {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<{ file: File; version: string | null } | null>(null);
  const [removeVersion, setRemoveVersion] = useState<string | null>(null);
  const version = member.portraitVersion ?? null;
  const save = useMutation({
    mutationFn: async (change: PortraitChange) => {
      if (change.kind === "publish") {
        return api().admin.staff.publishPortrait(member.id, {
          version: change.version,
          published: change.published,
        });
      }
      return api().admin.staff.savePortrait(member.id, {
        version: change.version,
        imageBase64: change.kind === "upload" ? await preparePrivatePhoto(change.file) : null,
      });
    },
    onSuccess: async (_result, change) => {
      if (change.kind === "upload") {
        form.current?.reset();
        setDraft(null);
      }
      if (change.kind === "remove") setRemoveVersion(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: adminStaffQuery.queryKey }),
        cache.invalidateQueries({ queryKey: staffQuery.queryKey }),
      ]);
      toast.success(t("staff.portrait.saved"));
    },
    onError: async (error, change) => {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setRemoveVersion(null);
        if (change.kind === "upload") {
          form.current?.reset();
          setDraft(null);
        }
        await cache.invalidateQueries({ queryKey: adminStaffQuery.queryKey });
        toast.error(t("staff.portrait.conflict"));
      } else {
        toast.error(t("staff.portrait.error"));
      }
    },
  });

  return (
    <>
      <form
        ref={form}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft && !save.isPending) save.mutate({ kind: "upload", ...draft });
        }}
      >
        <TextField
          className="max-w-sm"
          label={t("staff.portrait.file")}
          hint={t("staff.portrait.help")}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={save.isPending}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            setDraft(
              file ? { file, version: version ?? member.portraitAbsenceVersion ?? null } : null,
            );
          }}
        />
        <Button type="submit" disabled={!draft || save.isPending}>
          {t(save.isPending ? "admin.loading" : "staff.portrait.save")}
        </Button>
        {version !== null && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  kind: "publish",
                  version,
                  published: !member.portraitPublished,
                })
              }
            >
              {t(member.portraitPublished ? "staff.portrait.unpublish" : "staff.portrait.publish")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setRemoveVersion(version)}
            >
              {t("staff.portrait.remove")}
            </Button>
          </>
        )}
      </form>
      <ConfirmDialog
        open={removeVersion !== null}
        onOpenChange={() => setRemoveVersion(null)}
        onConfirm={() => {
          if (removeVersion !== null && !save.isPending) {
            save.mutate({ kind: "remove", version: removeVersion });
          }
        }}
        destructive
        pending={save.isPending}
        title={t("staff.portrait.remove")}
        description={t("staff.portrait.removeBody")}
        confirmLabel={t("staff.portrait.remove")}
        cancelLabel={t("admin.cancel")}
      />
    </>
  );
}
