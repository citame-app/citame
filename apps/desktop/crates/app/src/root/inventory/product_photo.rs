use super::image::{Preview, pick_inventory_image, tracked_image};
use super::*;
use sob_core::product_editor::ProductPhotoProposal;

#[derive(Clone, PartialEq, Eq)]
struct Review {
    version: Option<uuid::Uuid>,
    generation: String,
}

impl Review {
    fn new(product: &Product) -> Option<Self> {
        Some(Self {
            version: product.photo_version,
            generation: product.inventory_generation.clone()?,
        })
    }
}

enum Change {
    Upload(Vec<u8>, Option<Preview>),
    Remove,
}

impl Change {
    fn from_proposal(proposal: &ProductPhotoProposal) -> Option<Self> {
        Some(match proposal.image().ok()? {
            Some(bytes) => Self::Upload(bytes, None),
            None => Self::Remove,
        })
    }
}

pub(super) struct Panel {
    id: ProductId,
    instance: Arc<()>,
    product: Option<Product>,
    preview: Option<Preview>,
    draft: Option<Change>,
    baseline: Option<Review>,
    conflict: Option<String>,
    request: Option<Arc<()>>,
    choosing: bool,
    confirm_close: bool,
    confirm_discard_conflict: bool,
    pending: bool,
    queued: Option<Change>,
    revision: i64,
    staff_revision: i64,
    notice: Option<Key>,
}

impl Panel {
    pub(super) fn dismiss(&mut self) -> bool {
        if self.choosing {
            return false;
        }
        if self.confirm_discard_conflict {
            self.confirm_discard_conflict = false;
            return false;
        }
        if self.confirm_close {
            self.confirm_close = false;
            return false;
        }
        if self.draft.is_some() {
            self.confirm_close = true;
            return false;
        }
        true
    }

    fn current(&self) -> Option<Review> {
        self.product.as_ref().and_then(Review::new)
    }

    fn needs_review(&self) -> bool {
        self.draft.is_some() && (self.baseline.is_none() || self.baseline != self.current())
    }

    fn shows_current(&self) -> bool {
        self.current()
            .is_some_and(|review| review.version.is_none() || self.preview.is_some())
    }

    fn review_current(&mut self, online: bool) -> bool {
        if !online || self.request.is_some() || !self.shows_current() {
            return false;
        }
        self.baseline = self.current();
        true
    }
}

impl Root {
    pub(super) fn open_product_photo(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &self.overlay else {
            return;
        };
        if desk.product_form.is_some()
            || desk.product_photo.is_some()
            || desk.stock.is_some()
            || desk.request.is_some()
        {
            return;
        }
        let Some(product) = desk.product.clone() else {
            return;
        };
        self.start_product_photo(product.id, Some(product), None, None, cx);
    }

    pub(super) fn open_cached_product_photo(&mut self, id: ProductId, cx: &mut Context<Self>) {
        let Some(product) = self
            .svc
            .store
            .reviewed_products()
            .ok()
            .and_then(|rows| rows.into_iter().find(|product| product.id == id))
        else {
            return;
        };
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.product_form.is_some() || desk.product_photo.is_some() || desk.request.is_some() {
            return;
        }
        desk.product = Some(product.clone());
        self.start_product_photo(id, Some(product), None, None, cx);
    }

    pub(in crate::root) fn open_product_photo_conflict(
        &mut self,
        mutation_id: &str,
        cx: &mut Context<Self>,
    ) {
        let Ok(Some(id)) = self.svc.store.product_photo_conflict_id(mutation_id) else {
            return;
        };
        let draft = self
            .svc
            .store
            .conflicted_product_photo(mutation_id)
            .ok()
            .flatten()
            .as_ref()
            .and_then(Change::from_proposal);
        self.prepare_inventory(cx);
        self.start_product_photo(id, None, draft, Some(mutation_id.into()), cx);
    }

    fn start_product_photo(
        &mut self,
        id: ProductId,
        product: Option<Product>,
        draft: Option<Change>,
        conflict: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let baseline = product.as_ref().and_then(Review::new);
        let queued = self
            .svc
            .store
            .queued_product_photo(id)
            .ok()
            .flatten()
            .as_ref()
            .and_then(Change::from_proposal);
        desk.product_photo = Some(Box::new(Panel {
            id,
            instance: Arc::new(()),
            product,
            preview: None,
            draft,
            baseline,
            conflict,
            request: None,
            choosing: false,
            confirm_close: false,
            confirm_discard_conflict: false,
            pending: self.svc.store.pending_product_photo(id).unwrap_or(true),
            queued,
            revision: -1,
            staff_revision: -1,
            notice: None,
        }));
        desk.error = None;
        self.load_queued_photo_preview(cx);
        self.load_product_photo(cx);
        cx.notify();
    }

    pub(in crate::root) fn preserve_open_product_photo(&mut self) -> bool {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return false;
        };
        let Some(panel) = &mut desk.product_photo else {
            return false;
        };
        panel.product = None;
        panel.preview = None;
        if let Some(Change::Upload(_, preview)) = &mut panel.draft {
            *preview = None;
        }
        panel.baseline = None;
        panel.request = None;
        panel.choosing = false;
        panel.queued = None;
        panel.instance = Arc::new(());
        panel.revision = -1;
        panel.staff_revision = -1;
        desk.product = None;
        desk.catalogue_tools.report = None;
        true
    }

    pub(super) fn refresh_product_photo(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return false;
        };
        let Some(panel) = &mut desk.product_photo else {
            return false;
        };
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff_revision = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        if panel.staff_revision != staff_revision {
            panel.preview = None;
        }
        let pending = self
            .svc
            .store
            .pending_product_photo(panel.id)
            .unwrap_or(true);
        let changed = pending != panel.pending;
        panel.pending = pending;
        if !pending || !self.svc.store.can_queue_product_edits() {
            panel.queued = None;
        }
        if panel.request.is_none()
            && !panel.choosing
            && (reconnected
                || changed
                || revision != panel.revision
                || staff_revision != panel.staff_revision)
        {
            self.load_product_photo(cx);
        }
        if changed {
            cx.notify();
        }
        true
    }

    fn load_queued_photo_preview(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &self.overlay else {
            return;
        };
        let Some(panel) = &desk.product_photo else {
            return;
        };
        let Some(Change::Upload(bytes, None)) = &panel.queued else {
            return;
        };
        let bytes = bytes.clone();
        let instance = panel.instance.clone();
        let session = self.svc.session.clone();
        let renderer = cx.svg_renderer();
        let decode = cx.background_executor().spawn(async move {
            gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes).to_image_data(renderer)
        });
        cx.spawn(async move |handle, cx| {
            let Ok(image) = decode.await else {
                return;
            };
            let _ = handle.update(cx, |root, cx| {
                if Arc::ptr_eq(&root.svc.session, &session)
                    && root.svc.store.can_queue_product_edits()
                    && let Overlay::Inventory(desk) = &mut root.overlay
                    && let Some(panel) = &mut desk.product_photo
                    && Arc::ptr_eq(&panel.instance, &instance)
                    && let Some(Change::Upload(_, preview @ None)) = &mut panel.queued
                {
                    *preview = Some(tracked_image(image, cx));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn load_product_photo(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.product_photo else {
            return;
        };
        if panel.request.is_some() || panel.choosing {
            return;
        }
        let id = panel.id;
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff_revision = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let request = Arc::new(());
        panel.request = Some(request.clone());
        let draft_bytes = match &panel.draft {
            Some(Change::Upload(bytes, None)) => Some(bytes.clone()),
            _ => None,
        };
        let session = self.svc.session.clone();
        let renderer = cx.svg_renderer();
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let product = transport.inventory_product(id)?;
                    let decode = |bytes| {
                        gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                            .to_image_data(renderer.clone())
                            .ok()
                    };
                    let image = if let Some(version) = product.photo_version {
                        Some(match transport.inventory_product_photo(id, version) {
                            Ok(bytes) => decode(bytes),
                            Err(
                                error @ (TransportError::Forbidden(_)
                                | TransportError::Unauthorized),
                            ) => {
                                return Err(error);
                            }
                            Err(_) => None,
                        })
                    } else {
                        None
                    };
                    Ok::<_, TransportError>((product, image, draft_bytes.and_then(decode)))
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::Inventory(desk) = &mut root.overlay else {
                    return;
                };
                let Some(panel) = &mut desk.product_photo else {
                    return;
                };
                if !panel
                    .request
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &request))
                {
                    return;
                }
                panel.request = None;
                panel.revision = revision;
                panel.staff_revision = staff_revision;
                if root.svc.store.staff_directory_revision().ok() != Some(staff_revision) {
                    panel.preview = None;
                    cx.notify();
                    return;
                }
                match result {
                    Ok((product, image, draft_image)) => {
                        panel.notice = image
                            .as_ref()
                            .is_some_and(Option::is_none)
                            .then_some(Key::InventoryPhotoUnavailable);
                        panel.preview = image.flatten().map(|image| tracked_image(image, cx));
                        if let (Some(Change::Upload(_, preview @ None)), Some(image)) =
                            (&mut panel.draft, draft_image)
                        {
                            *preview = Some(tracked_image(image, cx));
                        }
                        if panel.draft.is_none() {
                            panel.baseline = Review::new(&product);
                        }
                        if product.can_manage {
                            let _ = root.svc.store.remember_reviewed_product(&product);
                        }
                        desk.product = Some(product.clone());
                        panel.product = Some(product);
                    }
                    Err(error) => {
                        panel.preview = None;
                        if matches!(
                            error,
                            TransportError::Forbidden(_) | TransportError::Unauthorized
                        ) {
                            panel.product = None;
                            panel.baseline = None;
                            desk.product = None;
                            panel.notice = Some(Key::InventoryRestricted);
                        } else {
                            panel.notice = Some(Key::InventoryPhotoUnavailable);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_product_photo(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.product_photo else {
            return;
        };
        if panel.current().is_none()
            || panel.request.is_some()
            || panel.choosing
            || panel.pending
            || (self.status.connectivity == Connectivity::Online && !panel.shows_current())
        {
            return;
        }
        panel.choosing = true;
        let instance = panel.instance.clone();
        let session = self.svc.session.clone();
        let picker = pick_inventory_image(cx, self.t(Key::InventoryPhotoChoose).into());
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = picker.await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::Inventory(desk) = &mut root.overlay else {
                    return;
                };
                let Some(panel) = &mut desk.product_photo else {
                    return;
                };
                if !Arc::ptr_eq(&panel.instance, &instance) {
                    return;
                }
                panel.choosing = false;
                if !root.svc.store.can_queue_product_edits() {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(Some((jpeg, preview))) => {
                        panel.draft = Some(Change::Upload(jpeg, Some(tracked_image(preview, cx))));
                        panel.notice = None;
                    }
                    Ok(None) => (),
                    Err(error) => panel.notice = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn queue_product_photo(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.product_photo else {
            return;
        };
        if panel.needs_review() || panel.pending || panel.choosing || panel.request.is_some() {
            return;
        }
        if self.status.connectivity == Connectivity::Online && !panel.shows_current() {
            return;
        }
        let (Some(baseline), Some(change)) = (&panel.baseline, &panel.draft) else {
            return;
        };
        let bytes = match change {
            Change::Upload(bytes, _) => Some(bytes.as_slice()),
            Change::Remove => None,
        };
        let proposal = ProductPhotoProposal::new(panel.id, baseline.version, bytes);
        match proposal.and_then(|proposal| {
            self.svc.store.queue_product_photo(
                &baseline.generation,
                proposal,
                panel.conflict.as_deref(),
            )
        }) {
            Ok(()) => {
                panel.queued = panel.draft.take();
                panel.conflict = None;
                panel.pending = true;
                panel.notice = None;
                if self.status.connectivity == Connectivity::Online {
                    self.edited(cx);
                } else {
                    self.reload(cx);
                }
            }
            Err(CoreError::CalendarGenerationChanged) => {
                panel.baseline = None;
                panel.notice = Some(Key::InventoryConflict);
            }
            Err(_) => panel.notice = Some(Key::InventoryPhotoUnavailable),
        }
        cx.notify();
    }

    fn discard_product_photo_conflict(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.product_photo else {
            return;
        };
        let Some(id) = panel
            .conflict
            .as_deref()
            .filter(|_| panel.confirm_discard_conflict)
        else {
            return;
        };
        match self.svc.store.discard_product_photo_conflict(id) {
            Ok(()) => {
                self.overlay = Overlay::Conflicts {
                    editing: None,
                    error: None,
                };
                self.reload(cx);
            }
            Err(_) => {
                panel.confirm_discard_conflict = false;
                panel.notice = Some(Key::InventoryPhotoUnavailable);
                cx.notify();
            }
        }
    }
}

impl Root {
    pub(super) fn render_product_photo(&self, panel: &Panel, cx: &mut Context<Self>) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let write = self.svc.store.can_queue_product_edits()
            && panel
                .product
                .as_ref()
                .is_some_and(|product| product.can_manage);
        let idle = panel.request.is_none() && !panel.choosing;
        let busy = panel.request.is_some() || panel.choosing;
        let current = panel.current();
        let has_photo = current
            .as_ref()
            .is_some_and(|review| review.version.is_some());
        let can_edit = write && idle && !panel.pending;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::InventoryProductPhoto)),
            )
            .when_some(panel.product.as_ref(), |body, product| {
                body.child(product.name.clone())
            });
        if panel.confirm_discard_conflict {
            return body.child(self.t(Key::InventoryPhotoDiscardConfirm)).child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "product-photo-cancel-delete",
                        self.t(Key::ReviewKeepEditing),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    ))
                    .child(self.button(
                        "product-photo-confirm-delete",
                        self.t(Key::InventoryPhotoDiscardProposal),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| root.discard_product_photo_conflict(cx)),
                    )),
            );
        }
        if panel.confirm_close {
            return body.child(self.t(Key::InventoryPhotoDiscard)).child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "product-photo-keep",
                        self.t(Key::ReviewKeepEditing),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    ))
                    .child(self.button(
                        "product-photo-discard",
                        self.t(Key::ReviewDiscard),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::Inventory(desk) = &mut root.overlay {
                                desk.product_photo = None;
                                desk.observed_revision = -1;
                            }
                            cx.notify();
                        }),
                    )),
            );
        }
        let stage = |title, image: &Preview| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(self.label(title))
                .child(
                    gpui::img(image.read(cx).clone())
                        .size(px(160.))
                        .rounded_md()
                        .object_fit(gpui::ObjectFit::Contain),
                )
        };
        body.when(busy, |body| body.child(self.t(Key::InventoryLoading)))
            .when(!online, |body| {
                body.child(self.t(Key::InventoryPhotoOffline))
            })
            .when(panel.pending, |body| {
                body.child(self.t(Key::InventoryPhotoQueued))
            })
            .when_some(panel.notice, |body, notice| body.child(self.t(notice)))
            .when(!has_photo && current.is_some(), |body| {
                body.child(self.t(Key::InventoryPhotoEmpty))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_3()
                    .when_some(panel.preview.as_ref(), |row, image| {
                        row.child(stage(Key::InventoryPhotoCurrent, image))
                    })
                    .when(write, |row| {
                        match panel.queued.as_ref().or(panel.draft.as_ref()) {
                            Some(Change::Upload(_, Some(image))) => {
                                row.child(stage(Key::InventoryPhotoDraft, image))
                            }
                            Some(Change::Upload(..)) => row.child(self.t(Key::InventoryPhotoDraft)),
                            Some(Change::Remove) => {
                                row.child(self.t(Key::InventoryPhotoRemoveDraft))
                            }
                            None => row,
                        }
                    }),
            )
            .when(can_edit && panel.needs_review(), |body| {
                body.child(self.t(Key::InventoryPhotoChanged)).when(
                    online && panel.shows_current(),
                    |body| {
                        body.child(self.button(
                            "product-photo-review",
                            self.t(Key::InventoryPhotoReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if root.svc.store.can_queue_product_edits()
                                    && let Overlay::Inventory(desk) = &mut root.overlay
                                    && let Some(panel) = &mut desk.product_photo
                                    && panel.review_current(
                                        root.status.connectivity == Connectivity::Online,
                                    )
                                {
                                    cx.notify();
                                }
                            }),
                        ))
                    },
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(online && idle, |row| {
                        row.child(self.button(
                            "product-photo-reload",
                            self.t(Key::InventoryRefresh),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.load_product_photo(cx)),
                        ))
                    })
                    .when(can_edit && (!online || panel.shows_current()), |row| {
                        row.child(self.button(
                            "product-photo-choose",
                            self.t(Key::InventoryPhotoChoose),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.choose_product_photo(cx)),
                        ))
                        .when(has_photo, |row| {
                            row.child(self.button(
                                "product-photo-remove",
                                self.t(Key::InventoryPhotoRemove),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if root.svc.store.can_queue_product_edits()
                                        && let Overlay::Inventory(desk) = &mut root.overlay
                                        && let Some(panel) = &mut desk.product_photo
                                        && panel.request.is_none()
                                        && !panel.pending
                                        && (root.status.connectivity != Connectivity::Online
                                            || panel.shows_current())
                                    {
                                        panel.draft = Some(Change::Remove);
                                        cx.notify();
                                    }
                                }),
                            ))
                        })
                        .when(
                            panel.draft.is_some() && !panel.needs_review(),
                            |row| {
                                row.child(self.button(
                                    "product-photo-save",
                                    self.t(Key::InventoryPhotoSave),
                                    Kind::Primary,
                                    cx.listener(|root, _, _, cx| root.queue_product_photo(cx)),
                                ))
                            },
                        )
                    }),
            )
            .when(idle && panel.conflict.is_some(), |body| {
                body.child(self.button(
                    "product-photo-delete-proposal",
                    self.t(Key::InventoryPhotoDiscardProposal),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| {
                        let Overlay::Inventory(desk) = &mut root.overlay else {
                            return;
                        };
                        let Some(panel) = &mut desk.product_photo else {
                            return;
                        };
                        panel.confirm_discard_conflict = true;
                        cx.notify();
                    }),
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_removal_requires_a_visible_current_version() {
        let id = uuid::Uuid::now_v7();
        let product = serde_json::from_value(serde_json::json!({
            "id": id, "name": "Fixture", "sku": "FIXTURE", "stockOnHand": 0,
            "stockReserved": 0, "available": 0, "unitLabel": "unit",
            "priceCents": 0, "currency": "EUR", "active": true,
            "version": 1, "inventoryGeneration": "fixture", "canManage": true,
            "photoVersion": uuid::Uuid::now_v7()
        }))
        .unwrap();
        let mut panel = Panel {
            id,
            instance: Arc::new(()),
            product: Some(product),
            preview: None,
            draft: Some(Change::Remove),
            baseline: None,
            conflict: Some("fixture".into()),
            request: None,
            choosing: false,
            confirm_close: false,
            confirm_discard_conflict: false,
            pending: false,
            queued: None,
            revision: 0,
            staff_revision: 0,
            notice: None,
        };
        assert!(panel.needs_review());
        assert!(
            !panel.review_current(true),
            "a missing preview cannot be approved"
        );
        panel.product.as_mut().unwrap().photo_version = None;
        assert!(
            !panel.review_current(false),
            "an offline snapshot cannot rebase a conflict"
        );
        assert!(panel.review_current(true));
        assert!(!panel.needs_review());
        assert!(matches!(panel.draft, Some(Change::Remove)));
    }
}
