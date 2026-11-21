use super::*;
use sob_core::http::{
    PORTFOLIO_LIVE_TOPIC, PortfolioEdit, PortfolioList, PortfolioPhoto, PortfolioPublication,
    PortfolioStatus, QueuedPortfolioUpload,
};
use sob_core::staff_portrait_image::prepare_photo;
use uuid::Uuid;

struct Draft {
    caption: Entity<TextField>,
    alt: Entity<TextField>,
    source: Source,
    needs_review: bool,
    upload_packet: Option<PortfolioEdit>,
    conflict: Option<String>,
    generation: String,
}

impl Draft {
    fn input(&self, service: Uuid, cx: &App) -> PortfolioEdit {
        self.upload_packet.clone().unwrap_or_else(|| PortfolioEdit {
            caption: self.caption.read(cx).text().to_owned(),
            alt: self.alt.read(cx).text().to_owned(),
            service_id: Some(service),
        })
    }
}

fn scoped_preview(
    image: Arc<gpui::RenderImage>,
    cx: &mut Context<Root>,
) -> Entity<Arc<gpui::RenderImage>> {
    cx.new(|cx| {
        cx.on_release(|image: &mut Arc<gpui::RenderImage>, app| {
            app.drop_image(image.clone(), None);
        })
        .detach();
        image
    })
}

enum Source {
    Upload {
        key: Uuid,
        jpeg: Arc<Vec<u8>>,
        preview: Entity<Arc<gpui::RenderImage>>,
    },
    Existing(PortfolioPhoto),
}

#[derive(Clone, Copy)]
enum Confirm {
    Publish(Uuid, u32),
    Remove(Uuid, u32),
    Discard,
    DiscardConflict,
}

enum Action {
    Load,
    Upload(Uuid, PortfolioEdit, Arc<Vec<u8>>),
    Edit(PortfolioPhoto, PortfolioEdit),
    Publication(PortfolioPhoto, PortfolioPublication),
    Remove(PortfolioPhoto),
}

impl Action {
    fn perform(
        &self,
        transport: &sob_core::http::HttpTransport,
        generation: &str,
    ) -> Result<Option<Uuid>, TransportError> {
        match self {
            Self::Load => Ok(None),
            Self::Upload(key, input, jpeg) => transport
                .upload_portfolio_photo(generation, *key, input, jpeg)
                .map(|photo| Some(photo.id)),
            Self::Edit(photo, input) => transport
                .edit_portfolio_photo(generation, photo, input)
                .map(|photo| Some(photo.id)),
            Self::Publication(photo, action) => transport
                .set_portfolio_publication(generation, photo, *action)
                .map(|photo| Some(photo.id)),
            Self::Remove(photo) => transport
                .remove_portfolio_photo(generation, photo)
                .map(|()| None),
        }
    }
}

pub(super) struct Panel {
    instance: Arc<()>,
    service: Uuid,
    name: String,
    allow_upload: bool,
    photos: Option<PortfolioList>,
    selected: Option<Uuid>,
    preview: Option<Entity<Arc<gpui::RenderImage>>>,
    observed: Option<(i64, i64)>,
    retry_at: Option<Instant>,
    busy: bool,
    draft: Option<Draft>,
    confirm: Option<Confirm>,
    notice: Option<Key>,
    pending: Vec<String>,
    pending_revision: Option<i64>,
}

impl Panel {
    fn selection(&self) -> Option<&PortfolioPhoto> {
        self.photos
            .as_ref()?
            .photos
            .iter()
            .find(|row| Some(row.id) == self.selected && row.service_id == Some(self.service))
    }

    pub(super) fn invalidate(&mut self) {
        self.instance = Arc::new(());
        self.photos = None;
        self.preview = None;
        self.busy = false;
        self.confirm = None;
        self.observed = None;
        self.retry_at = None;
        self.pending.clear();
        self.pending_revision = None;
        if let Some(draft) = &mut self.draft {
            draft.needs_review = true;
        }
    }

    pub(super) fn dismiss(&mut self) -> bool {
        if self.busy {
            return false;
        }
        if self
            .draft
            .as_ref()
            .is_some_and(|draft| draft.conflict.is_none())
        {
            self.confirm = Some(Confirm::Discard);
            return false;
        }
        true
    }
}

impl Root {
    fn catalog_portfolio(&mut self) -> Option<&mut Panel> {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return None;
        };
        desk.portfolio.as_deref_mut()
    }

    pub(super) fn open_catalog_portfolio(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = desk
            .editor
            .as_ref()
            .filter(|editor| editor.creation.is_none())
        else {
            return;
        };
        let Ok(service) = editor.base.id.parse() else {
            return;
        };
        let name = editor.base.details.name.clone();
        let active = editor.base.details.active;
        self.install_portfolio_panel(service, name, active);
        self.request_catalog_portfolio(Action::Load, None, cx);
    }

    fn install_portfolio_panel(&mut self, service: Uuid, name: String, allow_upload: bool) {
        let pending = self
            .svc
            .store
            .pending_portfolio_captions(service)
            .unwrap_or_default();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        desk.portfolio = Some(Box::new(Panel {
            instance: Arc::new(()),
            service,
            name,
            allow_upload,
            photos: None,
            selected: None,
            preview: None,
            observed: None,
            retry_at: None,
            busy: false,
            draft: None,
            confirm: None,
            notice: None,
            pending,
            pending_revision: self.data_version,
        }));
    }

    fn portfolio_revision(&self) -> (i64, i64) {
        (
            self.svc
                .store
                .live_view_revision(PORTFOLIO_LIVE_TOPIC)
                .unwrap_or_default(),
            self.svc
                .store
                .staff_directory_revision()
                .unwrap_or_default(),
        )
    }

    pub(super) fn refresh_catalog_portfolio(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let observed = self.portfolio_revision();
        if !self.can_create_catalogue_item() {
            if let Overlay::ServiceCatalog(desk) = &mut self.overlay
                && desk.portfolio.take().is_some()
            {
                cx.notify();
            }
            return;
        }
        self.refresh_pending_portfolio(cx);
        if self.catalog_portfolio().is_some_and(|panel| {
            !panel.busy
                && (reconnected
                    || panel
                        .retry_at
                        .map_or(panel.observed != Some(observed), |retry| {
                            Instant::now() >= retry
                        }))
        }) && self.svc.status().connectivity == Connectivity::Online
        {
            self.request_catalog_portfolio(Action::Load, None, cx);
        }
    }

    fn request_catalog_portfolio(
        &mut self,
        action: Action,
        selection: Option<Uuid>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let observed = self.portfolio_revision();
        let transport = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online);
        let session = self.svc.session.clone();
        let reviewed_generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        if panel.busy {
            return;
        }
        let Some(transport) = transport else {
            if !matches!(action, Action::Load) {
                panel.notice = Some(Key::CatalogPhotosOffline);
            }
            cx.notify();
            return;
        };
        let selection = selection.or(panel.selected);
        let service = panel.service;
        let instance = panel.instance.clone();
        let renderer = cx.svg_renderer();
        let writing = !matches!(action, Action::Load);
        let generation = panel.photos.as_ref().map(|list| list.generation.clone());
        if writing && (generation.is_none() || generation != reviewed_generation) {
            panel.notice = Some(Key::CatalogPhotosCurrent);
            cx.notify();
            return;
        }
        if let Action::Upload(_, upload, _) = &action
            && let Some(draft) = &mut panel.draft
        {
            draft.upload_packet = Some(upload.clone());
        }
        panel.busy = true;
        panel.notice = None;
        panel.observed = Some(observed);
        panel.retry_at = None;
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let (changed, result) = cx
                .background_executor()
                .spawn(async move {
                    let changed =
                        action.perform(&transport, generation.as_deref().unwrap_or_default());
                    let result = transport.portfolio().and_then(|list| {
                        let photos = list
                            .photos
                            .iter()
                            .filter(|row| row.service_id == Some(service));
                        let preferred = changed.as_ref().ok().and_then(|id| *id).or(selection);
                        let selected = preferred
                            .filter(|id| photos.clone().any(|row| row.id == *id))
                            .or_else(|| photos.clone().next().map(|row| row.id));
                        let preview = match selected.map(|id| transport.portfolio_photo(id)) {
                            Some(Ok(bytes)) => {
                                gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                                    .to_image_data(renderer)
                                    .ok()
                            }
                            Some(Err(
                                error @ (TransportError::Unauthorized
                                | TransportError::Forbidden(_)),
                            )) => return Err(error),
                            _ => None,
                        };
                        Ok((list, selected, preview))
                    });
                    (changed, result)
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) || !root.can_create_catalogue_item() {
                    return;
                }
                let Some(panel) = root
                    .catalog_portfolio()
                    .filter(|panel| Arc::ptr_eq(&panel.instance, &instance))
                else {
                    return;
                };
                panel.busy = false;
                if writing
                    && changed.as_ref().is_err_and(|error| {
                        matches!(
                            error,
                            TransportError::BadRequest(_)
                                | TransportError::ReplicaGenerationChanged
                        )
                    })
                    && let Some(draft) = &mut panel.draft
                {
                    draft.upload_packet = None;
                }
                let retry_after = match &result {
                    Err(TransportError::RateLimited(delay)) => {
                        Some(delay.unwrap_or(Duration::from_secs(5)))
                    }
                    Err(TransportError::Offline(_) | TransportError::Server(_)) => {
                        Some(Duration::from_secs(5))
                    }
                    _ => None,
                };
                panel.retry_at = retry_after.and_then(|delay| Instant::now().checked_add(delay));
                if writing && changed.is_ok() {
                    panel.draft = None;
                    panel.confirm = None;
                }
                let load_failed = result.is_err();
                if matches!(
                    changed,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                ) || matches!(
                    result,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                ) {
                    panel.photos = None;
                    panel.preview = None;
                    panel.draft = None;
                    panel.confirm = None;
                } else if let Ok((list, selected, preview)) = result {
                    panel.photos = Some(list);
                    panel.selected = selected;
                    panel.preview = preview.map(|image| scoped_preview(image, cx));
                }
                panel.notice = if changed.is_err() || load_failed {
                    Some(Key::CatalogPhotosFailure)
                } else if writing {
                    Some(Key::CatalogSaved)
                } else {
                    None
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn start_portfolio_draft(&mut self, source: Source, cx: &mut Context<Self>) {
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        let (caption, alt) = match &source {
            Source::Upload { .. } => ("", ""),
            Source::Existing(photo) => (photo.caption.as_str(), photo.alt.as_str()),
        };
        let field = |value: &str, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut field = TextField::new("", false, cx);
                field.set_text(value, cx);
                field
            })
        };
        let caption = field(caption, cx);
        let alt = field(alt, cx);
        for field in [&caption, &alt] {
            cx.observe(field, |_, _, cx| cx.notify()).detach();
        }
        panel.draft = Some(Draft {
            caption,
            alt,
            source,
            needs_review: false,
            upload_packet: None,
            conflict: None,
            generation,
        });
        panel.notice = None;
        cx.notify();
    }

    fn choose_portfolio_photo(&mut self, cx: &mut Context<Self>) {
        let prompt = self.t(Key::StaffPortraitUpload);
        let session = self.svc.session.clone();
        let Some(panel) = self
            .catalog_portfolio()
            .filter(|panel| !panel.busy && panel.allow_upload && panel.draft.is_none())
        else {
            return;
        };
        let instance = panel.instance.clone();
        panel.busy = true;
        cx.notify();
        let renderer = cx.svg_renderer();
        let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(prompt.into()),
        });
        cx.spawn(async move |handle, cx| {
            let image = match picker.await {
                Ok(Ok(Some(paths))) => {
                    let path = paths.into_iter().next();
                    cx.background_executor()
                        .spawn(async move {
                            path.map(|path| {
                                let jpeg = prepare_photo(&path).ok_or(Key::StaffPortraitInvalid)?;
                                let preview =
                                    gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, jpeg.clone())
                                        .to_image_data(renderer)
                                        .map_err(|_| Key::StaffPortraitInvalid)?;
                                Ok((jpeg, preview))
                            })
                            .transpose()
                        })
                        .await
                }
                Ok(Ok(None)) => Ok(None),
                _ => Err(Key::StaffPortraitInvalid),
            };
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) || !root.can_create_catalogue_item() {
                    return;
                }
                let Some(panel) = root
                    .catalog_portfolio()
                    .filter(|panel| Arc::ptr_eq(&panel.instance, &instance))
                else {
                    return;
                };
                panel.busy = false;
                match image {
                    Ok(Some((jpeg, preview))) => root.start_portfolio_draft(
                        Source::Upload {
                            key: Uuid::now_v7(),
                            jpeg: Arc::new(jpeg),
                            preview: scoped_preview(preview, cx),
                        },
                        cx,
                    ),
                    Ok(None) => {}
                    Err(error) => panel.notice = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_portfolio_draft(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        let Some(draft) = &panel.draft else { return };
        if draft.needs_review {
            return;
        }
        let generation = draft.generation.clone();
        let input = draft.input(panel.service, cx);
        let Ok(input) = input.normalized() else {
            panel.notice = Some(Key::CatalogPhotosInvalid);
            cx.notify();
            return;
        };
        let conflict = draft.conflict.clone();
        let action = match &draft.source {
            Source::Upload { key, jpeg, .. } => Action::Upload(*key, input, jpeg.clone()),
            Source::Existing(photo) if photo.caption != input.caption || photo.alt != input.alt => {
                Action::Edit(photo.clone(), input)
            }
            Source::Existing(_) => return,
        };
        if let Action::Upload(key, input, jpeg) = &action
            && self.svc.store.can_queue_portfolio_uploads()
        {
            let result = QueuedPortfolioUpload::new(*key, input, jpeg)
                .map_err(|error| CoreError::Invalid(error.to_string()))
                .and_then(|upload| {
                    self.svc
                        .store
                        .queue_portfolio_upload(&generation, &upload, conflict.as_deref())
                });
            if let Some(panel) = self.catalog_portfolio() {
                panel.notice = Some(if result.is_ok() {
                    panel.draft = None;
                    panel.pending_revision = None;
                    Key::CatalogPhotosQueued
                } else {
                    Key::CatalogPhotosFailure
                });
            }
            if result.is_ok() {
                self.edited(cx);
                self.refresh_pending_portfolio(cx);
            }
            cx.notify();
            return;
        }
        if conflict.is_some()
            || self
                .svc
                .store
                .verified_reviewed_generation()
                .as_deref()
                .ok()
                != Some(&generation)
        {
            return;
        }
        self.request_catalog_portfolio(action, None, cx);
    }

    fn refresh_pending_portfolio(&mut self, cx: &mut Context<Self>) {
        let revision = self.data_version;
        if let Some(service) = self
            .catalog_portfolio()
            .filter(|panel| panel.pending_revision.is_none() || panel.pending_revision != revision)
            .map(|panel| panel.service)
        {
            let pending = self
                .svc
                .store
                .pending_portfolio_captions(service)
                .unwrap_or_default();
            if let Some(panel) = self.catalog_portfolio() {
                panel.pending = pending;
                panel.pending_revision = revision;
            }
            cx.notify();
        }
    }

    pub(in crate::root) fn open_portfolio_upload_conflict(
        &mut self,
        id: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(upload) = self
            .svc
            .store
            .conflicted_portfolio_upload(id)
            .ok()
            .flatten()
        else {
            return;
        };
        let target = self
            .svc
            .store
            .catalogue_template(&upload.service_id.to_string())
            .ok()
            .flatten();
        let title = target.as_ref().map_or_else(
            || self.t(Key::CatalogPhotosMissingService).to_owned(),
            |row| row.name.clone(),
        );
        self.open_service_catalog(cx);
        self.install_portfolio_panel(upload.service_id, title, false);
        self.request_catalog_portfolio(Action::Load, None, cx);
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        let instance = panel.instance.clone();
        let session = self.svc.session.clone();
        let id = id.to_owned();
        let renderer = cx.svg_renderer();
        cx.spawn(async move |handle, cx| {
            let image = cx
                .background_executor()
                .spawn(async move {
                    let jpeg = upload.image().ok()?;
                    let preview = gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, jpeg.clone())
                        .to_image_data(renderer)
                        .ok()?;
                    Some((upload, jpeg, preview))
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.svc.store.cached_catalogue_access()
                    || !root.catalog_portfolio().is_some_and(|panel| {
                        Arc::ptr_eq(&panel.instance, &instance) && panel.draft.is_none()
                    })
                {
                    return;
                }
                if let Some((upload, jpeg, preview)) = image {
                    root.start_portfolio_draft(
                        Source::Upload {
                            key: upload.idempotency_key,
                            jpeg: Arc::new(jpeg),
                            preview: scoped_preview(preview, cx),
                        },
                        cx,
                    );
                    if let Some(draft) = root
                        .catalog_portfolio()
                        .and_then(|panel| panel.draft.as_mut())
                    {
                        draft.upload_packet = Some(PortfolioEdit {
                            caption: upload.caption,
                            alt: upload.alt,
                            service_id: Some(upload.service_id),
                        });
                        draft.conflict = Some(id);
                    }
                    cx.notify();
                } else if let Some(panel) = root.catalog_portfolio() {
                    panel.notice = Some(Key::CatalogPhotosPreviewUnavailable);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn export_portfolio_conflict(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.cached_catalogue_access() {
            return;
        }
        let session = self.svc.session.clone();
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        let Some(draft) = panel
            .draft
            .as_ref()
            .filter(|draft| draft.conflict.is_some())
        else {
            return;
        };
        let Source::Upload { jpeg, .. } = &draft.source else {
            return;
        };
        let jpeg = jpeg.clone();
        let instance = panel.instance.clone();
        let home = std::env::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
        let picker = cx.prompt_for_new_path(&home, Some("foto-servicio.jpg"));
        cx.spawn(async move |handle, cx| {
            let Ok(Ok(Some(path))) = picker.await else {
                return;
            };
            let allowed = handle
                .update(cx, |root, _| {
                    Arc::ptr_eq(&root.svc.session, &session)
                        && root.svc.store.cached_catalogue_access()
                        && root
                            .catalog_portfolio()
                            .is_some_and(|panel| Arc::ptr_eq(&panel.instance, &instance))
                })
                .unwrap_or(false);
            if !allowed {
                return;
            }
            let result = cx
                .background_executor()
                .spawn(async move {
                    use std::io::Write;
                    sob_core::csv_file::save(&path, |file| file.write_all(&jpeg))
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if let Some(panel) = root
                    .catalog_portfolio()
                    .filter(|panel| Arc::ptr_eq(&panel.instance, &instance))
                {
                    panel.notice = Some(if result.is_ok() {
                        Key::CatalogPhotosCopySaved
                    } else {
                        Key::ReportExportFailed
                    });
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn render_catalog_portfolio(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.svc.status().connectivity == Connectivity::Online;
        let can_queue = self.svc.store.can_queue_portfolio_uploads();
        let target_active = self
            .svc
            .store
            .catalogue_template(&panel.service.to_string())
            .ok()
            .flatten()
            .is_some_and(|row| row.active);
        let body = div()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::CatalogPhotos)),
                    )
                    .child(self.button(
                        "portfolio-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_service_catalog(cx)),
                    )),
            )
            .child(panel.name.clone())
            .when(panel.busy, |body| {
                body.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when(!online, |body| {
                body.child(self.t(if can_queue {
                    Key::CatalogPhotosOfflineQueue
                } else {
                    Key::CatalogPhotosOffline
                }))
            })
            .when_some(panel.notice, |body, notice| body.child(self.t(notice)));
        if let Some(confirm) = panel.confirm {
            return body
                .child(self.t(match confirm {
                    Confirm::Publish(..) => Key::CatalogPhotosPublishConfirm,
                    Confirm::Remove(..) => Key::StaffPortraitRemoveConfirm,
                    Confirm::Discard => Key::SalonConfirmDiscard,
                    Confirm::DiscardConflict => Key::CatalogPhotosDiscardConfirm,
                }))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "portfolio-cancel",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Some(panel) = root.catalog_portfolio() {
                                    panel.confirm = None;
                                }
                                cx.notify();
                            }),
                        ))
                        .when(
                            !panel.busy
                                && (online
                                    || matches!(
                                        confirm,
                                        Confirm::Discard | Confirm::DiscardConflict
                                    )),
                            |actions| {
                                actions.child(self.button(
                                    "portfolio-confirm",
                                    self.t(match confirm {
                                        Confirm::Publish(..) => Key::StaffPortraitPublish,
                                        Confirm::Remove(..) => Key::StaffPortraitRemove,
                                        Confirm::Discard | Confirm::DiscardConflict => {
                                            Key::SalonDiscard
                                        }
                                    }),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.confirm_portfolio_action(confirm, cx);
                                    }),
                                ))
                            },
                        ),
                );
        }
        if let Some(draft) = &panel.draft {
            let reviewed = match &draft.source {
                Source::Existing(baseline) => panel
                    .selection()
                    .filter(|current| current.id == baseline.id),
                Source::Upload { .. } => None,
            };
            let stale = draft.needs_review
                || matches!(&draft.source, Source::Existing(baseline) if reviewed.is_none_or(|current| current.version != baseline.version));
            let frozen = panel.busy || draft.upload_packet.is_some();
            let input = draft.input(panel.service, cx);
            let changed = input.normalized().is_ok_and(|input| {
                !matches!(&draft.source, Source::Existing(photo)
                    if photo.caption == input.caption && photo.alt == input.alt)
            });
            let preview = match &draft.source {
                Source::Upload { preview, .. } => Some(preview),
                Source::Existing(_) => panel.preview.as_ref(),
            };
            return body
                .when_some(preview, |body, preview| {
                    body.child(
                        gpui::img(preview.read(cx).clone())
                            .max_h(px(175.))
                            .object_fit(gpui::ObjectFit::Contain),
                    )
                })
                .child(self.label(Key::CatalogPhotosCaption))
                .when(frozen, |body| body.child(input.caption.clone()))
                .when(!frozen, |body| body.child(draft.caption.clone()))
                .child(self.label(Key::CatalogPhotosAlt))
                .when(frozen, |body| body.child(input.alt.clone()))
                .when(!frozen, |body| body.child(draft.alt.clone()))
                .when(
                    reviewed.is_some_and(|photo| photo.status == PortfolioStatus::Published),
                    |body| body.child(self.t(Key::CatalogPhotosEditPublic)),
                )
                .when(draft.conflict.is_some(), |body| {
                    body.child(self.t(if target_active {
                        Key::CatalogPhotosReviewUpload
                    } else {
                        Key::CatalogPhotosMissingService
                    }))
                    .child(self.button(
                        "portfolio-export-conflict",
                        self.t(Key::CatalogPhotosSaveCopy),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.export_portfolio_conflict(cx)),
                    ))
                    .child(self.button(
                        "portfolio-discard-conflict",
                        self.t(Key::SalonDiscard),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| {
                            if let Some(panel) = root.catalog_portfolio() {
                                panel.confirm = Some(Confirm::DiscardConflict);
                            }
                            cx.notify();
                        }),
                    ))
                })
                .when(
                    stale && target_active && matches!(draft.source, Source::Upload { .. }),
                    |body| {
                        body.child(self.button(
                            "portfolio-review-upload",
                            self.t(Key::CatalogPhotosCurrent),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                let Ok(generation) = root.svc.store.verified_reviewed_generation()
                                else {
                                    return;
                                };
                                if let Some(draft) = root
                                    .catalog_portfolio()
                                    .and_then(|panel| panel.draft.as_mut())
                                {
                                    draft.generation = generation;
                                    draft.needs_review = false;
                                }
                                cx.notify();
                            }),
                        ))
                    },
                )
                .when(stale, |body| {
                    body.child(self.t(Key::CatalogPhotosCurrent)).when_some(
                        reviewed,
                        |body, current| {
                            let current = current.clone();
                            body.child(current.caption.clone())
                                .child(current.alt.clone())
                                .child(self.button(
                                    "portfolio-review",
                                    self.t(Key::CatalogPhotosUseVersion),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        let Ok(generation) =
                                            root.svc.store.verified_reviewed_generation()
                                        else {
                                            return;
                                        };
                                        if let Some(draft) = root
                                            .catalog_portfolio()
                                            .and_then(|panel| panel.draft.as_mut())
                                        {
                                            draft.source = Source::Existing(current.clone());
                                            draft.generation = generation;
                                            draft.needs_review = false;
                                        }
                                        cx.notify();
                                    }),
                                ))
                        },
                    )
                })
                .when(
                    !panel.busy
                        && !stale
                        && changed
                        && if matches!(draft.source, Source::Upload { .. }) {
                            target_active && (can_queue || (online && draft.conflict.is_none()))
                        } else {
                            online
                        },
                    |body| {
                        body.child(self.button(
                            "portfolio-save",
                            self.t(Key::StaffPortraitSave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_portfolio_draft(cx)),
                        ))
                    },
                );
        }
        self.render_portfolio_photos(body, panel, online, cx)
    }

    fn confirm_portfolio_action(&mut self, confirm: Confirm, cx: &mut Context<Self>) {
        if matches!(confirm, Confirm::DiscardConflict) {
            let id = self
                .catalog_portfolio()
                .and_then(|panel| panel.draft.as_ref()?.conflict.clone());
            if let Some(id) = id
                && self
                    .svc
                    .store
                    .conflicted_portfolio_upload(&id)
                    .ok()
                    .flatten()
                    .is_some()
                && self.svc.store.resolve_conflict(&id, "discarded").is_ok()
            {
                self.overlay = Overlay::Conflicts {
                    editing: None,
                    error: None,
                };
                self.edited(cx);
            }
            return;
        }
        if matches!(confirm, Confirm::Discard) {
            if let Overlay::ServiceCatalog(desk) = &mut self.overlay {
                desk.portfolio = None;
                cx.notify();
            }
            return;
        }
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        let (id, version) = match confirm {
            Confirm::Publish(id, version) | Confirm::Remove(id, version) => (id, version),
            Confirm::Discard | Confirm::DiscardConflict => return,
        };
        let Some(photo) = panel
            .selection()
            .filter(|photo| photo.id == id && photo.version == version)
            .cloned()
        else {
            panel.confirm = None;
            panel.notice = Some(Key::CatalogPhotosFailure);
            cx.notify();
            return;
        };
        let action = match confirm {
            Confirm::Publish(..) => {
                Action::Publication(photo, PortfolioPublication::ConfirmedPublish)
            }
            Confirm::Remove(..) => Action::Remove(photo),
            Confirm::Discard | Confirm::DiscardConflict => return,
        };
        self.request_catalog_portfolio(action, None, cx);
    }

    fn render_portfolio_photos(
        &self,
        body: gpui::Div,
        panel: &Panel,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let available = online && !panel.busy;
        let photos = panel
            .photos
            .as_ref()
            .map_or(&[][..], |list| list.photos.as_slice());
        let selected = panel.selection();
        body.child(
            div()
                .flex()
                .gap_2()
                .flex_wrap()
                .when(available, |actions| {
                    actions.child(self.button(
                        "portfolio-reload",
                        self.t(Key::CatalogReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.request_catalog_portfolio(Action::Load, None, cx)
                        }),
                    ))
                })
                .when(
                    !panel.busy
                        && panel.allow_upload
                        && panel
                            .photos
                            .as_ref()
                            .is_none_or(|list| list.photos.len() < list.limit),
                    |actions| {
                        actions.child(self.button(
                            "portfolio-pick",
                            self.t(Key::StaffPortraitUpload),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.choose_portfolio_photo(cx)),
                        ))
                    },
                ),
        )
        .when(!panel.pending.is_empty(), |body| {
            body.child(
                div()
                    .text_sm()
                    .child(self.t(Key::CatalogPhotosQueued))
                    .children(
                        panel
                            .pending
                            .iter()
                            .cloned()
                            .map(|caption| div().child(caption)),
                    ),
            )
        })
        .when(
            panel.photos.is_some() && selected.is_none() && panel.pending.is_empty(),
            |body| body.child(self.t(Key::CatalogPhotosEmpty)),
        )
        .child(
            div()
                .id("portfolio-photo-list")
                .min_h_0()
                .max_h(px(165.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    photos
                        .iter()
                        .filter(|row| row.service_id == Some(panel.service))
                        .map(|photo| {
                            let id = photo.id;
                            let kind = if Some(id) == panel.selected {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            };
                            self.button(
                                SharedString::from(format!("portfolio-{id}")),
                                photo.caption.clone(),
                                kind,
                                cx.listener(move |root, _, _, cx| {
                                    root.request_catalog_portfolio(Action::Load, Some(id), cx)
                                }),
                            )
                        }),
                ),
        )
        .when_some(selected, |body, photo| {
            let id = photo.id;
            let version = photo.version;
            let edit = photo.clone();
            let unpublish = photo.clone();
            let public = photo.status == PortfolioStatus::Published;
            body.when_some(panel.preview.clone(), |body, preview| {
                body.child(
                    gpui::img(preview.read(cx).clone())
                        .max_h(px(210.))
                        .object_fit(gpui::ObjectFit::Contain),
                )
            })
            .when(panel.preview.is_none(), |body| {
                body.child(self.t(Key::CatalogPhotosPreviewUnavailable))
            })
            .child(self.t(if public {
                Key::StaffPortraitPublic
            } else {
                Key::CatalogPhotosPrivate
            }))
            .child(photo.alt.clone())
            .when(available, |body| {
                body.child(
                    div()
                        .flex()
                        .gap_2()
                        .flex_wrap()
                        .child(self.button(
                            "portfolio-edit",
                            self.t(Key::FormEdit),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.start_portfolio_draft(Source::Existing(edit.clone()), cx)
                            }),
                        ))
                        .when(public || panel.preview.is_some(), |actions| {
                            actions.child(self.button(
                                "portfolio-publish",
                                self.t(if public {
                                    Key::StaffPortraitUnpublish
                                } else {
                                    Key::StaffPortraitPublish
                                }),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    if public {
                                        root.request_catalog_portfolio(
                                            Action::Publication(
                                                unpublish.clone(),
                                                PortfolioPublication::Unpublish,
                                            ),
                                            None,
                                            cx,
                                        );
                                    } else if let Some(panel) = root.catalog_portfolio() {
                                        panel.confirm = Some(Confirm::Publish(id, version));
                                        cx.notify();
                                    }
                                }),
                            ))
                        })
                        .child(self.button(
                            "portfolio-remove",
                            self.t(Key::StaffPortraitRemove),
                            Kind::Danger,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(panel) = root.catalog_portfolio() {
                                    panel.confirm = Some(Confirm::Remove(id, version));
                                    cx.notify();
                                }
                            }),
                        )),
                )
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_rejected_upload_can_be_opened_after_its_service_disappears(cx: &mut TestAppContext) {
        let (_directory, window) = crate::root::tests::open(cx);
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../web/public/icon-512.png");
        let jpeg = prepare_photo(&source).unwrap();
        let service = Uuid::now_v7();
        let upload = QueuedPortfolioUpload::new(
            Uuid::now_v7(),
            &PortfolioEdit {
                caption: "Saved treatment".into(),
                alt: "Fixture image".into(),
                service_id: Some(service),
            },
            &jpeg,
        )
        .unwrap();
        let id = window
            .update(cx, |root, _, cx| {
                let generation = root.svc.store.verified_reviewed_generation().unwrap();
                root.svc
                    .store
                    .remember_catalogue_access(&generation)
                    .unwrap();
                let entry = root
                    .svc
                    .store
                    .enqueue(
                        sob_core::http::PORTFOLIO_UPLOAD,
                        &upload.idempotency_key.to_string(),
                        serde_json::to_value(&upload).unwrap(),
                    )
                    .unwrap();
                let id = entry.mutation_id.clone();
                root.svc
                    .store
                    .apply_push_results(
                        &[entry],
                        &[sob_core::model::MutationResult::Rejected {
                            mutation_id: id.clone(),
                            reason: "not_found".into(),
                            message: "Service was removed".into(),
                            replayed: false,
                        }],
                    )
                    .unwrap();
                root.open_portfolio_upload_conflict(&id, cx);
                id
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |root, _, cx| {
                let panel = root.catalog_portfolio().unwrap();
                assert_eq!(panel.service, service);
                assert!(!panel.allow_upload);
                let draft = panel.draft.as_ref().unwrap();
                assert_eq!(draft.input(service, cx).caption, upload.caption);
                assert_eq!(draft.conflict.as_deref(), Some(id.as_str()));
                root.close_service_catalog(cx);
                assert!(
                    root.svc
                        .store
                        .conflicted_portfolio_upload(&id)
                        .unwrap()
                        .is_some()
                );
            })
            .unwrap();
    }

    #[gpui::test]
    async fn restoring_a_replica_retains_the_photo_draft_for_explicit_review(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let service = Uuid::now_v7();
                root.svc.store.apply_page(&[RawChange {
                seq: 1000, entity: "service".into(), id: service.to_string(), op: "upsert".into(),
                data: Some(serde_json::json!({
                    "id": service, "version": 1, "name": "Fixture treatment", "durationMinutes": 30,
                    "bufferMinutes": 0, "priceCents": 2000, "sortOrder": 1, "currency": "EUR",
                    "onlineBooking": true, "active": true, "updatedAt": "2026-03-01T10:00:00Z",
                })),
            }], 1000).unwrap();
                root.open_service_catalog(cx);
                root.select_catalog_service(&service.to_string(), cx);
                root.open_catalog_portfolio(cx);
                let photo = PortfolioPhoto {
                    id: Uuid::now_v7(),
                    service_id: Some(service),
                    service_name: Some("Fixture treatment".into()),
                    caption: "First caption".into(),
                    alt: "Alternative text".into(),
                    status: PortfolioStatus::Draft,
                    version: 1,
                };
                let panel = root.catalog_portfolio().unwrap();
                panel.photos = Some(PortfolioList {
                    photos: vec![photo.clone()],
                    limit: 200,
                    generation: "fixture".into(),
                });
                panel.selected = Some(photo.id);
                root.start_portfolio_draft(Source::Existing(photo), cx);
                root.catalog_portfolio()
                    .unwrap()
                    .draft
                    .as_ref()
                    .unwrap()
                    .caption
                    .update(cx, |field, cx| field.set_text("My new caption", cx));
                assert!(root.preserve_open_catalogue());
                let panel = root.catalog_portfolio().unwrap();
                assert!(panel.photos.is_none());
                let draft = panel.draft.as_ref().unwrap();
                assert!(draft.needs_review);
                assert_eq!(draft.caption.read(cx).text(), "My new caption");
                root.close_service_catalog(cx);
                assert!(matches!(
                    root.catalog_portfolio().unwrap().confirm,
                    Some(Confirm::Discard)
                ));
            })
            .unwrap();
    }
}
