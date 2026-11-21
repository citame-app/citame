use super::*;
use sob_core::resource_pools::{
    CREATE, ManagedPool, PendingPool, PoolCatalogue, PoolDraft, QueuedPool, ResourceKind, UPDATE,
};

pub(super) struct Desk {
    catalogue: Option<PoolCatalogue>,
    pending: Vec<QueuedPool>,
    data_version: Option<i64>,
    editor: Option<Editor>,
    confirm_close: bool,
    notice: Option<Key>,
}

struct Editor {
    id: String,
    generation: String,
    baseline: Option<ManagedPool>,
    original: PoolDraft,
    name: Entity<TextField>,
    capacity: Entity<TextField>,
    kind: ResourceKind,
    active: bool,
    recovery: Option<Recovery>,
}

struct Recovery {
    mutation_id: String,
    minimum_version: Option<u64>,
    needs_review: bool,
    restored: bool,
}

impl Editor {
    fn draft(&self, cx: &App) -> Option<PoolDraft> {
        Some(PoolDraft {
            name: PoolDraft::normalized_name(self.name.read(cx).text()).to_owned(),
            capacity: self.capacity.read(cx).text().trim().parse().ok()?,
            kind: self.kind,
            active: self.active,
        })
    }

    fn dirty(&self, cx: &App) -> bool {
        self.draft(cx).as_ref() != Some(&self.original)
    }

    fn set(&mut self, draft: PoolDraft, cx: &mut Context<Root>) {
        self.name
            .update(cx, |field, cx| field.set_text(&draft.name, cx));
        self.capacity.update(cx, |field, cx| {
            field.set_text(&draft.capacity.to_string(), cx)
        });
        self.kind = draft.kind;
        self.active = draft.active;
    }

    fn current<'a>(&self, catalogue: &'a PoolCatalogue) -> Option<&'a ManagedPool> {
        catalogue.pools.iter().find(|pool| pool.id == self.id)
    }

    fn requires_review(&self, catalogue: Option<&PoolCatalogue>) -> bool {
        self.recovery.as_ref().is_some_and(|row| row.needs_review)
            || catalogue.is_none_or(|view| {
                self.generation != view.generation || self.current(view) != self.baseline.as_ref()
            })
    }

    fn can_review(&self, catalogue: &PoolCatalogue) -> bool {
        let current = self.current(catalogue);
        (current.is_some() == self.baseline.is_some()
            || self.recovery.as_ref().is_some_and(|row| row.restored))
            && self
                .recovery
                .as_ref()
                .and_then(|row| row.minimum_version)
                .is_none_or(|version| current.is_some_and(|pool| pool.version > version))
    }
}

impl Root {
    pub(super) fn open_resource_pools(
        &mut self,
        conflict_id: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let recovered = conflict_id.and_then(|id| {
            let conflict = self.svc.store.conflict(id).ok().flatten()?;
            if !matches!(conflict.kind.as_str(), CREATE | UPDATE) {
                return None;
            }
            let restored = conflict.requires_restored_review();
            let edit: PendingPool = serde_json::from_value(conflict.payload).ok()?;
            Some((edit, conflict.reason == "conflict", restored))
        });
        if conflict_id.is_some() && recovered.is_none() {
            return;
        }
        self.overlay = Overlay::ResourcePools(Box::new(Desk {
            catalogue: self.svc.store.managed_resource_pools().ok().flatten(),
            pending: self.svc.store.pending_resource_pools().unwrap_or_default(),
            data_version: self.data_version,
            editor: None,
            confirm_close: false,
            notice: None,
        }));
        if let Some(((edit, version_conflict, restored), mutation_id)) = recovered.zip(conflict_id)
        {
            let baseline = edit
                .reviewed
                .clone()
                .zip(edit.version)
                .map(|(settings, version)| ManagedPool {
                    id: edit.id.clone(),
                    version,
                    settings,
                });
            let recovery = Recovery {
                mutation_id: mutation_id.into(),
                minimum_version: edit.version.filter(|_| version_conflict),
                needs_review: true,
                restored,
            };
            self.begin_pool_editor(edit.id, baseline, edit.proposed, Some(recovery), cx);
        }
        cx.notify();
    }

    pub(super) fn preserve_open_resource_pools(&mut self, generation: Option<&str>) -> bool {
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return false;
        };
        desk.catalogue = None;
        desk.data_version = None;
        if let Some(editor) = &mut desk.editor
            && generation != Some(editor.generation.as_str())
            && let Some(recovery) = &mut editor.recovery
        {
            recovery.minimum_version = None;
            recovery.needs_review = true;
            recovery.restored = true;
        }
        true
    }

    pub(super) fn refresh_resource_pools(&mut self, cx: &mut Context<Self>) {
        let allowed = self.can_create_catalogue_item();
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return;
        };
        if desk.data_version == self.data_version {
            return;
        }
        let (Ok(catalogue), Ok(pending)) = (
            self.svc.store.managed_resource_pools(),
            self.svc.store.pending_resource_pools(),
        ) else {
            return;
        };
        desk.data_version = self.data_version;
        desk.catalogue = if allowed { catalogue } else { None };
        desk.pending = pending;
        if let Some(editor) = &mut desk.editor
            && let Some(view) = &desk.catalogue
            && editor.recovery.is_none()
            && !editor.dirty(cx)
            && editor.can_review(view)
        {
            let current = editor.current(view).cloned();
            editor.generation = view.generation.clone();
            if let Some(pool) = &current {
                editor.original = pool.settings.clone();
                editor.set(pool.settings.clone(), cx);
            }
            editor.baseline = current;
        }
        cx.notify();
    }

    fn choose_pool(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ResourcePools(desk) = &self.overlay else {
            return;
        };
        let Some(view) = &desk.catalogue else { return };
        let baseline = id
            .and_then(|id| view.pools.iter().find(|pool| pool.id == id))
            .cloned();
        if id.is_some() && baseline.is_none() {
            return;
        }
        let id = id.map_or_else(|| uuid::Uuid::now_v7().to_string(), str::to_owned);
        let draft = baseline
            .as_ref()
            .map(|pool| pool.settings.clone())
            .unwrap_or_default();
        self.begin_pool_editor(id, baseline, draft, None, cx);
    }

    fn begin_pool_editor(
        &mut self,
        id: String,
        baseline: Option<ManagedPool>,
        draft: PoolDraft,
        recovery: Option<Recovery>,
        cx: &mut Context<Self>,
    ) {
        let name_label = self.t(Key::PoolName);
        let capacity_label = self.t(Key::PoolCapacity);
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return;
        };
        if desk.pending.iter().any(|row| row.edit.id == id) {
            return;
        }
        let name = cx.new(|cx| {
            let mut field = TextField::new(name_label, false, cx);
            field.set_text(&draft.name, cx);
            field
        });
        let capacity = cx.new(|cx| {
            let mut field = TextField::new(capacity_label, false, cx);
            field.set_text(&draft.capacity.to_string(), cx);
            field
        });
        cx.observe(&name, |_, _, cx| cx.notify()).detach();
        cx.observe(&capacity, |_, _, cx| cx.notify()).detach();
        let original = baseline
            .as_ref()
            .map(|pool| pool.settings.clone())
            .unwrap_or_default();
        desk.editor = Some(Editor {
            id,
            baseline,
            original,
            generation: desk
                .catalogue
                .as_ref()
                .map(|view| view.generation.clone())
                .unwrap_or_default(),
            name,
            capacity,
            kind: draft.kind,
            active: draft.active,
            recovery,
        });
        desk.notice = None;
        cx.notify();
    }

    fn review_pool(&mut self, keep: bool, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return;
        };
        let (Some(view), Some(editor)) = (&desk.catalogue, &mut desk.editor) else {
            return;
        };
        if !editor.can_review(view) {
            return;
        }
        let Some(proposed) = editor.draft(cx) else {
            desk.notice = Some(Key::PoolInvalid);
            cx.notify();
            return;
        };
        let latest = editor.current(view).cloned();
        let original = latest
            .as_ref()
            .map(|pool| pool.settings.clone())
            .unwrap_or_default();
        let reviewed = if editor.baseline.is_some() && latest.is_none() {
            PoolDraft {
                active: true,
                ..proposed
            }
        } else {
            proposed.rebase(&editor.original, &original, keep)
        };
        editor.generation = view.generation.clone();
        editor.baseline = latest;
        editor.original = original;
        editor.set(reviewed, cx);
        if let Some(recovery) = &mut editor.recovery {
            recovery.needs_review = false;
        }
        desk.notice = None;
        cx.notify();
    }

    fn save_pool(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if editor.requires_review(desk.catalogue.as_ref()) || desk.confirm_close {
            return;
        }
        let Some(proposed) = editor.draft(cx) else {
            desk.notice = Some(Key::PoolInvalid);
            cx.notify();
            return;
        };
        let replaces = editor.recovery.as_ref().map(|row| row.mutation_id.as_str());
        match self.svc.store.queue_resource_pool(
            &editor.generation,
            &editor.id,
            editor.baseline.as_ref(),
            proposed,
            replaces,
        ) {
            Ok(queued) => {
                desk.pending = self.svc.store.pending_resource_pools().unwrap_or_default();
                desk.editor = None;
                desk.notice = Some(if queued {
                    Key::CatalogPending
                } else {
                    Key::CatalogSaved
                });
                self.edited(cx);
            }
            Err(
                sob_core::error::CoreError::CatalogueVersionChanged
                | sob_core::error::CoreError::CalendarGenerationChanged,
            ) => {
                desk.catalogue = self.svc.store.managed_resource_pools().ok().flatten();
                desk.notice = Some(Key::CatalogChanged);
                cx.notify();
            }
            Err(_) => {
                desk.notice = Some(Key::PoolInvalid);
                cx.notify();
            }
        }
    }

    pub(super) fn close_resource_pools(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            self.open_web_management(cx);
            return;
        }
        let Overlay::ResourcePools(desk) = &mut self.overlay else {
            return;
        };
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
            desk.confirm_close = true;
        } else if desk.editor.is_some() {
            desk.editor = None;
        } else {
            self.open_web_management(cx);
        }
        cx.notify();
    }

    pub(super) fn render_resource_pools(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let allowed = self.can_create_catalogue_item();
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
                            .child(self.t(Key::PoolManagement)),
                    )
                    .child(self.button(
                        "pools-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_resource_pools(cx)),
                    )),
            )
            .when(!allowed, |view| view.child(self.t(Key::CatalogAccessLost)))
            .when(
                allowed && self.status.connectivity != Connectivity::Online,
                |view| view.child(self.t(Key::CatalogOffline)),
            )
            .when_some(desk.notice, |view, key| {
                view.child(div().text_sm().child(self.t(key)))
            })
            .when(desk.confirm_close, |view| {
                view.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "pools-discard",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::ResourcePools(desk) = &mut root.overlay {
                                desk.confirm_close = false;
                                desk.editor = None;
                            }
                            cx.notify();
                        }),
                    ))
            })
            .when(allowed && !desk.confirm_close, |view| {
                if let Some(editor) = &desk.editor {
                    return view.child(self.render_pool_editor(desk, editor, cx));
                }
                view.when(desk.catalogue.is_none(), |view| {
                    view.child(self.t(Key::ResourceNeedsSync))
                })
                .when_some(desk.catalogue.as_ref(), |view, catalogue| {
                    view.child(self.button(
                        "pool-new",
                        self.t(Key::PoolNew),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.choose_pool(None, cx)),
                    ))
                    .child(
                        div()
                            .id("managed-resource-pools")
                            .min_h_0()
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .children(desk.pending.iter().map(|row| {
                                div().text_sm().child(format!(
                                    "{} · {}",
                                    self.pool_summary(&row.edit.proposed),
                                    self.t(Key::CatalogPending)
                                ))
                            }))
                            .children(
                                catalogue
                                    .pools
                                    .iter()
                                    .filter(|pool| {
                                        !desk.pending.iter().any(|row| row.edit.id == pool.id)
                                    })
                                    .map(|pool| {
                                        let id = pool.id.clone();
                                        self.button(
                                            SharedString::from(format!("managed-pool-{id}")),
                                            self.pool_summary(&pool.settings),
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.choose_pool(Some(&id), cx)
                                            }),
                                        )
                                    }),
                            ),
                    )
                })
            });
        self.modal_with_height(
            content,
            (viewport.width - px(32.)).max(px(270.)).min(px(560.)),
            (viewport.height - px(32.)).max(px(240.)).min(px(620.)),
            Some(cx),
        )
    }

    fn pool_summary(&self, draft: &PoolDraft) -> String {
        format!(
            "{} · {} · {} · {}",
            draft.name,
            self.t(kind_label(draft.kind)),
            draft.capacity,
            self.t(if draft.active {
                Key::CatalogActive
            } else {
                Key::StaffPortraitInactive
            })
        )
    }

    fn render_pool_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let view = div()
            .id("resource-pool-editor")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2();
        let needs_review = editor.requires_review(desk.catalogue.as_ref());
        let view = view.when(needs_review, |view| {
            let current = desk
                .catalogue
                .as_ref()
                .and_then(|catalogue| editor.current(catalogue));
            let can_review = desk
                .catalogue
                .as_ref()
                .is_some_and(|catalogue| editor.can_review(catalogue));
            let proposed = editor.draft(cx);
            let restored_new = editor.baseline.is_some() && current.is_none() && can_review;
            let restored_existing = editor.baseline.is_none() && current.is_some() && can_review;
            let overlaps = proposed
                .as_ref()
                .zip(current)
                .is_some_and(|(draft, pool)| draft.overlaps(&editor.original, &pool.settings));
            view.child(self.t(Key::CatalogChanged))
                .when_some(proposed, |view, draft| {
                    view.child(self.pool_summary(&draft))
                })
                .when_some(current, |view, pool| {
                    view.child(format!(
                        "{} {}",
                        self.t(Key::CatalogCurrent),
                        self.pool_summary(&pool.settings)
                    ))
                })
                .when(!can_review, |view| {
                    view.child(self.t(Key::ResourceNeedsSync))
                })
                .when(can_review, |view| {
                    view.child(self.button(
                        "pool-review",
                        self.t(if restored_new {
                            Key::PoolRestoreNew
                        } else if restored_existing {
                            Key::PoolRestoreExisting
                        } else if overlaps {
                            Key::CatalogKeepDraftGroups
                        } else {
                            Key::CatalogReview
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.review_pool(true, cx)),
                    ))
                    .when(overlaps, |view| {
                        view.child(self.button(
                            "pool-review-cloud",
                            self.t(Key::CatalogKeepCloudGroups),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.review_pool(false, cx)),
                        ))
                    })
                })
        });
        view.child(div().text_sm().child(self.t(Key::PoolName)))
            .child(editor.name.clone())
            .child(div().text_sm().child(self.t(Key::PoolCapacity)))
            .child(editor.capacity.clone())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(ResourceKind::ALL.into_iter().map(|kind| {
                        self.button(
                            ("pool-kind", kind as usize),
                            self.t(kind_label(kind)),
                            if editor.kind == kind {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::ResourcePools(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                {
                                    editor.kind = kind;
                                }
                                cx.notify();
                            }),
                        )
                    })),
            )
            .when(editor.baseline.is_some(), |view| {
                view.child(self.button(
                    "pool-active",
                    self.t(if editor.active {
                        Key::PoolDeactivate
                    } else {
                        Key::PoolActivate
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::ResourcePools(desk) = &mut root.overlay
                            && let Some(editor) = &mut desk.editor
                        {
                            editor.active = !editor.active;
                        }
                        cx.notify();
                    }),
                ))
            })
            .when(
                !needs_review && (editor.dirty(cx) || editor.recovery.is_some()),
                |view| {
                    view.child(self.button(
                        "pool-save",
                        self.t(Key::SaveServiceAnnotations),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_pool(cx)),
                    ))
                },
            )
    }
}

fn kind_label(kind: ResourceKind) -> Key {
    match kind {
        ResourceKind::Room => Key::PoolRoom,
        ResourceKind::Equipment => Key::PoolEquipment,
        ResourceKind::Station => Key::PoolStation,
        ResourceKind::Other => Key::PoolOther,
    }
}
