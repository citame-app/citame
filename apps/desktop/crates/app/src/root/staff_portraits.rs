use super::*;
use sob_core::http::{PortraitDirectory, PortraitStaff, PortraitUpdate};
use sob_core::staff_portrait_image::prepare_photo;
use sob_core::store::{StaffPortraitDraft, Store};
use sob_core::sync::TransportError;
use uuid::Uuid;

struct Photos {
    directory: PortraitDirectory,
    selected: Option<String>,
    preview: Option<Arc<gpui::RenderImage>>,
    unavailable: bool,
}

impl Photos {
    fn current(&self) -> Option<&PortraitStaff> {
        let id = self.selected.as_deref()?;
        self.directory.staff.iter().find(|member| member.id == id)
    }

    fn editable(&self, staff_id: &str) -> Option<&PortraitStaff> {
        self.current()
            .filter(|member| self.directory.can_edit && member.id == staff_id)
    }

    fn reviewable(&self, staff_id: &str) -> Option<&PortraitStaff> {
        self.editable(staff_id).filter(|_| !self.unavailable)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DraftReview {
    Ready,
    Reload,
    Confirm,
    Saved,
}

struct Draft {
    id: Uuid,
    staff_id: String,
    version: Option<String>,
    jpeg: Vec<u8>,
    review: DraftReview,
    stored: bool,
}

impl Draft {
    fn new(member: &PortraitStaff, jpeg: Vec<u8>) -> Self {
        Self {
            id: Uuid::now_v7(),
            staff_id: member.id.clone(),
            version: member.upload_version().map(str::to_owned),
            jpeg,
            review: DraftReview::Ready,
            stored: false,
        }
    }

    fn recovered(saved: StaffPortraitDraft) -> Self {
        Self {
            id: saved.id,
            staff_id: saved.staff_id.to_string(),
            version: None,
            jpeg: saved.jpeg,
            review: DraftReview::Reload,
            stored: true,
        }
    }

    fn ready(&self, photos: &Photos) -> bool {
        self.review == DraftReview::Ready
            && photos
                .editable(&self.staff_id)
                .is_some_and(|member| member.upload_version() == self.version.as_deref())
    }

    fn update(&self, photos: &Photos) -> Option<PortraitUpdate> {
        self.ready(photos).then(|| PortraitUpdate::Upload {
            version: self.version.clone(),
            jpeg: self.jpeg.clone(),
        })
    }
}

pub(super) struct Desk {
    instance: Arc<()>,
    photos: Option<Photos>,
    busy: bool,
    picking: bool,
    notice: Option<Key>,
    confirming_removal: bool,
    confirming_discard: bool,
    draft: Option<Draft>,
    preview_scope: Option<Entity<Arc<gpui::RenderImage>>>,
    observed_revision: i64,
    refresh_pending: bool,
    retry_at: Option<Instant>,
}

impl Desk {
    fn waiting_to_retry(&self) -> bool {
        self.retry_at.is_some_and(|retry| Instant::now() < retry)
    }

    fn finish_picker(
        &mut self,
        mut draft: Draft,
        selection: Result<Option<Vec<u8>>, Key>,
        store: &Store,
    ) {
        self.busy = false;
        self.picking = false;
        match selection {
            Ok(Some(jpeg)) => {
                if self.refresh_pending || self.photos.is_none() {
                    draft.review = DraftReview::Reload;
                }
                draft.jpeg = jpeg;
                draft.stored = Uuid::parse_str(&draft.staff_id).is_ok_and(|staff_id| {
                    store
                        .reserve_staff_portrait_draft(draft.id, staff_id, &draft.jpeg)
                        .unwrap_or(false)
                });
                if !draft.stored {
                    self.notice = Some(Key::StaffPortraitDraftStorageFailed);
                }
                self.draft = Some(draft);
            }
            Ok(None) => {}
            Err(error) => self.notice = Some(error),
        }
    }

    pub(super) fn dismiss(&mut self) -> bool {
        if self.confirming_removal {
            self.confirming_removal = false;
        } else if self.draft.as_ref().is_none_or(|draft| draft.stored) {
            return !self.busy;
        } else if !self.busy {
            self.confirming_discard = !self.confirming_discard;
        }
        false
    }

    fn update_draft_after_request(
        &mut self,
        action: DraftAction,
        saved: bool,
        photos: Option<&Photos>,
        store: &Store,
    ) -> Option<Key> {
        if action == DraftAction::Save && saved {
            if let Some(draft) = &mut self.draft
                && draft.stored
                && store.clear_staff_portrait_draft(draft.id).is_err()
            {
                draft.review = DraftReview::Saved;
                return Some(Key::StaffPortraitDraftSavedCleanupFailed);
            }
            self.draft = None;
        } else if action != DraftAction::None
            && let Some(draft) = &mut self.draft
            && draft.review != DraftReview::Saved
        {
            if action == DraftAction::Review && photos.is_some_and(|photos| draft.ready(photos)) {
                return None;
            }
            draft.review =
                if photos.is_some_and(|photos| photos.reviewable(&draft.staff_id).is_some()) {
                    DraftReview::Confirm
                } else {
                    DraftReview::Reload
                };
        }
        None
    }
}

enum Action {
    Load,
    Change(PortraitUpdate),
    ReviewDraft,
    SaveDraft,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DraftAction {
    None,
    Review,
    Save,
}

impl Root {
    pub(super) fn open_staff_portraits(&mut self, cx: &mut Context<Self>) {
        let (draft, notice) = match self.svc.store.staff_portrait_draft() {
            Ok(saved) => (saved.map(Draft::recovered), None),
            Err(_) => (None, Some(Key::StaffPortraitDraftReadFailed)),
        };
        let action = if draft.is_some() {
            Action::ReviewDraft
        } else {
            Action::Load
        };
        self.overlay = Overlay::StaffPortraits(Box::new(Desk {
            instance: Arc::new(()),
            photos: None,
            busy: false,
            picking: false,
            notice,
            confirming_removal: false,
            confirming_discard: false,
            draft,
            preview_scope: None,
            observed_revision: 0,
            refresh_pending: false,
            retry_at: None,
        }));
        if notice.is_none() && self.status.connectivity != Connectivity::Offline {
            self.staff_portrait_request(None, action, cx);
        } else {
            cx.notify();
        }
    }

    pub(super) fn preserve_open_staff_portrait_draft(&mut self) -> bool {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return false;
        };
        if desk.draft.is_none() && !desk.picking {
            return false;
        }
        if !desk.picking {
            desk.instance = Arc::new(());
            desk.busy = false;
        }
        desk.photos = None;
        desk.preview_scope = None;
        desk.notice = Some(Key::StaffPortraitChangeFailed);
        desk.confirming_discard = false;
        desk.retry_at = None;
        desk.refresh_pending = true;
        if let Some(draft) = &mut desk.draft
            && draft.review != DraftReview::Saved
        {
            draft.review = DraftReview::Reload;
        }
        true
    }

    pub(super) fn refresh_staff_portraits(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        desk.refresh_pending |= reconnected;
        let revision_changed = self
            .svc
            .store
            .staff_directory_revision()
            .is_ok_and(|revision| revision != desk.observed_revision);
        if !desk.busy
            && !desk.confirming_removal
            && !desk.confirming_discard
            && !desk.waiting_to_retry()
            && (desk.refresh_pending || revision_changed || desk.retry_at.is_some())
        {
            let action = if desk.draft.is_some() {
                Action::ReviewDraft
            } else {
                Action::Load
            };
            self.staff_portrait_request(None, action, cx);
        }
    }

    fn staff_portrait_request(
        &mut self,
        selected: Option<String>,
        action: Action,
        cx: &mut Context<Self>,
    ) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy
            || desk.confirming_discard
            || desk.waiting_to_retry()
            || match &action {
                Action::Load => desk.draft.is_some() || desk.confirming_removal,
                Action::Change(_) => desk.draft.is_some(),
                Action::ReviewDraft | Action::SaveDraft => desk.draft.is_none(),
            }
        {
            return;
        }
        let offline = self.status.connectivity == Connectivity::Offline;
        let Some(transport) = self.svc.transport().filter(|_| !offline) else {
            desk.notice = Some(if desk.draft.is_some() {
                Key::StaffPortraitDraftOffline
            } else {
                Key::StaffPortraitOffline
            });
            cx.notify();
            return;
        };
        let (draft_action, update) = match action {
            Action::Load => (DraftAction::None, None),
            Action::Change(update) => (DraftAction::None, Some(update)),
            Action::ReviewDraft => (DraftAction::Review, None),
            Action::SaveDraft => {
                if let Some(draft) = &desk.draft
                    && draft.stored
                {
                    match self.svc.store.has_staff_portrait_draft(draft.id) {
                        Ok(true) => {}
                        Ok(false) => {
                            desk.notice = Some(Key::StaffPortraitDraftReplaced);
                            cx.notify();
                            return;
                        }
                        Err(_) => {
                            desk.notice = Some(Key::StaffPortraitDraftReadFailed);
                            cx.notify();
                            return;
                        }
                    }
                }
                let Some(update) = desk
                    .draft
                    .as_ref()
                    .zip(desk.photos.as_ref())
                    .and_then(|(draft, photos)| draft.update(photos))
                else {
                    return;
                };
                (DraftAction::Save, Some(update))
            }
        };
        let revision = self.svc.store.staff_directory_revision().unwrap_or(0);
        if update.is_some() && revision != desk.observed_revision {
            desk.refresh_pending = true;
            return;
        }
        let instance = desk.instance.clone();
        let session = self.svc.session.clone();
        let selected = if draft_action == DraftAction::None {
            selected.or_else(|| desk.photos.as_ref()?.selected.clone())
        } else {
            desk.draft.as_ref().map(|draft| draft.staff_id.clone())
        };
        let renderer = cx.svg_renderer();
        desk.observed_revision = revision;
        desk.refresh_pending = false;
        desk.retry_at = None;
        desk.busy = true;
        desk.notice = None;
        desk.confirming_removal = false;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let (photos, saved, notice, retry_after) =
                cx.background_executor()
                    .spawn(async move {
                        let change = update
                            .zip(selected.as_deref())
                            .map(|(update, id)| transport.set_staff_portrait(id, update));
                        let saved = change.as_ref().is_some_and(Result::is_ok);
                        let notice = change.as_ref().map(|result| {
                            if result.is_ok() {
                                Key::StaffPortraitSaved
                            } else {
                                Key::StaffPortraitChangeFailed
                            }
                        });
                        if let Some(Err(TransportError::RateLimited(delay))) = change {
                            return (
                                None,
                                false,
                                notice,
                                Some(delay.unwrap_or(Duration::from_secs(5))),
                            );
                        }
                        let directory = match transport.portrait_directory() {
                            Ok(directory) => directory,
                            Err(error) => {
                                let failed = if matches!(error, TransportError::Offline(_)) {
                                    Key::StaffPortraitOffline
                                } else {
                                    Key::StaffPortraitFailure
                                };
                                let retry_after = match error {
                                    TransportError::RateLimited(delay) => {
                                        Some(delay.unwrap_or(Duration::from_secs(5)))
                                    }
                                    TransportError::Offline(_) | TransportError::Server(_) => {
                                        Some(Duration::from_secs(5))
                                    }
                                    _ => None,
                                };
                                return (None, saved, notice.or(Some(failed)), retry_after);
                            }
                        };
                        let member = selected
                            .as_deref()
                            .and_then(|id| directory.staff.iter().find(|member| member.id == id))
                            .or_else(|| {
                                directory
                                    .staff
                                    .first()
                                    .filter(|_| draft_action == DraftAction::None)
                            });
                        let selected = member.map(|member| member.id.clone());
                        let preview = member.and_then(|member| {
                            member.portrait_version.as_ref().map(|version| {
                                transport.staff_portrait(&member.id, version).ok().and_then(
                                    |bytes| {
                                        gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                                            .to_image_data(renderer.clone())
                                            .ok()
                                    },
                                )
                            })
                        });
                        let unavailable = preview.as_ref().is_some_and(Option::is_none);
                        (
                            Some(Photos {
                                directory,
                                selected,
                                preview: preview.flatten(),
                                unavailable,
                            }),
                            saved,
                            notice,
                            None,
                        )
                    })
                    .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                desk.busy = false;
                let stale = root
                    .svc
                    .store
                    .staff_directory_revision()
                    .is_ok_and(|current| current != revision);
                let photos = photos.filter(|_| !stale);
                desk.refresh_pending |= stale;
                let local_notice = desk.update_draft_after_request(
                    draft_action,
                    saved,
                    photos.as_ref(),
                    &root.svc.store,
                );
                if stale || photos.is_some() || retry_after.is_none() {
                    desk.preview_scope = photos
                        .as_ref()
                        .and_then(|photos| photos.preview.clone())
                        .map(|image| {
                            cx.new(|cx| {
                                cx.on_release(|image: &mut Arc<gpui::RenderImage>, app| {
                                    app.drop_image(image.clone(), None);
                                })
                                .detach();
                                image
                            })
                        });
                    desk.photos = photos;
                }
                desk.notice = local_notice.or(notice);
                desk.retry_at = retry_after.and_then(|delay| Instant::now().checked_add(delay));
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_staff_portraits(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let content = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_lg()
                            .child(self.t(Key::StaffPortraits)),
                    )
                    .child(self.button(
                        "staff-photos-close",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            )
            .when_some(desk.notice, |view, notice| {
                view.child(div().text_sm().child(self.t(notice)))
            })
            .when(
                self.status.connectivity == Connectivity::Offline && desk.notice.is_none(),
                |view| {
                    view.child(div().text_sm().child(self.t(if desk.draft.is_some() {
                        Key::StaffPortraitDraftOffline
                    } else {
                        Key::StaffPortraitOffline
                    })))
                },
            )
            .when(desk.busy, |view| {
                view.child(div().text_sm().child(self.t(Key::StaffPortraitLoading)))
            })
            .when(
                !desk.busy
                    && !desk.waiting_to_retry()
                    && desk.draft.is_none()
                    && !desk.confirming_removal
                    && self.status.connectivity != Connectivity::Offline,
                |view| {
                    view.child(self.button(
                        "staff-photos-refresh",
                        self.t(Key::InboxRefresh),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.staff_portrait_request(None, Action::Load, cx)
                        }),
                    ))
                },
            )
            .when_some(desk.draft.as_ref(), |view, draft| {
                view.child(self.render_staff_photo_draft(desk, draft, cx))
            })
            .when_some(desk.photos.as_ref(), |view, photos| {
                view.when(photos.directory.staff.is_empty(), |view| {
                    view.child(div().text_sm().child(self.t(Key::StaffPortraitEmpty)))
                })
                .when(desk.draft.is_none(), |view| {
                    view.child(div().flex().flex_wrap().gap_2().children(
                        photos.directory.staff.iter().map(|member| {
                            let id = member.id.clone();
                            let kind = if photos.selected.as_deref() == Some(&member.id) {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            };
                            let name = if member.active {
                                member.display_name.clone()
                            } else {
                                format!(
                                    "{} · {}",
                                    member.display_name,
                                    self.t(Key::StaffPortraitInactive)
                                )
                            };
                            self.button(
                                SharedString::from(format!("staff-photo-select-{id}")),
                                name,
                                kind,
                                cx.listener(move |root, _, _, cx| {
                                    root.staff_portrait_request(Some(id.clone()), Action::Load, cx)
                                }),
                            )
                        }),
                    ))
                })
                .when_some(photos.current(), |view, member| {
                    let version = member.portrait_version.clone();
                    let status = match &version {
                        Some(_) if member.active && member.portrait_published => {
                            Key::StaffPortraitPublic
                        }
                        Some(_) => Key::StaffPortraitPrivate,
                        None => Key::StaffPortraitNone,
                    };
                    view.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_3()
                            .when_some(photos.preview.as_ref(), |row, preview| {
                                row.child(
                                    gpui::img(preview.clone())
                                        .size(px(88.))
                                        .rounded_md()
                                        .object_fit(gpui::ObjectFit::Cover),
                                )
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(member.display_name.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(theme::muted())
                                            .child(self.t(status)),
                                    )
                                    .when(photos.unavailable, |column| {
                                        column.child(
                                            div()
                                                .text_sm()
                                                .child(self.t(Key::StaffPortraitFailure)),
                                        )
                                    }),
                            ),
                    )
                    .when(!photos.directory.can_edit, |view| {
                        view.child(div().text_sm().child(self.t(Key::StaffPortraitReadOnly)))
                    })
                    .when(
                        photos.directory.can_edit && !desk.busy && desk.draft.is_none(),
                        |view| {
                            view.child(self.render_staff_photo_actions(
                                member,
                                desk.confirming_removal,
                                photos.preview.is_some(),
                                !desk.waiting_to_retry()
                                    && self.status.connectivity != Connectivity::Offline,
                                cx,
                            ))
                        },
                    )
                })
            });
        let width = (viewport.width - px(32.)).clamp(px(260.), px(640.));
        let height = (viewport.height - px(32.)).max(px(180.));
        self.modal_with_height(
            div().child(
                div()
                    .id("staff-photos-panel")
                    .overflow_y_scroll()
                    .max_h((height - px(40.)).max(px(140.)))
                    .child(content),
            ),
            width,
            height,
            Some(cx),
        )
    }

    fn choose_staff_photo(&mut self, staff_id: &str, cx: &mut Context<Self>) {
        let prompt = self.t(Key::StaffPortraitUpload);
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.draft.is_some() {
            return;
        }
        let Some(member) = desk
            .photos
            .as_ref()
            .and_then(|photos| photos.editable(staff_id))
        else {
            return;
        };
        let mut draft = Draft::new(member, Vec::new());
        if desk.retry_at.is_some() || self.status.connectivity == Connectivity::Offline {
            draft.review = DraftReview::Reload;
        }
        desk.busy = true;
        desk.picking = true;
        desk.notice = None;
        desk.confirming_removal = false;
        let instance = desk.instance.clone();
        let session = self.svc.session.clone();
        let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(prompt.into()),
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let selected = match picker.await {
                Ok(Ok(paths)) => match paths.and_then(|paths| paths.into_iter().next()) {
                    None => Ok(None),
                    Some(path) => {
                        cx.background_executor()
                            .spawn(async move {
                                prepare_photo(&path)
                                    .map(Some)
                                    .ok_or(Key::StaffPortraitInvalid)
                            })
                            .await
                    }
                },
                _ => Err(Key::StaffPortraitInvalid),
            };
            let _ = root.update(cx, |root, cx| {
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance)
                    || !Arc::ptr_eq(&root.svc.session, &session)
                {
                    return;
                }
                desk.finish_picker(draft, selected, &root.svc.store);
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_staff_photo_review(&mut self, cx: &mut Context<Self>) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        let Some(draft) = desk.draft.as_mut().filter(|draft| {
            !desk.busy && !desk.confirming_discard && draft.review == DraftReview::Confirm
        }) else {
            return;
        };
        let Some(member) = desk
            .photos
            .as_ref()
            .and_then(|photos| photos.reviewable(&draft.staff_id))
        else {
            return;
        };
        draft.version = member.upload_version().map(str::to_owned);
        draft.review = DraftReview::Ready;
        desk.notice = None;
        cx.notify();
    }

    fn discard_staff_photo_draft(&mut self, cx: &mut Context<Self>) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if let Some(draft) = &desk.draft
            && draft.stored
            && self.svc.store.clear_staff_portrait_draft(draft.id).is_err()
        {
            desk.notice = Some(Key::StaffPortraitDraftCleanupFailed);
            cx.notify();
            return;
        }
        if desk.confirming_discard {
            self.overlay = Overlay::None;
        } else {
            desk.draft = None;
            desk.notice = None;
            desk.refresh_pending = true;
        }
        cx.notify();
    }

    fn render_staff_photo_draft(
        &self,
        desk: &Desk,
        draft: &Draft,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity != Connectivity::Offline;
        let ready = desk
            .photos
            .as_ref()
            .is_some_and(|photos| draft.ready(photos));
        let label = desk
            .photos
            .as_ref()
            .and_then(Photos::current)
            .filter(|member| member.id == draft.staff_id)
            .map_or_else(
                || self.t(Key::StaffPortraitDraftGeneric).to_owned(),
                |member| {
                    self.t(Key::StaffPortraitDraft)
                        .replace("{staff}", &member.display_name)
                },
            );
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(label)
            .when(desk.confirming_discard, |view| {
                view.child(self.t(Key::StaffPortraitDiscardConfirm))
            })
            .when(!desk.busy, |view| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(
                            !desk.confirming_discard
                                && online
                                && !desk.waiting_to_retry()
                                && draft.review == DraftReview::Reload,
                            |row| {
                                row.child(self.button(
                                    "staff-photo-reload",
                                    self.t(Key::StaffPortraitReviewCloud),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        root.staff_portrait_request(None, Action::ReviewDraft, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            !desk.confirming_discard && draft.review == DraftReview::Confirm,
                            |row| {
                                row.child(self.button(
                                    "staff-photo-review",
                                    self.t(Key::StaffPortraitUseReviewed),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        root.confirm_staff_photo_review(cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            !desk.confirming_discard && ready && online && !desk.waiting_to_retry(),
                            |row| {
                                row.child(
                                    self.button(
                                        "staff-photo-save",
                                        self.t(Key::StaffPortraitSave),
                                        Kind::Primary,
                                        cx.listener(|root, _, _, cx| {
                                            root.staff_portrait_request(None, Action::SaveDraft, cx)
                                        }),
                                    )
                                    .debug_selector(|| "staff-photo-save".to_owned()),
                                )
                            },
                        )
                        .child(self.button(
                            "staff-photo-discard",
                            self.t(Key::StaffPortraitDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| root.discard_staff_photo_draft(cx)),
                        ))
                        .when(desk.confirming_discard, |row| {
                            row.child(self.button(
                                "staff-photo-keep-draft",
                                self.t(Key::Cancel),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                                        desk.confirming_discard = false;
                                        cx.notify();
                                    }
                                }),
                            ))
                        }),
                )
            })
    }

    fn render_staff_photo_actions(
        &self,
        member: &PortraitStaff,
        confirming: bool,
        previewed: bool,
        can_send: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let version = member.portrait_version.clone();
        let staff_id = member.id.clone();
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .child(self.button(
                "staff-photo-upload",
                self.t(Key::StaffPortraitUpload),
                Kind::Primary,
                cx.listener(move |root, _, _, cx| root.choose_staff_photo(&staff_id, cx)),
            ))
            .when_some(version.filter(|_| can_send), |row, version| {
                let publication = version.clone();
                let published = !member.portrait_published;
                row.when(previewed || !published, |row| {
                    row.child(self.button(
                        "staff-photo-publish",
                        self.t(if published {
                            Key::StaffPortraitPublish
                        } else {
                            Key::StaffPortraitUnpublish
                        }),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.staff_portrait_request(
                                None,
                                Action::Change(PortraitUpdate::Publish {
                                    version: publication.clone(),
                                    published,
                                }),
                                cx,
                            )
                        }),
                    ))
                })
                .child(
                    self.button(
                        "staff-photo-remove",
                        self.t(if confirming {
                            Key::StaffPortraitRemoveConfirm
                        } else {
                            Key::StaffPortraitRemove
                        }),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if confirming {
                                root.staff_portrait_request(
                                    None,
                                    Action::Change(PortraitUpdate::Remove {
                                        version: version.clone(),
                                    }),
                                    cx,
                                );
                            } else if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                                desk.confirming_removal = true;
                                cx.notify();
                            }
                        }),
                    )
                    .debug_selector(|| "staff-photo-remove".to_owned()),
                )
                .when(confirming, |row| {
                    row.child(self.button(
                        "staff-photo-keep",
                        self.t(Key::Cancel),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                                desk.confirming_removal = false;
                                cx.notify();
                            }
                        }),
                    ))
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn reopening_the_profile_recovers_a_photo_without_reusing_its_old_review(
        cx: &mut TestAppContext,
    ) {
        let (dir, config) = super::super::tests::desk();
        let file = dir.path().join("portrait.png");
        // A synthetic one-pixel PNG for the real preparation path.
        std::fs::write(
            &file,
            [
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
                1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 48,
                241, 10, 4, 0, 1, 133, 0, 208, 122, 167, 104, 97, 0, 0, 0, 0, 73, 69, 78, 68, 174,
                66, 96, 130,
            ],
        )
        .unwrap();
        let bytes = prepare_photo(&file).unwrap();
        let staff = Uuid::now_v7().to_string();
        let first = cx.add_window(|window, cx| Root::new(config.clone(), window, cx));
        let draft_id = first
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.status.connectivity = Connectivity::Offline;
                root.open_staff_portraits(cx);
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    panic!("missing portrait desk");
                };
                let mut photos = photos_without_preview();
                photos.directory.staff[0].id = staff.clone();
                photos.selected = Some(staff.clone());
                let draft = Draft::new(photos.current().unwrap(), vec![]);
                let id = draft.id;
                desk.photos = Some(photos);
                desk.finish_picker(draft, Ok(Some(bytes.clone())), &root.svc.store);
                assert!(desk.draft.as_ref().unwrap().stored);
                root.dismiss_overlay(cx);
                assert!(matches!(root.overlay, Overlay::None));
                id
            })
            .unwrap();
        let second = cx.add_window(|window, cx| Root::new(config, window, cx));
        second
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.status.connectivity = Connectivity::Offline;
                root.open_staff_portraits(cx);
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    panic!("missing recovered portrait desk");
                };
                let draft = desk.draft.as_ref().unwrap();
                assert_eq!(draft.id, draft_id);
                assert_eq!(draft.staff_id, staff);
                assert_eq!(draft.jpeg, bytes);
                assert_eq!(draft.review, DraftReview::Reload);
                assert!(draft.version.is_none() && desk.photos.is_none());
                root.discard_staff_photo_draft(cx);
                assert!(root.svc.store.staff_portrait_draft().unwrap().is_none());
            })
            .unwrap();
    }

    #[gpui::test]
    async fn saving_without_a_transport_keeps_the_selected_file(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            root.open_staff_portraits(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            desk.photos = Some(photos_without_preview());
            desk.draft = Some(Draft::new(
                desk.photos.as_ref().unwrap().current().unwrap(),
                vec![255, 216, 255, 1],
            ));
            cx.notify();
        });
        cx.run_until_parked();
        let button = cx.debug_bounds("staff-photo-save").unwrap();
        cx.simulate_click(button.center(), Default::default());
        root.update(cx, |root, _| {
            let Overlay::StaffPortraits(desk) = &root.overlay else {
                panic!("missing portrait desk");
            };
            assert_eq!(desk.draft.as_ref().unwrap().jpeg, vec![255, 216, 255, 1]);
        });
        root.update(cx, |root, cx| {
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::StaffPortraits(desk) if desk.confirming_discard));
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::StaffPortraits(desk) if !desk.confirming_discard && desk.draft.is_some()));
        });
    }

    #[gpui::test]
    async fn a_failed_upload_requires_review_for_the_same_team_member(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_staff_portraits(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            let mut latest = photos_without_preview();
            let image = vec![255, 216, 255, 1];
            desk.draft = Some(Draft::new(latest.current().unwrap(), image.clone()));
            latest.directory.staff[0].portrait_version = Some("cloud-version".into());
            assert!(
                desk.update_draft_after_request(
                    DraftAction::Save,
                    false,
                    Some(&latest),
                    &root.svc.store
                )
                .is_none()
            );
            assert_eq!(desk.draft.as_ref().unwrap().review, DraftReview::Reload);

            latest.unavailable = false;
            latest.directory.can_edit = false;
            assert!(
                desk.update_draft_after_request(
                    DraftAction::Review,
                    false,
                    Some(&latest),
                    &root.svc.store
                )
                .is_none()
            );
            assert_eq!(desk.draft.as_ref().unwrap().review, DraftReview::Reload);
            latest.directory.can_edit = true;
            latest.directory.staff[0].id = "other".into();
            latest.selected = Some("other".into());
            assert!(
                desk.update_draft_after_request(
                    DraftAction::Review,
                    false,
                    Some(&latest),
                    &root.svc.store
                )
                .is_none()
            );
            assert_eq!(desk.draft.as_ref().unwrap().review, DraftReview::Reload);

            latest.directory.staff[0].id = "member".into();
            latest.selected = Some("member".into());
            assert!(
                desk.update_draft_after_request(
                    DraftAction::Review,
                    false,
                    Some(&latest),
                    &root.svc.store
                )
                .is_none()
            );
            assert_eq!(desk.draft.as_ref().unwrap().review, DraftReview::Confirm);
            assert!(desk.draft.as_ref().unwrap().update(&latest).is_none());
            desk.photos = Some(latest);
            root.confirm_staff_photo_review(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            assert!(matches!(
                desk.draft.as_ref().unwrap().update(desk.photos.as_ref().unwrap()),
                Some(PortraitUpdate::Upload { version, jpeg })
                    if version.as_deref() == Some("cloud-version") && jpeg == image
            ));
            assert!(
                desk.update_draft_after_request(DraftAction::Save, true, None, &root.svc.store)
                    .is_none()
            );
            assert!(desk.draft.is_none());
        });
    }

    fn photos_without_preview() -> Photos {
        Photos {
            directory: PortraitDirectory {
                can_edit: true,
                staff: vec![PortraitStaff {
                    id: "member".into(),
                    display_name: "Team member".into(),
                    active: true,
                    portrait_version: Some("version".into()),
                    portrait_absence_version: None,
                    portrait_published: true,
                }],
            },
            selected: Some("member".into()),
            preview: None,
            unavailable: true,
        }
    }

    #[gpui::test]
    async fn live_staff_refresh_preserves_the_draft_and_waits_for_removal_confirmation(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            assert!(root.svc.transport().is_none());
            root.open_staff_portraits(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            desk.notice = None;
            let photos = photos_without_preview();
            desk.draft = Some(Draft::new(photos.current().unwrap(), vec![]));
            root.refresh_staff_portraits(true, cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            assert_eq!(
                desk.draft.as_ref().unwrap().version.as_deref(),
                Some("version")
            );
            assert_eq!(desk.notice, Some(Key::StaffPortraitDraftOffline));
            desk.draft = None;
            desk.notice = None;
            desk.confirming_removal = true;
            root.refresh_staff_portraits(true, cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            assert!(desk.confirming_removal);
            assert!(desk.notice.is_none());
            desk.confirming_removal = false;
            root.refresh_staff_portraits(false, cx);
            assert!(matches!(&root.overlay, Overlay::StaffPortraits(desk)
                if desk.notice == Some(Key::StaffPortraitOffline)));
        });
    }

    #[gpui::test]
    async fn a_scope_change_keeps_the_pending_picker_but_drops_the_stale_directory(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.svc.store.set_meta("calendar_scope", "all").unwrap();
            root.reload(cx);
            root.open_staff_portraits(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            desk.photos = Some(photos_without_preview());
            let draft = Draft::new(desk.photos.as_ref().unwrap().current().unwrap(), vec![]);
            let instance = desk.instance.clone();
            desk.picking = true;
            desk.busy = true;

            root.svc.store.set_meta("calendar_scope", "own").unwrap();
            root.reload(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("the pending picker should survive");
            };
            assert!(Arc::ptr_eq(&instance, &desk.instance));
            assert!(desk.photos.is_none());
            assert!(desk.busy);
            desk.finish_picker(draft, Ok(Some(vec![255, 216, 255, 3])), &root.svc.store);
            let draft = desk.draft.as_ref().unwrap();
            assert_eq!(draft.staff_id, "member");
            assert_eq!(draft.review, DraftReview::Reload);
            assert_eq!(draft.jpeg, vec![255, 216, 255, 3]);
            desk.notice = None;
            desk.retry_at = Some(Instant::now() + Duration::from_secs(30));
            root.staff_portrait_request(None, Action::ReviewDraft, cx);
            assert!(matches!(&root.overlay, Overlay::StaffPortraits(desk)
                if desk.notice.is_none() && !desk.busy && desk.waiting_to_retry()));
        });
    }

    #[gpui::test]
    async fn staff_portrait_removal_stays_available_without_preview_but_requires_confirmation(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(620.), px(440.)));
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Online;
            root.overlay = Overlay::StaffPortraits(Box::new(Desk {
                instance: Arc::new(()),
                photos: Some(photos_without_preview()),
                busy: false,
                picking: false,
                notice: None,
                confirming_removal: false,
                confirming_discard: false,
                draft: None,
                preview_scope: None,
                observed_revision: 0,
                refresh_pending: false,
                retry_at: None,
            }));
            cx.notify();
        });
        cx.run_until_parked();
        let remove = cx.debug_bounds("staff-photo-remove").unwrap();
        cx.simulate_click(remove.center(), Default::default());
        root.update(cx, |root, cx| {
            assert!(
                matches!(&root.overlay, Overlay::StaffPortraits(desk) if desk.confirming_removal)
            );
            root.dismiss_overlay(cx);
            assert!(
                matches!(&root.overlay, Overlay::StaffPortraits(desk) if !desk.confirming_removal)
            );
            root.status.connectivity = Connectivity::Offline;
            cx.notify();
        });
        cx.run_until_parked();
        cx.simulate_click(remove.center(), Default::default());
        root.update(cx, |root, _| {
            assert!(
                !matches!(&root.overlay, Overlay::StaffPortraits(desk) if desk.confirming_removal)
            );
        });
    }
}
