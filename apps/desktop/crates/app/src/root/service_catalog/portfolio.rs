use super::*;
use sob_core::http::{
    PORTFOLIO_LIVE_TOPIC, PortfolioEdit, PortfolioList, PortfolioPhoto, PortfolioPublication,
    PortfolioStatus,
};
use sob_core::staff_portrait_image::prepare_photo;
use uuid::Uuid;

struct Draft {
    caption: Entity<TextField>,
    alt: Entity<TextField>,
    source: Source,
    needs_review: bool,
}

enum Source {
    Upload { key: Uuid, jpeg: Arc<Vec<u8>> },
    Existing(PortfolioPhoto),
}

#[derive(Clone, Copy)]
enum Confirm {
    Publish(Uuid, u32),
    Remove(Uuid, u32),
    Discard,
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
    ) -> Result<Option<Uuid>, TransportError> {
        match self {
            Self::Load => Ok(None),
            Self::Upload(key, input, jpeg) => transport
                .upload_portfolio_photo(*key, input, jpeg)
                .map(|photo| Some(photo.id)),
            Self::Edit(photo, input) => transport
                .edit_portfolio_photo(photo, input)
                .map(|photo| Some(photo.id)),
            Self::Publication(photo, action) => transport
                .set_portfolio_publication(photo, *action)
                .map(|photo| Some(photo.id)),
            Self::Remove(photo) => transport.remove_portfolio_photo(photo).map(|()| None),
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
    busy: bool,
    draft: Option<Draft>,
    confirm: Option<Confirm>,
    notice: Option<Key>,
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
        if let Some(draft) = &mut self.draft {
            draft.needs_review = matches!(draft.source, Source::Existing(_));
        }
    }

    pub(super) fn dismiss(&mut self) -> bool {
        if self.busy {
            return false;
        }
        if self.draft.is_some() {
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
        desk.portfolio = Some(Box::new(Panel {
            instance: Arc::new(()),
            service,
            name: editor.base.details.name.clone(),
            allow_upload: editor.base.details.active,
            photos: None,
            selected: None,
            preview: None,
            observed: None,
            busy: false,
            draft: None,
            confirm: None,
            notice: None,
        }));
        self.request_catalog_portfolio(Action::Load, None, cx);
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
        if self
            .catalog_portfolio()
            .is_some_and(|panel| !panel.busy && (reconnected || panel.observed != Some(observed)))
            && self.svc.status().connectivity == Connectivity::Online
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
        let Some(panel) = self.catalog_portfolio() else {
            return;
        };
        if panel.busy {
            return;
        }
        let Some(transport) = transport else {
            panel.notice = Some(Key::CatalogPhotosOffline);
            cx.notify();
            return;
        };
        let selection = selection.or(panel.selected);
        let service = panel.service;
        let instance = panel.instance.clone();
        let renderer = cx.svg_renderer();
        let writing = !matches!(action, Action::Load);
        panel.busy = true;
        panel.notice = None;
        panel.observed = Some(observed);
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let (changed, result) = cx
                .background_executor()
                .spawn(async move {
                    let changed = action.perform(&transport);
                    let result = transport.portfolio().map(|list| {
                        let photos = list
                            .photos
                            .iter()
                            .filter(|row| row.service_id == Some(service));
                        let preferred = changed.as_ref().ok().and_then(|id| *id).or(selection);
                        let selected = preferred
                            .filter(|id| photos.clone().any(|row| row.id == *id))
                            .or_else(|| photos.clone().next().map(|row| row.id));
                        let preview = selected.and_then(|id| {
                            let bytes = transport.portfolio_photo(id).ok()?;
                            gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                                .to_image_data(renderer)
                                .ok()
                        });
                        (list, selected, preview)
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
                    panel.preview = preview.map(|image| {
                        cx.new(|cx| {
                            cx.on_release(|image: &mut Arc<gpui::RenderImage>, app| {
                                app.drop_image(image.clone(), None);
                            })
                            .detach();
                            image
                        })
                    });
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
        panel.draft = Some(Draft {
            caption: field(caption, cx),
            alt: field(alt, cx),
            source,
            needs_review: false,
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
                            path.map(|path| prepare_photo(&path).ok_or(Key::StaffPortraitInvalid))
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
                    Ok(Some(jpeg)) => root.start_portfolio_draft(
                        Source::Upload {
                            key: Uuid::now_v7(),
                            jpeg: Arc::new(jpeg),
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
        let input = PortfolioEdit {
            caption: draft.caption.read(cx).text().to_owned(),
            alt: draft.alt.read(cx).text().to_owned(),
            service_id: Some(panel.service),
        };
        let Ok(input) = input.normalized() else {
            panel.notice = Some(Key::CatalogPhotosInvalid);
            cx.notify();
            return;
        };
        let action = match &draft.source {
            Source::Upload { key, jpeg } => Action::Upload(*key, input, jpeg.clone()),
            Source::Existing(photo) => Action::Edit(photo.clone(), input),
        };
        self.request_catalog_portfolio(action, None, cx);
    }

    pub(super) fn render_catalog_portfolio(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.svc.status().connectivity == Connectivity::Online;
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
                body.child(self.t(Key::CatalogPhotosOffline))
            })
            .when_some(panel.notice, |body, notice| body.child(self.t(notice)));
        if let Some(confirm) = panel.confirm {
            return body
                .child(self.t(match confirm {
                    Confirm::Publish(..) => Key::CatalogPhotosPublishConfirm,
                    Confirm::Remove(..) => Key::StaffPortraitRemoveConfirm,
                    Confirm::Discard => Key::SalonConfirmDiscard,
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
                            !panel.busy && (online || matches!(confirm, Confirm::Discard)),
                            |actions| {
                                actions.child(self.button(
                                    "portfolio-confirm",
                                    self.t(match confirm {
                                        Confirm::Publish(..) => Key::StaffPortraitPublish,
                                        Confirm::Remove(..) => Key::StaffPortraitRemove,
                                        Confirm::Discard => Key::SalonDiscard,
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
            return body
                .child(self.label(Key::CatalogPhotosCaption))
                .child(draft.caption.clone())
                .child(self.label(Key::CatalogPhotosAlt))
                .child(draft.alt.clone())
                .when(
                    reviewed.is_some_and(|photo| photo.status == PortfolioStatus::Published),
                    |body| body.child(self.t(Key::CatalogPhotosEditPublic)),
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
                                        if let Some(draft) = root
                                            .catalog_portfolio()
                                            .and_then(|panel| panel.draft.as_mut())
                                        {
                                            draft.source = Source::Existing(current.clone());
                                            draft.needs_review = false;
                                        }
                                        cx.notify();
                                    }),
                                ))
                        },
                    )
                })
                .when(!panel.busy && online && !stale, |body| {
                    body.child(self.button(
                        "portfolio-save",
                        self.t(Key::StaffPortraitSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_portfolio_draft(cx)),
                    ))
                });
        }
        self.render_portfolio_photos(body, panel, online, cx)
    }

    fn confirm_portfolio_action(&mut self, confirm: Confirm, cx: &mut Context<Self>) {
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
            Confirm::Discard => return,
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
            Confirm::Discard => return,
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
        .when(panel.photos.is_some() && selected.is_none(), |body| {
            body.child(self.t(Key::CatalogPhotosEmpty))
        })
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
                        .child(self.button(
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
