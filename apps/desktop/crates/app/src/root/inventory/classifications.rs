use super::*;
use sob_core::inventory_classifications::{
    Classification, ClassificationCatalogue, ClassificationKind, ClassificationOrder,
    ClassificationProposal, REORDER, SAVE,
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
    notice: Option<Key>,
    discard: bool,
    handles: std::cell::RefCell<HashMap<Uuid, gpui::FocusHandle>>,
    order_conflict: Option<(String, Uuid, ClassificationOrder)>,
}

#[derive(Clone)]
struct ClassificationDrag {
    catalogue: Arc<ClassificationCatalogue>,
    source: Uuid,
    kind: ClassificationKind,
    parent: Option<Uuid>,
    label: String,
}

struct ClassificationDragLabel(String);

impl Render for ClassificationDragLabel {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_3()
            .py_2()
            .rounded_md()
            .bg(theme::accent_soft())
            .child(self.0.clone())
    }
}

#[derive(Default)]
pub(super) struct Load {
    request: Option<Arc<()>>,
    observed: Option<(i64, i64)>,
    current: bool,
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

    fn classification_load(&mut self) -> Option<&mut Load> {
        if let Overlay::Inventory(desk) = &mut self.overlay {
            Some(&mut desk.classification_load)
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
        if panel.draft.is_some() {
            panel.notice = Some(Key::InventoryClassificationsChanged);
        }
        if let Some(load) = self.classification_load() {
            *load = Load::default();
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
        if self.classification_load().is_some_and(|load| {
            load.request.is_none() && (reconnected || load.observed != Some((revision, staff)))
        }) {
            self.load_classifications(cx);
        }
        self.classifications_panel().is_some()
    }

    pub(super) fn load_classifications(&mut self, cx: &mut Context<Self>) {
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
        let Some(load) = self.classification_load() else {
            return;
        };
        if load.request.is_some() {
            return;
        }
        let token = Arc::new(());
        load.request = Some(token.clone());
        load.current = false;
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.inventory_classifications() })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.classification_load().is_some_and(|load| {
                        load.request
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
                let current = root
                    .svc
                    .store
                    .staff_directory_revision()
                    .unwrap_or_default()
                    == staff
                    && root
                        .svc
                        .store
                        .live_view_revision(LIVE_TOPIC)
                        .unwrap_or_default()
                        == revision;
                let saved = current
                    && result.ok().is_some_and(|catalogue| {
                        root.svc
                            .store
                            .remember_inventory_classifications(&catalogue)
                            .is_ok()
                    });
                if let Some(load) = root.classification_load() {
                    load.request = None;
                    load.observed = Some((revision, staff));
                    load.current = saved;
                }
                if current
                    && !saved
                    && let Some(panel) = root.classifications_panel()
                {
                    panel.notice = Some(Key::InventoryClassificationsUnavailable);
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
        let generation = if conflict.is_some() {
            self.svc.store.verified_reviewed_generation().ok()
        } else {
            self.svc
                .store
                .inventory_classifications()
                .ok()
                .flatten()
                .map(|catalogue| catalogue.generation)
        };
        let Some(generation) = generation else {
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
            generation,
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
        if !self.classification_load().is_some_and(|load| load.current)
            || !self.svc.store.can_queue_product_edits()
        {
            return;
        }
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

    pub(in crate::root) fn open_classification_order_conflict(
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
            .filter(|row| row.kind == REORDER)
        else {
            return;
        };
        let Ok(source) = Uuid::parse_str(&row.entity_id) else {
            return;
        };
        let Ok(order) = serde_json::from_value::<ClassificationOrder>(row.payload) else {
            return;
        };
        self.prepare_inventory(cx);
        self.open_classifications(cx);
        if let Some(panel) = self.classifications_panel() {
            panel.order_conflict = Some((id.to_owned(), source, order));
            panel.notice = Some(Key::InventoryClassificationOrderChanged);
        }
    }

    fn move_classification(
        &mut self,
        catalogue: &ClassificationCatalogue,
        source: Uuid,
        target: Uuid,
        after: bool,
        replaces: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let Some(order) = catalogue
            .reviewed_order(source)
            .and_then(|group| group.move_to(source, target, after))
        else {
            return;
        };
        let result =
            self.svc
                .store
                .queue_inventory_order(&catalogue.generation, source, &order, replaces);
        if let Some(panel) = self.classifications_panel() {
            panel.notice = Some(match result {
                Ok(()) => {
                    panel.order_conflict = None;
                    Key::InventoryDocumentQueued
                }
                Err(CoreError::CatalogueEditPending) => Key::InventoryWarehousePending,
                Err(_) => Key::InventoryClassificationOrderChanged,
            });
        }
        if result.is_ok() {
            self.edited(cx);
        } else {
            self.load_classifications(cx);
        }
        cx.notify();
    }

    fn render_classification_controls(
        &self,
        panel: &Panel,
        catalogue: &Arc<ClassificationCatalogue>,
        entry: &Classification,
        neighbors: (Option<Uuid>, Option<Uuid>),
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let (previous, next) = neighbors;
        let source = entry.id;
        let focus = panel
            .handles
            .borrow_mut()
            .entry(source)
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        let drag = ClassificationDrag {
            catalogue: catalogue.clone(),
            source,
            kind: entry.kind,
            parent: entry.parent_id,
            label: entry.name.clone(),
        };
        let keys = catalogue.clone();
        let handle = div()
            .id(SharedString::from(format!(
                "classification-handle-{source}"
            )))
            .debug_selector(move || format!("classification-handle-{source}"))
            .track_focus(&focus)
            .cursor_grab()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .focus(|style| style.border_color(theme::accent()))
            .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
                focus.focus(window)
            })
            .on_key_down(
                cx.listener(move |root, event: &gpui::KeyDownEvent, window, cx| {
                    let key = &event.keystroke;
                    if key.key == "escape" && cx.stop_active_drag(window) {
                        cx.stop_propagation();
                        return;
                    }
                    if enabled && key.modifiers.alt && (key.key == "up" || key.key == "down") {
                        let after = key.key == "down";
                        if let Some(target) = if after { next } else { previous } {
                            root.move_classification(&keys, source, target, after, None, cx);
                        }
                        cx.stop_propagation();
                    }
                }),
            )
            .when(enabled, |handle| {
                handle.on_drag(drag, |payload, _, _, cx| {
                    cx.new(|_| ClassificationDragLabel(payload.label.clone()))
                })
            })
            .child("⠿");
        div().flex().items_center().gap_1().child(handle).children(
            [
                (previous, false, Key::InventoryClassificationMoveUp),
                (next, true, Key::InventoryClassificationMoveDown),
            ]
            .into_iter()
            .filter_map(|(target, after, key)| {
                let id = target.filter(|_| enabled)?;
                let catalogue = catalogue.clone();
                Some(self.button(
                    SharedString::from(format!("classification-{source}-{after}")),
                    self.t(key),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.move_classification(&catalogue, source, id, after, None, cx)
                    }),
                ))
            }),
        )
    }

    pub(super) fn render_classifications(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let (loading, current) = match &self.overlay {
            Overlay::Inventory(desk) => (
                desk.classification_load.request.is_some(),
                desk.classification_load.current,
            ),
            _ => (false, false),
        };
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
            .when(loading, |body| body.child(self.t(Key::InventoryLoading)));
        let Some(mut list) = self.svc.store.inventory_classifications().ok().flatten() else {
            return body
                .child(self.t(Key::InventoryClassificationsUnavailable))
                .when(!loading, |body| {
                    body.child(self.button(
                        "reload-classifications",
                        self.t(Key::InventoryRefresh),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.load_classifications(cx)),
                    ))
                });
        };
        let editable = self.svc.store.can_queue_product_edits();
        let write = editable && !loading;
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
                                "{} · {} · {} · {}",
                                current.name,
                                current.position,
                                self.t(if current.active {
                                    Key::InventoryWarehouseActive
                                } else {
                                    Key::InventoryWarehouseArchived
                                }),
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
                            self.t(if current {
                                Key::InventoryDocumentReviewed
                            } else {
                                Key::InventoryRefresh
                            }),
                            Kind::Primary,
                            cx.listener(move |root, _, _, cx| {
                                if current {
                                    root.review_classification(cx);
                                } else {
                                    root.load_classifications(cx);
                                }
                            }),
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
        let pending_orders = self
            .svc
            .store
            .pending_inventory_orders()
            .unwrap_or_default();
        for order in &pending_orders {
            list.apply_reviewed_order(order);
        }
        let pending_entries = self
            .svc
            .store
            .pending_inventory_classifications()
            .unwrap_or_default();
        let ordering = write && pending_entries.is_empty() && panel.order_conflict.is_none();
        let list = Arc::new(list);
        let body = body
            .when(ordering && list.entries.len() > 1, |body| {
                body.child(self.t(Key::InventoryClassificationOrderHelp))
            })
            .when(!pending_orders.is_empty(), |body| {
                body.child(self.t(Key::InventoryClassificationOrderQueued))
            })
            .when_some(
                panel.order_conflict.as_ref(),
                |body, (id, source, previous)| {
                    let source = *source;
                    let target = previous.reference(source);
                    let reviewed = list.reviewed_order(source);
                    let action = target.and_then(|(target, after)| {
                        reviewed
                            .as_ref()?
                            .move_to(source, target, after)
                            .map(|_| (target, after))
                    });
                    let described = target.and_then(|(target, after)| {
                        let name = list
                            .entries
                            .iter()
                            .find(|entry| entry.id == source)?
                            .name
                            .clone();
                        let reference = list
                            .entries
                            .iter()
                            .find(|entry| entry.id == target)?
                            .name
                            .clone();
                        Some(format!(
                            "{name} · {} · {reference}",
                            self.t(if after {
                                Key::InventoryClassificationAfter
                            } else {
                                Key::InventoryClassificationBefore
                            })
                        ))
                    });
                    body.when_some(described, |body, text| body.child(text))
                        .when_some(
                            action.filter(|_| {
                                current
                                    && write
                                    && !pending_orders.iter().any(|order| {
                                        reviewed.as_ref().is_some_and(|reviewed| {
                                            order.kind == reviewed.kind
                                                && order.parent_id == reviewed.parent_id
                                        })
                                    })
                                    && pending_entries.is_empty()
                            }),
                            |body, (target, after)| {
                                let id = id.clone();
                                let list = list.clone();
                                body.child(self.button(
                                    "classification-order-review",
                                    self.t(Key::InventoryClassificationReapplyOrder),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.move_classification(
                                            &list,
                                            source,
                                            target,
                                            after,
                                            Some(&id),
                                            cx,
                                        )
                                    }),
                                ))
                            },
                        )
                },
            );
        let mut by_group: HashMap<_, Vec<&Classification>> = HashMap::new();
        for row in &list.entries {
            by_group
                .entry((row.kind, row.parent_id))
                .or_default()
                .push(row);
        }
        let neighbors: HashMap<_, _> = by_group
            .values()
            .flat_map(|group| {
                group.iter().enumerate().map(|(index, row)| {
                    let previous = index
                        .checked_sub(1)
                        .and_then(|index| group.get(index))
                        .map(|row| row.id);
                    let next = group.get(index + 1).map(|row| row.id);
                    (row.id, (previous, next))
                })
            })
            .collect();

        let mut rows = Vec::new();
        for root in list
            .entries
            .iter()
            .filter(|entry| entry.parent_id.is_none())
        {
            rows.push((root.name.clone(), root.clone()));
            rows.extend(
                by_group
                    .get(&(ClassificationKind::Category, Some(root.id)))
                    .into_iter()
                    .flatten()
                    .map(|row| (format!("{} / {}", root.name, row.name), (*row).clone())),
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
        .children(pending_entries.into_iter().map(|row| {
            div().text_sm().child(format!(
                "{} · {}",
                row.name,
                self.t(Key::InventoryDocumentQueued)
            ))
        }))
        .children(rows.iter().enumerate().map(|(index, (name, entry))| {
            let entry = entry.clone();
            let id = entry.id;
            let kind = entry.kind;
            let parent = entry.parent_id;
            let (previous, next) = neighbors.get(&id).copied().unwrap_or_default();
            let group_pending = pending_orders
                .iter()
                .any(|order| order.matches_group(&entry));
            let write = write && !group_pending;
            let ordering = ordering && !group_pending;
            div()
                .id(SharedString::from(format!("classification-row-{id}")))
                .debug_selector(move || format!("classification-row-{id}"))
                .flex()
                .justify_between()
                .items_center()
                .gap_2()
                .child(name.clone())
                .when(
                    self.svc.store.can_queue_product_edits()
                        && (previous.is_some() || next.is_some()),
                    |row| {
                        row.child(self.render_classification_controls(
                            panel,
                            &list,
                            &entry,
                            (previous, next),
                            ordering,
                            cx,
                        ))
                    },
                )
                .when(ordering, |row| {
                    row.can_drop(move |payload, _, _| {
                        payload
                            .downcast_ref::<ClassificationDrag>()
                            .is_some_and(|drag| {
                                drag.source != id && drag.kind == kind && drag.parent == parent
                            })
                    })
                    .drag_over::<ClassificationDrag>(move |style, payload, _, _| {
                        if payload.source != id && payload.kind == kind && payload.parent == parent
                        {
                            style.bg(theme::accent_soft())
                        } else {
                            style
                        }
                    })
                    .on_drop(cx.listener(
                        move |root, drag: &ClassificationDrag, _, cx| {
                            if let Some(reviewed) = drag.catalogue.reviewed_order(drag.source) {
                                let after = reviewed
                                    .entries
                                    .iter()
                                    .find(|row| row.id == drag.source || row.id == id)
                                    .is_some_and(|row| row.id == drag.source);
                                root.move_classification(
                                    &drag.catalogue,
                                    drag.source,
                                    id,
                                    after,
                                    None,
                                    cx,
                                );
                            }
                        },
                    ))
                })
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
    async fn dragging_a_classification_enqueues_the_reviewed_order_offline(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let first = Uuid::from_u128(11);
        let second = Uuid::from_u128(12);
        let brand_first = Uuid::from_u128(13);
        let brand_second = Uuid::from_u128(14);
        root.update(cx, |root, cx| {
            let generation = root.svc.store.verified_reviewed_generation().unwrap();
            root.svc
                .store
                .set_meta("inventory_write_access", &generation)
                .unwrap();
            root.svc
                .store
                .remember_inventory_classifications(&ClassificationCatalogue {
                    generation,
                    entries: [first, second, brand_first, brand_second]
                        .into_iter()
                        .enumerate()
                        .map(|(index, id)| Classification {
                            id,
                            kind: if index < 2 {
                                ClassificationKind::Category
                            } else {
                                ClassificationKind::Brand
                            },
                            parent_id: None,
                            name: format!("Category {index}"),
                            position: index as u32,
                            active: true,
                            version: 1,
                        })
                        .collect(),
                })
                .unwrap();
            root.prepare_inventory(cx);
            root.open_classifications(cx);
        });
        cx.run_until_parked();
        let start = cx
            .debug_bounds("classification-handle-00000000-0000-0000-0000-00000000000b")
            .unwrap()
            .center();
        let end = cx
            .debug_bounds("classification-row-00000000-0000-0000-0000-00000000000c")
            .unwrap()
            .center();
        cx.simulate_mouse_down(start, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_move(end, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        cx.simulate_mouse_up(end, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        let keyboard = cx
            .debug_bounds("classification-handle-00000000-0000-0000-0000-00000000000d")
            .unwrap();
        cx.simulate_click(keyboard.center(), Default::default());
        cx.simulate_keystrokes("alt-down");
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let pending = root.svc.store.pending_inventory_orders().unwrap();
            assert_eq!(pending.len(), 2);
            let order = &pending[0];
            assert_eq!(
                order
                    .entries
                    .iter()
                    .map(|entry| entry.id)
                    .collect::<Vec<_>>(),
                [second, first]
            );
            assert_eq!(
                pending[1]
                    .entries
                    .iter()
                    .map(|entry| entry.id)
                    .collect::<Vec<_>>(),
                [brand_second, brand_first]
            );
            let original = root.svc.store.inventory_classifications().unwrap().unwrap();
            assert_eq!(original.entries[0].id, first);
        });
    }

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
