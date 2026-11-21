use super::*;
use sob_core::inventory_classifications::{
    Classification, ClassificationKind, ClassificationProposal, SAVE,
};
use uuid::Uuid;

struct Draft {
    entry: Classification,
    baseline: Classification,
    name: Entity<TextField>,
    order: Entity<TextField>,
    generation: String,
    conflict: Option<String>,
    needs_review: bool,
}

#[derive(Default)]
pub(super) struct Panel {
    draft: Option<Draft>,
    request: Option<Arc<()>>,
    revision: i64,
    staff_revision: i64,
    notice: Option<Key>,
    discard: bool,
}

impl Panel {
    pub(super) fn dismiss(&mut self) -> bool {
        if self.draft.is_none() {
            return true;
        }
        self.discard = !self.discard;
        false
    }
}

impl Root {
    fn classifications_panel(&mut self) -> Option<&mut Panel> {
        if let Overlay::Inventory(desk) = &mut self.overlay {
            desk.classifications.as_deref_mut()
        } else {
            None
        }
    }

    pub(super) fn open_classifications(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &mut self.overlay {
            desk.classifications = Some(Box::default());
            self.load_classifications(cx);
            cx.notify();
        }
    }

    pub(in crate::root) fn preserve_inventory_classifications(&mut self) -> bool {
        let Some(panel) = self.classifications_panel() else {
            return false;
        };
        panel.request = None;
        panel.revision = -1;
        if panel.draft.is_some() {
            panel.notice = Some(Key::InventoryClassificationsChanged);
        }
        true
    }

    pub(super) fn refresh_classifications(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let Some(panel) = self.classifications_panel() else {
            return false;
        };
        if panel.request.is_none()
            && (reconnected || panel.revision != revision || panel.staff_revision != staff)
        {
            self.load_classifications(cx);
        }
        true
    }

    fn load_classifications(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let Some(panel) = self.classifications_panel() else {
            return;
        };
        if panel.request.is_some() {
            return;
        }
        let token = Arc::new(());
        panel.request = Some(token.clone());
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.inventory_classifications() })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.classifications_panel().is_some_and(|panel| {
                        panel
                            .request
                            .as_ref()
                            .is_some_and(|request| Arc::ptr_eq(request, &token))
                    })
                {
                    return;
                }
                if matches!(
                    result,
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized)
                ) {
                    let _ = root.svc.store.withdraw_inventory_access();
                }
                let saved = root
                    .svc
                    .store
                    .staff_directory_revision()
                    .unwrap_or_default()
                    == staff
                    && result.ok().is_some_and(|catalogue| {
                        root.svc
                            .store
                            .remember_inventory_classifications(&catalogue)
                            .is_ok()
                    });
                if let Some(panel) = root.classifications_panel() {
                    panel.request = None;
                    panel.revision = revision;
                    panel.staff_revision = staff;
                    if !saved {
                        panel.notice = Some(Key::InventoryClassificationsUnavailable);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn create_classification(&mut self, kind: ClassificationKind, cx: &mut Context<Self>) {
        self.edit_classification(
            Classification {
                id: Uuid::now_v7(),
                kind,
                parent_id: None,
                name: String::new(),
                position: 0,
                active: true,
                version: 0,
            },
            None,
            cx,
        );
    }

    fn edit_classification(
        &mut self,
        entry: Classification,
        conflict: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Some(catalogue) = self.svc.store.inventory_classifications().ok().flatten() else {
            return;
        };
        let Some(panel) = self.classifications_panel() else {
            return;
        };
        let name = cx.new(|cx| TextField::new("", false, cx));
        name.update(cx, |field, cx| field.set_text(&entry.name, cx));
        let order = cx.new(|cx| TextField::new("", false, cx));
        order.update(cx, |field, cx| {
            field.set_text(&entry.position.to_string(), cx)
        });
        panel.notice = None;
        panel.draft = Some(Draft {
            baseline: entry.clone(),
            entry,
            generation: catalogue.generation,
            needs_review: conflict.is_some(),
            conflict,
            name,
            order,
        });
        cx.notify();
    }

    fn commit_classification(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.classifications_panel() else {
            return;
        };
        let Some(draft) = &panel.draft else { return };
        let mut entry = draft.entry.clone();
        entry.name = draft.name.read(cx).text().to_owned();
        let Ok(position) = draft.order.read(cx).text().trim().parse::<u32>() else {
            panel.notice = Some(Key::InventoryClassificationsInvalid);
            cx.notify();
            return;
        };
        entry.position = position;
        let generation = draft.generation.clone();
        let conflict = draft.conflict.clone();
        let result =
            self.svc
                .store
                .queue_inventory_classification(&generation, entry, conflict.as_deref());
        if let Some(panel) = self.classifications_panel() {
            panel.notice = Some(match result {
                Ok(()) => {
                    panel.draft = None;
                    Key::InventoryDocumentQueued
                }
                Err(CoreError::CatalogueEditPending) => Key::InventoryWarehousePending,
                Err(CoreError::Invalid(_)) => Key::InventoryClassificationsInvalid,
                Err(_) => Key::InventoryClassificationsChanged,
            });
        }
        if result.is_ok() {
            self.edited(cx);
        }
        cx.notify();
    }

    pub(in crate::root) fn open_classification_conflict(
        &mut self,
        id: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(row) = self
            .svc
            .store
            .conflict(id)
            .ok()
            .flatten()
            .filter(|row| row.kind == SAVE)
        else {
            return;
        };
        let Ok(proposal) = serde_json::from_value::<ClassificationProposal>(row.payload) else {
            return;
        };
        self.prepare_inventory(cx);
        self.open_classifications(cx);
        self.edit_classification(proposal.entry, Some(id.to_owned()), cx);
        if let Some(panel) = self.classifications_panel() {
            if let Some(draft) = &mut panel.draft
                && let Some(reviewed) = proposal.reviewed
            {
                draft.baseline = reviewed;
            }
            panel.notice = Some(Key::InventoryClassificationsChanged);
        }
    }

    fn review_classification(&mut self, cx: &mut Context<Self>) {
        let Some(list) = self.svc.store.inventory_classifications().ok().flatten() else {
            return;
        };
        let Some(panel) = self.classifications_panel() else {
            return;
        };
        let Some(draft) = &mut panel.draft else {
            return;
        };
        let current = list.entries.iter().find(|row| row.id == draft.entry.id);
        let already_recorded = current
            .filter(|current| {
                draft.entry.acknowledged_by(current)
                    && draft.name.read(cx).text() == draft.entry.name
                    && draft.order.read(cx).text().trim().parse::<u32>().ok()
                        == Some(draft.entry.position)
            })
            .zip(draft.conflict.clone());
        if let Some((recorded, conflict)) = already_recorded {
            if self
                .svc
                .store
                .finish_inventory_classification_review(&list.generation, &conflict, recorded)
                .is_ok()
            {
                self.reload(cx);
                if let Some(panel) = self.classifications_panel() {
                    panel.draft = None;
                    panel.notice = Some(Key::InventoryClassificationRecorded);
                }
                cx.notify();
                return;
            }
            return;
        }
        if let Some(current) = current {
            if draft.name.read(cx).text() == draft.baseline.name {
                draft
                    .name
                    .update(cx, |field, cx| field.set_text(&current.name, cx));
            }
            if draft.order.read(cx).text().trim().parse::<u32>().ok()
                == Some(draft.baseline.position)
            {
                draft.order.update(cx, |field, cx| {
                    field.set_text(&current.position.to_string(), cx)
                });
            }
            if draft.entry.parent_id == draft.baseline.parent_id {
                draft.entry.parent_id = current.parent_id;
            }
            if draft.entry.active == draft.baseline.active {
                draft.entry.active = current.active;
            }
            draft.baseline = current.clone();
        }
        draft.entry.version = current.map_or(0, |row| row.version);
        draft.generation = list.generation;
        draft.needs_review = false;
        panel.notice = None;
        cx.notify();
    }

    pub(super) fn render_classifications(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::InventoryClassifications)),
            )
            .when_some(panel.notice, |body, key| body.child(self.t(key)))
            .when(panel.request.is_some(), |body| {
                body.child(self.t(Key::InventoryLoading))
            });
        let Some(list) = self.svc.store.inventory_classifications().ok().flatten() else {
            return body
                .child(self.t(Key::InventoryClassificationsUnavailable))
                .when(panel.request.is_none(), |body| {
                    body.child(self.button(
                        "reload-classifications",
                        self.t(Key::InventoryRefresh),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.load_classifications(cx)),
                    ))
                });
        };
        let write = self.svc.store.can_queue_product_edits() && panel.request.is_none();
        if panel.discard {
            return body
                .child(self.t(Key::SalonConfirmDiscard))
                .child(self.button(
                    "discard-classification",
                    self.t(Key::SalonDiscard),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| {
                        if let Some(panel) = root.classifications_panel() {
                            panel.draft = None;
                            panel.discard = false;
                            cx.notify();
                        }
                    }),
                ));
        }
        if let Some(draft) = &panel.draft {
            let latest = list.entries.iter().find(|entry| entry.id == draft.entry.id);
            let stale = draft.needs_review
                || list.generation != draft.generation
                || latest.map_or(0, |row| row.version) != draft.entry.version;
            let parent_options = std::iter::once((
                None,
                self.t(Key::InventoryClassificationNoParent).to_owned(),
            ))
            .chain(
                list.entries
                    .iter()
                    .filter(|row| {
                        row.kind == ClassificationKind::Category
                            && row.parent_id.is_none()
                            && row.id != draft.entry.id
                            && (row.active || Some(row.id) == draft.entry.parent_id)
                    })
                    .map(|row| (Some(row.id), row.name.clone())),
            );
            return body
                .child(self.label(Key::InventoryClassificationName))
                .child(draft.name.clone())
                .child(self.label(Key::InventoryClassificationOrder))
                .child(draft.order.clone())
                .when(draft.entry.kind == ClassificationKind::Category, |body| {
                    body.child(self.label(Key::InventoryClassificationParent))
                        .child(div().flex().flex_wrap().gap_2().children(
                            parent_options.enumerate().map(|(index, (id, label))| {
                                self.button(
                                    ("classification-parent", index),
                                    label,
                                    if id == draft.entry.parent_id {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        if let Some(draft) = root
                                            .classifications_panel()
                                            .and_then(|panel| panel.draft.as_mut())
                                        {
                                            draft.entry.parent_id = id;
                                            cx.notify();
                                        }
                                    }),
                                )
                            }),
                        ))
                })
                .child(self.button(
                    "classification-active",
                    self.t(if draft.entry.active {
                        Key::InventoryWarehouseActive
                    } else {
                        Key::InventoryWarehouseArchived
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(draft) = root
                            .classifications_panel()
                            .and_then(|panel| panel.draft.as_mut())
                        {
                            draft.entry.active = !draft.entry.active;
                            cx.notify();
                        }
                    }),
                ))
                .when(write && stale, |body| {
                    body.child(self.t(Key::InventoryClassificationsChanged))
                        .when_some(latest, |body, current| {
                            body.child(format!(
                                "{} · {}",
                                current.name,
                                list.entries
                                    .iter()
                                    .find(|row| Some(row.id) == current.parent_id)
                                    .map_or_else(
                                        || self.t(Key::InventoryClassificationNoParent).to_owned(),
                                        |row| row.name.clone()
                                    )
                            ))
                        })
                        .child(self.button(
                            "classification-review",
                            self.t(Key::InventoryDocumentReviewed),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.review_classification(cx)),
                        ))
                })
                .when(write && !stale, |body| {
                    body.child(self.button(
                        "classification-save",
                        self.t(Key::InventoryWarehouseSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.commit_classification(cx)),
                    ))
                });
        }
        let mut rows = Vec::new();
        for root in list
            .entries
            .iter()
            .filter(|entry| entry.parent_id.is_none())
        {
            rows.push((root.name.clone(), root.clone()));
            rows.extend(
                list.entries
                    .iter()
                    .filter(|row| row.parent_id == Some(root.id))
                    .map(|row| (format!("{} / {}", root.name, row.name), row.clone())),
            );
        }
        body.when(write, |body| {
            body.child(
                div()
                    .flex()
                    .gap_2()
                    .flex_wrap()
                    .child(self.button(
                        "new-category",
                        self.t(Key::InventoryClassificationNewCategory),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            root.create_classification(ClassificationKind::Category, cx)
                        }),
                    ))
                    .child(self.button(
                        "new-brand",
                        self.t(Key::InventoryClassificationNewBrand),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.create_classification(ClassificationKind::Brand, cx)
                        }),
                    )),
            )
        })
        .children(
            self.svc
                .store
                .pending_inventory_classifications()
                .unwrap_or_default()
                .into_iter()
                .map(|row| {
                    div().text_sm().child(format!(
                        "{} · {}",
                        row.name,
                        self.t(Key::InventoryDocumentQueued)
                    ))
                }),
        )
        .children(rows.into_iter().enumerate().map(|(index, (name, entry))| {
            div()
                .flex()
                .justify_between()
                .items_center()
                .gap_2()
                .child(name)
                .when(!entry.active, |row| {
                    row.child(self.t(Key::InventoryWarehouseArchived))
                })
                .when(write, |row| {
                    row.child(self.button(
                        ("classification-edit", index),
                        self.t(Key::InventoryClassificationEdit),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.edit_classification(entry.clone(), None, cx)
                        }),
                    ))
                })
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use sob_core::inventory_classifications::ClassificationCatalogue;

    #[gpui::test]
    async fn an_offline_classification_editor_keeps_the_draft_in_the_outbox(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let generation = root.svc.store.verified_reviewed_generation().unwrap();
                root.svc
                    .store
                    .set_meta("inventory_write_access", &generation)
                    .unwrap();
                root.svc
                    .store
                    .remember_inventory_classifications(&ClassificationCatalogue {
                        generation,
                        entries: vec![],
                    })
                    .unwrap();
                root.prepare_inventory(cx);
                root.open_classifications(cx);
                root.create_classification(ClassificationKind::Brand, cx);
                let draft = root
                    .classifications_panel()
                    .unwrap()
                    .draft
                    .as_ref()
                    .unwrap();
                draft
                    .name
                    .update(cx, |input, cx| input.set_text("Local brand", cx));
                root.commit_classification(cx);
                assert!(root.classifications_panel().unwrap().draft.is_none());
                let queued = root.svc.store.pending_inventory_classifications().unwrap();
                assert_eq!(queued.len(), 1);
                assert_eq!(queued[0].name, "Local brand");
                root.svc.store.withdraw_inventory_access().unwrap();
                assert!(
                    root.svc
                        .store
                        .inventory_classifications()
                        .unwrap()
                        .is_none()
                );
                assert!(
                    root.svc
                        .store
                        .pending_inventory_classifications()
                        .unwrap()
                        .is_empty()
                );
            })
            .unwrap();
    }
}
