use super::*;
use sob_core::error::CoreError;
use sob_core::service_resources::{
    MUTATION_KIND, PendingServiceResources, QueuedServiceResources, ResourceDraft,
    ReviewedServiceResources, SelectionMode,
};
use sob_core::sync::TransportError;

pub(super) struct Desk {
    identity: Arc<()>,
    search: Entity<TextField>,
    services: Vec<Service>,
    selected: Option<String>,
    latest: Option<ReviewedServiceResources>,
    editor: Option<Editor>,
    recovery: Option<Recovery>,
    pending: Option<QueuedServiceResources>,
    observed: Option<(i64, i64)>,
    data_version: Option<i64>,
    retry_at: Option<Instant>,
    busy: bool,
    denied: bool,
    confirm_close: bool,
    notice: Option<Key>,
}

struct Editor {
    baseline: ReviewedServiceResources,
    draft: ResourceDraft,
}

struct Recovery {
    mutation_id: String,
    edit: PendingServiceResources,
    rejected_version: Option<u64>,
    needs_online_review: bool,
}

impl Recovery {
    fn from_conflict(conflict: &Conflict) -> Option<Self> {
        if conflict.kind != MUTATION_KIND {
            return None;
        }
        let edit: PendingServiceResources =
            serde_json::from_value(conflict.payload.clone()).ok()?;
        Some(Self {
            mutation_id: conflict.mutation_id.clone(),
            rejected_version: (conflict.reason == "conflict").then_some(edit.version),
            needs_online_review: conflict.requires_restored_review(),
            edit,
        })
    }
}

impl Editor {
    fn new(baseline: ReviewedServiceResources) -> Self {
        let draft = ResourceDraft::from(&baseline.service);
        Self { baseline, draft }
    }

    fn dirty(&self) -> bool {
        self.draft != ResourceDraft::from(&self.baseline.service)
    }
}

impl Desk {
    fn review_available(&self) -> bool {
        self.latest.as_ref().is_some_and(|latest| {
            self.recovery.as_ref().is_none_or(|recovery| {
                !recovery.needs_online_review
                    && recovery
                        .rejected_version
                        .is_none_or(|version| latest.service.version > version)
            })
        })
    }
}

impl Root {
    pub(super) fn open_resource_requirements(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let search = cx.new(|cx| TextField::new(self.t(Key::AssignmentSearch), false, cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        self.overlay = Overlay::ResourceRequirements(Box::new(Desk {
            identity: Arc::new(()),
            search,
            services: self.svc.store.services().unwrap_or_default(),
            selected: None,
            latest: None,
            editor: None,
            recovery: None,
            pending: None,
            observed: None,
            data_version: None,
            retry_at: None,
            busy: false,
            denied: false,
            confirm_close: false,
            notice: None,
        }));
        cx.notify();
    }

    fn select_resource_service(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return;
        };
        if desk.selected.is_some() {
            return;
        }
        desk.latest = self
            .svc
            .store
            .reviewed_service_resources(&id)
            .ok()
            .flatten();
        desk.pending = self.svc.store.pending_service_resources(&id).ok().flatten();
        desk.editor = desk.latest.clone().map(Editor::new);
        desk.selected = Some(id);
        self.refresh_service_resources(true, cx);
        cx.notify();
    }

    pub(super) fn open_resource_conflict(&mut self, mutation_id: &str, cx: &mut Context<Self>) {
        let Ok(Some(conflict)) = self.svc.store.conflict(mutation_id) else {
            return;
        };
        if conflict.kind != MUTATION_KIND || !self.can_create_catalogue_item() {
            return;
        }
        let Some(recovery) = Recovery::from_conflict(&conflict) else {
            return;
        };
        let id = recovery.edit.id.clone();
        self.open_resource_requirements(cx);
        self.select_resource_service(id, cx);
        if let Overlay::ResourceRequirements(desk) = &mut self.overlay {
            desk.recovery = Some(recovery);
            desk.editor = None;
        }
        cx.notify();
    }

    pub(super) fn preserve_open_resource_requirements(&mut self) -> bool {
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return false;
        };
        desk.identity = Arc::new(());
        desk.latest = None;
        desk.busy = false;
        desk.observed = None;
        desk.retry_at = None;
        if let Some(recovery) = &mut desk.recovery {
            recovery.needs_online_review = true;
        }
        true
    }

    pub(super) fn refresh_service_resources(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let allowed = self.can_create_catalogue_item();
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return;
        };
        let Some(id) = desk.selected.clone() else {
            if desk.data_version != self.data_version {
                desk.data_version = self.data_version;
                desk.services = self.svc.store.services().unwrap_or_default();
                cx.notify();
            }
            return;
        };
        if !allowed {
            desk.denied = true;
            cx.notify();
            return;
        }
        if desk.data_version != self.data_version {
            let Ok(pending) = self.svc.store.pending_service_resources(&id) else {
                return;
            };
            desk.data_version = self.data_version;
            if let Some(old_pending) = &desk.pending
                && pending.is_none()
            {
                desk.observed = None;
                desk.recovery = self
                    .conflicts
                    .iter()
                    .find(|row| row.mutation_id == old_pending.mutation_id)
                    .and_then(Recovery::from_conflict);
                desk.latest = self
                    .svc
                    .store
                    .reviewed_service_resources(&id)
                    .ok()
                    .flatten();
                desk.editor = if desk.recovery.is_none() {
                    desk.latest.clone().map(Editor::new)
                } else {
                    None
                };
                desk.notice = Some(if desk.recovery.is_some() {
                    Key::CatalogChanged
                } else {
                    Key::ResourceSyncedRefresh
                });
            }
            desk.pending = pending;
            cx.notify();
        }
        if reconnected {
            desk.observed = None;
            desk.retry_at = None;
            desk.denied = false;
        }
        let Ok(revision) = self.svc.store.resource_catalogue_revision() else {
            return;
        };
        let due = desk
            .retry_at
            .map_or(desk.observed != Some(revision), |after| {
                after <= Instant::now()
            });
        if desk.busy || desk.denied || !due || self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        desk.busy = true;
        desk.observed = Some(revision);
        desk.retry_at = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let reply = cx
                .background_executor()
                .spawn(async move { transport.service_resources(&id) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Overlay::ResourceRequirements(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.identity, &identity)
                    || !Arc::ptr_eq(&root.svc.session, &session)
                {
                    return;
                }
                desk.busy = false;
                match reply {
                    Ok(snapshot) => {
                        if root
                            .svc
                            .store
                            .remember_service_resources(&snapshot, revision)
                            .is_ok()
                            && let Ok(Some(snapshot)) = root
                                .svc
                                .store
                                .reviewed_service_resources(&snapshot.service.service_id)
                        {
                            if let Some(recovery) = &mut desk.recovery {
                                recovery.needs_online_review = false;
                            } else if desk.editor.as_ref().is_none_or(|editor| !editor.dirty()) {
                                desk.editor = Some(Editor::new(snapshot.clone()));
                            }
                            desk.latest = Some(snapshot);
                            desk.notice = None;
                        } else {
                            desk.retry_at = Instant::now().checked_add(Duration::from_secs(2));
                        }
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        let _ = root.svc.store.forget_catalogue_access();
                        desk.denied = true;
                        desk.notice = Some(Key::CatalogAccessLost);
                    }
                    Err(error) => {
                        desk.notice = Some(Key::ResourceReadFailed);
                        let delay = match error {
                            TransportError::Offline(_) | TransportError::Server(_) => {
                                Some(Duration::from_secs(3))
                            }
                            TransportError::RateLimited(delay) => Some(
                                delay
                                    .unwrap_or(Duration::from_secs(30))
                                    .max(Duration::from_secs(1)),
                            ),
                            _ => None,
                        };
                        desk.retry_at = delay.and_then(|delay| Instant::now().checked_add(delay));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn review_resource_changes(&mut self, keep_draft: bool, cx: &mut Context<Self>) {
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return;
        };
        if !desk.review_available() || desk.denied {
            return;
        }
        let Some(latest) = desk.latest.clone() else {
            return;
        };
        let current = ResourceDraft::from(&latest.service);
        let draft = if let Some(recovery) = &desk.recovery
            && desk.editor.is_none()
        {
            recovery
                .edit
                .proposal()
                .review(&recovery.edit.reviewed, &current, keep_draft)
        } else if let Some(editor) = &desk.editor {
            editor.draft.review(
                &ResourceDraft::from(&editor.baseline.service),
                &current,
                keep_draft,
            )
        } else {
            return;
        };
        desk.editor = Some(Editor {
            baseline: latest,
            draft,
        });
        cx.notify();
    }

    fn queue_resource_changes(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = desk.editor.as_ref() else {
            return;
        };
        if desk.denied || desk.pending.is_some() || desk.latest.as_ref() != Some(&editor.baseline) {
            return;
        }
        let replaces = desk.recovery.as_ref().map(|row| row.mutation_id.as_str());
        match self
            .svc
            .store
            .queue_service_resources(&editor.baseline, &editor.draft, replaces)
        {
            Ok(queued) => {
                desk.pending = self
                    .svc
                    .store
                    .pending_service_resources(&editor.baseline.service.service_id)
                    .ok()
                    .flatten();
                desk.recovery = None;
                desk.editor = desk.latest.clone().map(Editor::new);
                desk.notice = Some(if queued {
                    Key::CatalogPending
                } else {
                    Key::CatalogSaved
                });
                self.edited(cx);
            }
            Err(CoreError::CatalogueVersionChanged | CoreError::CalendarGenerationChanged) => {
                desk.observed = None;
                desk.notice = Some(Key::CatalogChanged);
                cx.notify();
            }
            Err(_) => {
                desk.notice = Some(Key::ResourceInvalid);
                cx.notify();
            }
        }
    }

    pub(super) fn close_resource_requirements(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            self.open_web_management(cx);
            return;
        }
        let Overlay::ResourceRequirements(desk) = &mut self.overlay else {
            return;
        };
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.editor.as_ref().is_some_and(Editor::dirty) {
            desk.confirm_close = true;
        } else if desk.selected.is_some() {
            self.open_resource_requirements(cx);
        } else {
            self.open_web_management(cx);
        }
        cx.notify();
    }

    fn edit_resource_draft(
        &mut self,
        apply: impl FnOnce(&mut ResourceDraft),
        cx: &mut Context<Self>,
    ) {
        if !self.can_create_catalogue_item() {
            return;
        }
        if let Overlay::ResourceRequirements(desk) = &mut self.overlay
            && !desk.denied
            && desk.pending.is_none()
            && !desk.confirm_close
            && let Some(editor) = &mut desk.editor
        {
            apply(&mut editor.draft);
            desk.notice = None;
            cx.notify();
        }
    }

    pub(super) fn render_resource_requirements(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let selected = desk.selected.as_deref();
        let content = div()
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
                            .child(self.t(Key::ResourceRequirements)),
                    )
                    .child(self.button(
                        "resources-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_resource_requirements(cx)),
                    )),
            )
            .when(self.status.connectivity != Connectivity::Online, |view| {
                view.child(self.t(Key::CatalogOffline))
            })
            .when_some(desk.notice, |view, key| {
                view.child(div().text_sm().child(self.t(key)))
            })
            .when(desk.busy, |view| {
                view.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when_some(selected, |view, id| {
                let service = desk
                    .services
                    .iter()
                    .find(|row| row.id == id)
                    .map_or(id, |row| &row.name);
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(service.to_owned()),
                )
            })
            .when(desk.confirm_close, |view| {
                view.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "resources-discard",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.open_resource_requirements(cx)),
                    ))
            })
            .when(!desk.confirm_close && !desk.denied, |view| {
                if selected.is_none() {
                    let search = desk.search.read(cx).text().trim().to_lowercase();
                    return view.child(desk.search.clone()).child(
                        div()
                            .id("resources-services")
                            .min_h_0()
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .children(
                                desk.services
                                    .iter()
                                    .filter(|item| item.name.to_lowercase().contains(&search))
                                    .map(|item| {
                                        let id = item.id.clone();
                                        let label = if item.active {
                                            item.name.clone()
                                        } else {
                                            format!(
                                                "{} · {}",
                                                item.name,
                                                self.t(Key::StaffPortraitInactive)
                                            )
                                        };
                                        self.button(
                                            SharedString::from(format!("resource-service-{id}")),
                                            label,
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.select_resource_service(id.clone(), cx)
                                            }),
                                        )
                                    }),
                            ),
                    );
                }
                if let Some(pending) = &desk.pending {
                    return view.child(self.t(Key::CatalogPending)).child(
                        self.resource_summary(&pending.edit.proposal(), desk.latest.as_ref()),
                    );
                }
                let needs_review = desk.recovery.is_some() && desk.editor.is_none()
                    || desk
                        .editor
                        .as_ref()
                        .is_some_and(|editor| desk.latest.as_ref() != Some(&editor.baseline));
                if needs_review {
                    return view.child(self.render_resource_conflict(desk, cx));
                }
                if let Some(editor) = &desk.editor {
                    return view.child(self.render_resource_draft(editor, cx)).when(
                        editor.dirty() || desk.recovery.is_some(),
                        |view| {
                            view.child(self.button(
                                "resources-save",
                                self.t(Key::SaveServiceAnnotations),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.queue_resource_changes(cx)),
                            ))
                        },
                    );
                }
                view.when(!desk.busy, |view| {
                    view.child(self.t(Key::ResourceNeedsSync))
                })
            });
        self.modal_with_height(
            content,
            (viewport.width - px(32.)).max(px(270.)).min(px(590.)),
            (viewport.height - px(32.)).max(px(240.)).min(px(670.)),
            Some(cx),
        )
    }

    fn resource_summary(
        &self,
        draft: &ResourceDraft,
        snapshot: Option<&ReviewedServiceResources>,
    ) -> impl IntoElement {
        div()
            .text_sm()
            .child(self.t(if draft.quantities.is_empty() {
                Key::ResourceNone
            } else {
                selection_label(draft.mode)
            }))
            .children(draft.quantities.iter().map(|(id, quantity)| {
                let name = snapshot
                    .and_then(|view| view.resources.iter().find(|row| &row.id == id))
                    .map_or(id.as_str(), |row| &row.name);
                div().child(format!("{name} · {quantity}"))
            }))
    }

    fn render_resource_conflict(&self, desk: &Desk, cx: &mut Context<Self>) -> impl IntoElement {
        let (draft, before) = desk
            .editor
            .as_ref()
            .map(|editor| {
                (
                    editor.draft.clone(),
                    ResourceDraft::from(&editor.baseline.service),
                )
            })
            .or_else(|| {
                desk.recovery
                    .as_ref()
                    .map(|row| (row.edit.proposal(), row.edit.reviewed.clone()))
            })
            .unwrap_or_else(|| unreachable!("review needs a draft"));
        let current = desk
            .latest
            .as_ref()
            .map(|latest| ResourceDraft::from(&latest.service));
        let overlaps = current
            .as_ref()
            .is_some_and(|latest| draft.has_overlaps(&before, latest));
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.t(Key::ResourceDraft))
            .child(self.resource_summary(&draft, desk.latest.as_ref()))
            .when_some(current, |view, current| {
                view.child(self.t(Key::CatalogCurrent))
                    .child(self.resource_summary(&current, desk.latest.as_ref()))
            })
            .when(!desk.review_available(), |view| {
                view.child(self.t(Key::ResourceNeedsSync))
            })
            .when(desk.review_available(), |view| {
                view.child(self.button(
                    "resources-review",
                    self.t(if overlaps {
                        Key::CatalogKeepDraftGroups
                    } else {
                        Key::CatalogReview
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.review_resource_changes(true, cx)),
                ))
                .when(overlaps, |view| {
                    view.child(self.button(
                        "resources-review-cloud",
                        self.t(Key::CatalogKeepCloudGroups),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.review_resource_changes(false, cx)),
                    ))
                })
            })
    }

    fn render_resource_draft(&self, editor: &Editor, cx: &mut Context<Self>) -> impl IntoElement {
        let one_of = editor.draft.mode == SelectionMode::OneOf;
        div()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [SelectionMode::All, SelectionMode::OneOf]
                        .into_iter()
                        .map(|mode| {
                            self.button(
                                ("resource-selection", mode as usize),
                                self.t(selection_label(mode)),
                                if editor.draft.mode == mode {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    root.edit_resource_draft(|draft| draft.change_mode(mode), cx)
                                }),
                            )
                        }),
                ),
            )
            .child(
                div()
                    .id("service-resource-pools")
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .when(editor.baseline.resources.is_empty(), |view| {
                        view.child(self.t(Key::ResourceNoPools))
                    })
                    .children(
                        editor
                            .baseline
                            .resources
                            .iter()
                            .filter(|pool| {
                                pool.active || editor.draft.quantities.contains_key(&pool.id)
                            })
                            .map(|pool| {
                                let id = pool.id.clone();
                                let quantity =
                                    editor.draft.quantities.get(&id).copied().unwrap_or(0);
                                let chosen = quantity > 0;
                                let capacity = pool.capacity;
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(self.button(
                                        SharedString::from(format!("select-resource-{id}")),
                                        pool.name.clone(),
                                        if chosen { Kind::Primary } else { Kind::Ghost },
                                        cx.listener(move |root, _, _, cx| {
                                            root.edit_resource_draft(
                                                |draft| {
                                                    if draft.quantities.remove(&id).is_none() {
                                                        draft.quantities.insert(id.clone(), 1);
                                                    }
                                                },
                                                cx,
                                            )
                                        }),
                                    ))
                                    .when(!pool.active, |row| {
                                        row.child(
                                            div()
                                                .text_sm()
                                                .child(self.t(Key::StaffPortraitInactive)),
                                        )
                                    })
                                    .when(chosen && !one_of, |row| {
                                        let id = pool.id.clone();
                                        row.child(
                                            div()
                                                .text_sm()
                                                .child(format!("{quantity} / {capacity}")),
                                        )
                                        .children(
                                            [(false, "−"), (true, "+")]
                                                .into_iter()
                                                .filter(|(add, _)| {
                                                    if *add {
                                                        quantity < capacity
                                                    } else {
                                                        quantity > 1
                                                    }
                                                })
                                                .map(|(add, label)| {
                                                    let id = id.clone();
                                                    self.button(
                                                        SharedString::from(format!(
                                                            "resource-{add}-{id}"
                                                        )),
                                                        label,
                                                        Kind::Ghost,
                                                        cx.listener(move |root, _, _, cx| {
                                                            root.edit_resource_draft(
                                                                |draft| {
                                                                    if let Some(value) = draft
                                                                        .quantities
                                                                        .get_mut(&id)
                                                                    {
                                                                        *value = if add {
                                                                            value
                                                                                .saturating_add(1)
                                                                                .min(capacity)
                                                                        } else {
                                                                            value
                                                                                .saturating_sub(1)
                                                                                .max(1)
                                                                        };
                                                                    }
                                                                },
                                                                cx,
                                                            )
                                                        }),
                                                    )
                                                }),
                                        )
                                    })
                            }),
                    ),
            )
    }
}

fn selection_label(mode: SelectionMode) -> Key {
    match mode {
        SelectionMode::All => Key::ResourceAll,
        SelectionMode::OneOf => Key::ResourceOneOf,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use sob_core::service_resources::{ResourcePool, ServiceResources};

    #[gpui::test]
    async fn selecting_a_reviewed_room_offline_shows_the_durable_proposal(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let service = "0198f5a0-7b1c-7000-8000-000000000201";
            let room = "0198f5a0-7b1c-7000-8000-000000000202";
            root.svc.store.apply_page(&[RawChange {
                seq: 1000, entity: "service".into(), id: service.into(), op: "upsert".into(),
                data: Some(serde_json::json!({
                    "id":service, "name":"Sample", "durationMinutes":30, "bufferMinutes":0,
                    "priceCents":1000, "currency":"EUR", "active":true, "updatedAt":"2026-03-01T10:00:00Z"
                })),
            }], 1000).unwrap();
            let snapshot = ReviewedServiceResources {
                generation: root.svc.store.verified_reviewed_generation().unwrap(),
                resources: vec![ResourcePool { id: room.into(), name: "Room".into(), capacity: 2, active: true, version: 1 }],
                service: ServiceResources { service_id: service.into(), version: 2, selection_mode: SelectionMode::All, requirements: vec![] },
            };
            let revision = root.svc.store.resource_catalogue_revision().unwrap();
            root.svc.store.remember_service_resources(&snapshot, revision).unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_resource_requirements(cx);
            root.select_resource_service(service.into(), cx);
            root.edit_resource_draft(|draft| {
                draft.quantities.insert(room.into(), 2);
            }, cx);
            root.queue_resource_changes(cx);
            let Overlay::ResourceRequirements(desk) = &root.overlay else { panic!("resource editor closed") };
            assert_eq!(desk.pending.as_ref().unwrap().edit.proposal().quantities[room], 2);
            assert_eq!(root.svc.store.reviewed_service_resources(service).unwrap(), Some(snapshot));
        }).unwrap();
    }
}
