use super::*;
use crate::root::inventory::image::{Preview, pick_inventory_image, tracked_image};
use sob_core::inventory_classifications::{BrandLogo, BrandLogoProposal};

#[derive(Clone, PartialEq, Eq)]
struct Review {
    generation: String,
    logo: Option<BrandLogo>,
}

impl Review {
    fn version(&self) -> Option<Uuid> {
        self.logo.map(|logo| logo.version)
    }
}

enum Change {
    Upload(Vec<u8>, Option<Preview>),
    Remove,
}

pub(super) struct Editor {
    brand: Uuid,
    instance: Arc<()>,
    baseline: Option<Review>,
    preview: Option<(Uuid, Preview)>,
    requested: Option<Uuid>,
    draft: Option<Change>,
    conflict: Option<String>,
    choosing: bool,
    notice: Option<Key>,
}

impl Editor {
    fn new(brand: Uuid) -> Self {
        Self {
            brand,
            instance: Arc::new(()),
            baseline: None,
            preview: None,
            requested: None,
            draft: None,
            conflict: None,
            choosing: false,
            notice: None,
        }
    }

    pub(super) fn busy(&self) -> bool {
        self.choosing
    }

    pub(super) fn dirty(&self) -> bool {
        self.draft.is_some()
    }

    pub(super) fn preserve_after_restore(&mut self) {
        self.baseline = None;
        self.preview = None;
        if let Some(Change::Upload(_, preview)) = &mut self.draft {
            *preview = None;
        }
        self.requested = None;
        self.choosing = false;
        self.instance = Arc::new(());
    }

    fn shows_current(&self, review: &Review) -> bool {
        !review.logo.is_some_and(|logo| logo.present)
            || self.preview.as_ref().map(|(version, _)| *version) == review.version()
    }
}

fn reviewed_brand(
    catalogue: &ClassificationCatalogue,
    id: Uuid,
) -> Option<(&Classification, Review)> {
    let brand = catalogue
        .entries
        .iter()
        .find(|entry| entry.id == id && entry.kind == ClassificationKind::Brand)?;
    Some((
        brand,
        Review {
            generation: catalogue.generation.clone(),
            logo: brand.logo,
        },
    ))
}

impl Root {
    fn brand_logo_editor(&mut self) -> Option<&mut Editor> {
        self.classifications_panel()?.logo.as_mut()
    }

    pub(super) fn open_brand_logo(&mut self, brand: Uuid, cx: &mut Context<Self>) {
        if let Some(panel) = self.classifications_panel()
            && panel.logo.is_none()
            && panel.draft.is_none()
        {
            panel.logo = Some(Editor::new(brand));
            self.refresh_brand_logo(cx);
            cx.notify();
        }
    }

    pub(in crate::root) fn open_brand_logo_conflict(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(proposal) = self
            .svc
            .store
            .inventory_brand_logo_conflict(id)
            .ok()
            .flatten()
        else {
            return;
        };
        let Ok(bytes) = proposal.image() else {
            return;
        };
        self.prepare_inventory(cx);
        self.open_classifications(cx);
        if let Some(panel) = self.classifications_panel() {
            let mut editor = Editor::new(proposal.id);
            editor.conflict = Some(id.to_owned());
            editor.draft = Some(bytes.map_or(Change::Remove, |bytes| Change::Upload(bytes, None)));
            panel.logo = Some(editor);
        }
        self.refresh_brand_logo(cx);
        cx.notify();
    }

    pub(super) fn refresh_brand_logo(&mut self, cx: &mut Context<Self>) {
        let Some(catalogue) = self.svc.store.inventory_classifications().ok().flatten() else {
            return;
        };
        let session = self.svc.session.clone();
        let staff_revision = self.svc.store.staff_directory_revision().ok();
        let online = self.svc.status().connectivity == Connectivity::Online;
        let transport = self.svc.transport().filter(|_| online);
        let Some(editor) = self.brand_logo_editor() else {
            return;
        };
        let Some((_, review)) = reviewed_brand(&catalogue, editor.brand) else {
            return;
        };
        if editor.draft.is_none() && !editor.choosing {
            editor.baseline = Some(review.clone());
        }
        let Some(version) = review
            .logo
            .filter(|logo| logo.present)
            .map(|logo| logo.version)
        else {
            editor.preview = None;
            editor.requested = None;
            return;
        };
        if editor
            .preview
            .as_ref()
            .is_some_and(|(loaded, _)| *loaded != version)
        {
            editor.preview = None;
        }
        let Some(transport) = transport else { return };
        if editor.requested == Some(version) || editor.shows_current(&review) {
            return;
        }
        editor.requested = Some(version);
        let id = editor.brand;
        let instance = editor.instance.clone();
        let renderer = cx.svg_renderer();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let bytes = transport.inventory_brand_logo(id, version)?;
                    gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                        .to_image_data(renderer)
                        .map_err(|_| TransportError::Server("Invalid brand logo preview".into()))
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let staff_current =
                    root.svc.store.staff_directory_revision().ok() == staff_revision;
                let Some(editor) = root.brand_logo_editor().filter(|editor| {
                    Arc::ptr_eq(&editor.instance, &instance) && editor.requested == Some(version)
                }) else {
                    return;
                };
                editor.requested = None;
                if !staff_current {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(image) => {
                        editor.preview = Some((version, tracked_image(image, cx)));
                        editor.notice = None;
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        editor.notice = Some(Key::InventoryRestricted);
                        let _ = root.svc.store.withdraw_inventory_access();
                    }
                    Err(_) => editor.notice = Some(Key::InventoryPhotoUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_brand_logo(&mut self, cx: &mut Context<Self>) {
        let session = self.svc.session.clone();
        let Some(editor) = self.brand_logo_editor() else {
            return;
        };
        editor.choosing = true;
        let instance = editor.instance.clone();
        let picker = pick_inventory_image(cx, self.t(Key::InventoryPhotoChoose).into());
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = picker.await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let authorized = root.svc.store.can_queue_product_edits();
                let Some(editor) = root
                    .brand_logo_editor()
                    .filter(|editor| Arc::ptr_eq(&editor.instance, &instance))
                else {
                    return;
                };
                editor.choosing = false;
                if authorized {
                    match result {
                        Ok(Some((jpeg, image))) => {
                            editor.draft =
                                Some(Change::Upload(jpeg, Some(tracked_image(image, cx))));
                            editor.notice = None;
                        }
                        Ok(None) => (),
                        Err(notice) => editor.notice = Some(notice),
                    }
                }
                root.refresh_brand_logo(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn queue_brand_logo(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.brand_logo_editor() else {
            return;
        };
        let (Some(baseline), Some(draft)) = (editor.baseline.as_ref(), editor.draft.as_ref())
        else {
            return;
        };
        let generation = baseline.generation.clone();
        let conflict = editor.conflict.clone();
        let jpeg = match draft {
            Change::Upload(bytes, _) => Some(bytes.as_slice()),
            Change::Remove => None,
        };
        let result =
            BrandLogoProposal::new(editor.brand, baseline.version(), jpeg).and_then(|proposal| {
                self.svc.store.queue_inventory_brand_logo(
                    &generation,
                    proposal,
                    conflict.as_deref(),
                )
            });
        if let Some(editor) = self.brand_logo_editor() {
            editor.notice = Some(match result {
                Ok(()) => {
                    editor.draft = None;
                    editor.conflict = None;
                    Key::InventoryDocumentQueued
                }
                Err(CoreError::CatalogueEditPending) => Key::InventoryWarehousePending,
                Err(_) => Key::InventoryPhotoChanged,
            });
        }
        if result.is_ok() {
            self.edited(cx);
        } else {
            self.load_classifications(cx);
        }
        cx.notify();
    }

    pub(super) fn render_brand_logo(
        &self,
        editor: &Editor,
        catalogue: &ClassificationCatalogue,
        current: bool,
        loading: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.t(Key::InventoryBrandLogo))
            .when_some(editor.notice, |body, notice| body.child(self.t(notice)))
            .child(self.button(
                "close-brand-logo",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    if let Some(panel) = root.classifications_panel() {
                        panel.dismiss();
                        cx.notify();
                    }
                }),
            ));
        let Some((brand, review)) = reviewed_brand(catalogue, editor.brand) else {
            return body.child(self.t(Key::InventoryClassificationsUnavailable));
        };
        let online = self.status.connectivity == Connectivity::Online;
        let pending = self.svc.store.pending_brand_logo(brand.id).unwrap_or(true);
        let match_review = editor.baseline.as_ref() == Some(&review);
        let editable = self.svc.store.can_queue_product_edits()
            && !editor.choosing
            && !pending
            && (!online || (current && editor.shows_current(&review)));
        body = body
            .child(brand.name.clone())
            .when(!online, |body| {
                body.child(self.t(Key::InventoryPhotoOffline))
            })
            .when(pending, |body| {
                body.child(self.t(Key::InventoryDocumentQueued))
            })
            .when_some(
                editor
                    .preview
                    .as_ref()
                    .filter(|(version, _)| Some(*version) == review.version()),
                |body, (_, image)| {
                    body.child(
                        gpui::img(image.read(cx).clone())
                            .w(px(96.0))
                            .h(px(96.0))
                            .object_fit(gpui::ObjectFit::Contain),
                    )
                },
            )
            .when(
                online
                    && !loading
                    && (!current || (editor.requested.is_none() && !editor.shows_current(&review))),
                |body| {
                    body.child(self.button(
                        "retry-brand-logo",
                        self.t(Key::InventoryRefresh),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if current {
                                root.refresh_brand_logo(cx);
                            } else {
                                root.load_classifications(cx);
                            }
                            cx.notify();
                        }),
                    ))
                },
            )
            .when_some(
                editor
                    .draft
                    .as_ref()
                    .filter(|_| self.svc.store.can_queue_product_edits()),
                |body, draft| match draft {
                    Change::Upload(_, Some(preview)) => {
                        body.child(self.t(Key::InventoryPhotoDraft)).child(
                            gpui::img(preview.read(cx).clone())
                                .w(px(96.0))
                                .h(px(96.0))
                                .object_fit(gpui::ObjectFit::Contain),
                        )
                    }
                    Change::Upload(_, None) => body.child(self.t(Key::InventoryPhotoDraft)),
                    Change::Remove => body.child(self.t(Key::InventoryPhotoRemoveDraft)),
                },
            );
        if !editable {
            return body;
        }
        if !match_review {
            return body
                .child(self.t(Key::InventoryPhotoChanged))
                .when(online, |body| {
                    body.child(self.button(
                        "review-brand-logo",
                        self.t(Key::InventoryPhotoReview),
                        Kind::Primary,
                        cx.listener(move |root, _, _, cx| {
                            if let Some(editor) = root.brand_logo_editor() {
                                editor.baseline = Some(review.clone());
                                editor.notice = None;
                                cx.notify();
                            }
                        }),
                    ))
                });
        }
        body.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .child(self.button(
                    "choose-brand-logo",
                    self.t(Key::InventoryPhotoChoose),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.choose_brand_logo(cx)),
                ))
                .when(brand.logo.is_some_and(|logo| logo.present), |row| {
                    row.child(self.button(
                        "remove-brand-logo",
                        self.t(Key::InventoryPhotoRemove),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Some(editor) = root.brand_logo_editor() {
                                editor.draft = Some(Change::Remove);
                                editor.notice = None;
                                cx.notify();
                            }
                        }),
                    ))
                })
                .when(editor.dirty(), |row| {
                    row.child(self.button(
                        "save-brand-logo",
                        self.t(Key::InventoryPhotoSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.queue_brand_logo(cx)),
                    ))
                }),
        )
    }
}
