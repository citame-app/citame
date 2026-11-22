import {
  PROFILE_MEDIA_GALLERY_LIMIT,
  type ProfileMediaAction,
  type ProfileMediaKind,
  type ProfileMediaSnapshot,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { preparePrivatePhoto } from "../clients/prepare-photo";
import { UnsavedGuard } from "../unsaved-guard";

const key = ["admin", "settings", "profile-images"] as const;
const roles = ["logo", "cover", "gallery"] as const;
type Reviewed = Pick<ProfileMediaSnapshot, "revision" | "generation">;
type Draft = {
  kind: ProfileMediaKind;
  replaceId?: string;
  base: Reviewed;
  file: File | null;
  alt: string;
};
type Write =
  | { base: Reviewed; action: Exclude<ProfileMediaAction, { mode: "upload" }> }
  | { draft: Draft & { file: File } };

export function ProfileMediaEditor() {
  const { t } = useI18n();
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const query = useQuery({ queryKey: key, queryFn: () => api().admin.settings.profileImages() });
  const data = query.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const focusFile = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);
  const [removal, setRemoval] = useState<{ id: string; base: Reviewed } | null>(null);
  const save = useMutation({
    mutationFn: async (input: Write) => {
      if ("draft" in input) {
        const draft = input.draft;
        return api().admin.settings.saveProfileImage({
          generation: draft.base.generation,
          expectedRevision: draft.base.revision,
          action: {
            mode: "upload",
            kind: draft.kind,
            replaceId: draft.replaceId,
            alt: draft.alt,
            imageBase64: await preparePrivatePhoto(draft.file),
          },
        });
      }
      return api().admin.settings.saveProfileImage({
        generation: input.base.generation,
        expectedRevision: input.base.revision,
        action: input.action,
      });
    },
    onSuccess: async (snapshot, input) => {
      cache.setQueryData(key, snapshot);
      if ("draft" in input) setDraft(null);
      setRemoval(null);
      toast.success(t("settings.saved"));
      await cache.invalidateQueries({ queryKey: ["admin", "settings"] });
      void router.invalidate();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setRemoval(null);
        await query.refetch();
      } else {
        toast.error(t("settings.media.error"));
      }
    },
  });

  if (!data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Skeleton className="h-56" />
    );

  const stale =
    draft && (draft.base.generation !== data.generation || draft.base.revision !== data.revision);
  const conflict = save.error instanceof ApiError && save.error.code === "version_conflict";
  const waiting = save.isPending || !online;
  const replaceExists =
    !draft?.replaceId || data.images.some((image) => image.id === draft.replaceId);
  const canAdd =
    draft &&
    data.images.filter(({ kind }) => kind === draft.kind).length <
      (draft.kind === "gallery" ? PROFILE_MEDIA_GALLERY_LIMIT : 1);
  return (
    <section className="max-w-2xl space-y-4" aria-labelledby="profile-images-heading">
      <h2 id="profile-images-heading" className="text-heading">
        {t("settings.media.title")}
      </h2>
      <p className="text-sm text-muted">{t("settings.media.help")}</p>
      {(stale || conflict) && (
        <p role="alert" className="text-sm text-danger-fg">
          {t("settings.media.conflict")}
        </p>
      )}
      {draft && (
        <form
          aria-labelledby="profile-image-draft-heading"
          className="space-y-4 rounded-xl border border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!stale && !conflict && !waiting && replaceExists && draft.file && draft.alt.trim())
              save.mutate({ draft: { ...draft, file: draft.file, alt: draft.alt.trim() } });
          }}
        >
          <UnsavedGuard dirty={!!draft.file || !!draft.alt.trim()} preserveOnSearchChange />
          <h3 id="profile-image-draft-heading" className="font-medium">
            {t(`settings.media.${draft.kind}`)}
          </h3>
          <TextField
            ref={focusFile}
            required
            type="file"
            accept="image/jpeg,image/png,image/webp"
            label={t("settings.media.file")}
            hint={t("settings.media.fileHelp")}
            disabled={save.isPending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              setDraft({ ...draft, file });
            }}
          />
          <TextField
            required
            label={t("settings.media.alt")}
            value={draft.alt}
            maxLength={160}
            disabled={save.isPending}
            onChange={(event) => setDraft({ ...draft, alt: event.currentTarget.value })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                waiting || !!stale || conflict || !replaceExists || !draft.file || !draft.alt.trim()
              }
            >
              {t("settings.media.save")}
            </Button>
            {!replaceExists && <p role="status">{t("settings.media.missing")}</p>}
            {!stale && !conflict && !replaceExists && canAdd && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft({ ...draft, replaceId: undefined });
                }}
              >
                {t("settings.media.keepNew")}
              </Button>
            )}
            {(stale || conflict) && (
              <Button
                type="button"
                variant="secondary"
                disabled={waiting || query.isFetching}
                onClick={async () => {
                  try {
                    const { data: latest } = await query.refetch({ throwOnError: true });
                    if (latest) {
                      save.reset();
                      setDraft((current) => (current ? { ...current, base: latest } : null));
                    }
                  } catch {
                    toast.error(t("settings.media.error"));
                  }
                }}
              >
                {t("settings.media.review")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                save.reset();
                setDraft(null);
              }}
            >
              {t("admin.cancel")}
            </Button>
          </div>
        </form>
      )}
      {roles.map((kind) => {
        const images = data.images.filter((image) => image.kind === kind);
        return (
          <section
            key={kind}
            className="space-y-3 rounded-xl border border-line p-4"
            aria-labelledby={`profile-images-${kind}`}
          >
            <h3 id={`profile-images-${kind}`} className="font-medium">
              {t(`settings.media.${kind}`)}
            </h3>
            {images.map((image) => (
              <article
                key={image.id}
                aria-label={image.alt}
                className="grid gap-2 border-b border-line pb-3 sm:grid-cols-[5rem_1fr]"
              >
                <img
                  src={`/api/admin/settings/profile/images/${image.id}/${image.version}`}
                  width={image.width}
                  height={image.height}
                  loading="lazy"
                  alt={image.alt}
                  className="size-20 rounded-md bg-sunken object-contain"
                />
                <div className="min-w-0 space-y-2">
                  <p className="break-words text-sm">{image.alt}</p>
                  <p className="text-sm text-muted">
                    {t(image.published ? "settings.media.public" : "settings.media.draft")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={waiting || !!draft}
                      onClick={() => {
                        save.reset();
                        setDraft({
                          kind,
                          replaceId: image.id,
                          file: null,
                          alt: image.alt,
                          base: data,
                        });
                      }}
                    >
                      {t("settings.media.replace")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={waiting || !!draft}
                      onClick={() =>
                        save.mutate({
                          base: data,
                          action: {
                            mode: "publication",
                            id: image.id,
                            published: !image.published,
                          },
                        })
                      }
                    >
                      {t(image.published ? "settings.media.withdraw" : "settings.media.publish")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={waiting || !!draft}
                      onClick={() => setRemoval({ id: image.id, base: data })}
                    >
                      {t("settings.media.remove")}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
            {images.length < (kind === "gallery" ? PROFILE_MEDIA_GALLERY_LIMIT : 1) && (
              <Button
                variant="secondary"
                disabled={waiting || !!draft}
                onClick={() => {
                  save.reset();
                  setDraft({ kind, base: data, file: null, alt: "" });
                }}
              >
                {t("settings.media.add")}
              </Button>
            )}
          </section>
        );
      })}
      <ConfirmDialog
        open={removal !== null}
        onOpenChange={() => setRemoval(null)}
        pending={save.isPending}
        destructive
        title={t("settings.media.remove")}
        description={t("settings.media.removeBody")}
        confirmLabel={t("settings.media.remove")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => {
          if (removal && !waiting)
            save.mutate({
              base: removal.base,
              action: { mode: "remove", id: removal.id },
            });
        }}
      />
    </section>
  );
}
