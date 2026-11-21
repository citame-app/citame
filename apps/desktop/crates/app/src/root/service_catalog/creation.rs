use super::*;
use sob_core::http::{NewCatalogService, ServiceCreation, ServiceOption};
use sob_core::store::SERVICE_CREATION_KIND;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Eq, PartialEq)]
enum KindChoice {
    Standalone,
    Variant,
    Addon,
}

impl KindChoice {
    const ALL: [Self; 3] = [Self::Standalone, Self::Variant, Self::Addon];

    fn label(self) -> Key {
        match self {
            Self::Standalone => Key::CatalogStandalone,
            Self::Variant => Key::CatalogVariant,
            Self::Addon => Key::CatalogAddon,
        }
    }
}

pub(super) struct Draft {
    choice: KindChoice,
    staff: BTreeSet<String>,
    targets: BTreeSet<String>,
    label: Entity<TextField>,
    target_search: Entity<TextField>,
    replaces: Option<String>,
    staff_edited: bool,
    needs_restore_review: bool,
}

impl Draft {
    pub(super) fn dirty(&self, cx: &App) -> bool {
        self.replaces.is_some()
            || self.choice != KindChoice::Standalone
            || !self.staff.is_empty()
            || !self.targets.is_empty()
            || !self.label.read(cx).text().is_empty()
    }

    fn option(&self, cx: &App) -> Option<Option<ServiceOption>> {
        match self.choice {
            KindChoice::Standalone => Some(None),
            KindChoice::Variant => {
                let label = self.label.read(cx).text().trim();
                if label.is_empty() || label.encode_utf16().count() > 80 {
                    return None;
                }
                Some(Some(ServiceOption::Variant {
                    parent_service_id: self.targets.first()?.clone(),
                    option_label: label.into(),
                }))
            }
            KindChoice::Addon => {
                (!self.targets.is_empty() && self.targets.len() <= 100).then(|| {
                    Some(ServiceOption::Addon {
                        allowed_service_ids: self.targets.clone(),
                    })
                })
            }
        }
    }
}

fn empty_details(currency: String) -> ServiceDetails {
    ServiceDetails {
        name: String::new(),
        description: None,
        category: None,
        color: None,
        sort_order: 0,
        duration_minutes: 30,
        buffer_minutes: 0,
        processing: None,
        booking_interval_minutes: None,
        client_instructions: None,
        price_type: CatalogPrice::Fixed,
        price_cents: 0,
        currency,
        online_booking: true,
        active: true,
    }
}

impl Root {
    pub(in crate::root) fn can_create_catalogue_item(&self) -> bool {
        self.can_configure_salon() || self.svc.store.cached_catalogue_access()
    }

    pub(in crate::root) fn open_catalog_creation(
        &mut self,
        conflict_id: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let recovered = match conflict_id {
            Some(id) => {
                let Ok(Some(conflict)) = self.svc.store.conflict(id) else {
                    return;
                };
                if conflict.kind != SERVICE_CREATION_KIND {
                    return;
                }
                let restored = conflict.requires_restored_review();
                let Ok(creation) = serde_json::from_value::<ServiceCreation>(conflict.payload)
                else {
                    return;
                };
                Some((creation, restored))
            }
            None => None,
        };
        if conflict_id.is_some() {
            self.open_service_catalog(cx);
        }
        let Some(session) = self.svc.current_session() else {
            return;
        };
        if session.role != "owner" && session.role != "staff" {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let currency = self
            .services
            .iter()
            .find(|service| service.active)
            .map(|service| service.currency.clone())
            .unwrap_or_default();
        let labels = FIELDS.map(|key| self.t(key));
        let option_label = self.t(Key::CatalogOptionLabel);
        let search_label = self.t(Key::CatalogFindParent);
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.editor.is_some() {
            return;
        }
        let needs_restore_review = recovered.as_ref().is_some_and(|(_, restored)| *restored);
        let (id, input) = recovered.map_or_else(
            || {
                (
                    uuid::Uuid::now_v7().to_string(),
                    NewCatalogService {
                        details: empty_details(currency),
                        staff_ids: BTreeSet::new(),
                        catalog: None,
                    },
                )
            },
            |(creation, _)| (creation.id, creation.service),
        );
        let mut editor = Editor::new(
            CatalogService {
                id,
                version: 0,
                details: input.details,
                catalog: input.catalog.clone(),
                staff_ids: input.staff_ids.clone(),
            },
            generation.unwrap_or_default(),
            labels,
            cx,
        );
        let (choice, targets, value) = match input.catalog {
            Some(ServiceOption::Variant {
                parent_service_id,
                option_label,
            }) => (
                KindChoice::Variant,
                BTreeSet::from([parent_service_id]),
                option_label,
            ),
            Some(ServiceOption::Addon {
                allowed_service_ids,
            }) => (KindChoice::Addon, allowed_service_ids, String::new()),
            None => (KindChoice::Standalone, BTreeSet::new(), String::new()),
        };
        let label = cx.new(|cx| {
            let mut field = TextField::new(option_label, false, cx);
            field.set_text(&value, cx);
            field
        });
        let target_search = cx.new(|cx| TextField::new(search_label, false, cx));
        cx.observe(&label, |_, _, cx| cx.notify()).detach();
        cx.observe(&target_search, |_, _, cx| cx.notify()).detach();
        editor.creation = Some(Draft {
            choice,
            staff: input.staff_ids,
            targets,
            label,
            target_search,
            replaces: conflict_id.map(str::to_owned),
            staff_edited: conflict_id.is_some(),
            needs_restore_review,
        });
        desk.editor = Some(editor);
        desk.notice = None;
        cx.notify();
    }

    pub(super) fn queue_catalog_creation(&mut self, cx: &mut Context<Self>) {
        let authorized = self.can_create_catalogue_item();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else {
            return;
        };
        let Some(draft) = &editor.creation else {
            return;
        };
        if desk.confirm_close || !authorized || draft.needs_restore_review {
            return;
        }
        if self
            .services
            .iter()
            .any(|service| service.id == editor.base.id)
        {
            desk.notice = Some(Key::CatalogAlreadySaved);
            cx.notify();
            return;
        }
        let Some((mut details, catalog)) = editor
            .form(cx)
            .details(&editor.base.details)
            .zip(draft.option(cx))
        else {
            desk.notice = Some(Key::CatalogCreateInvalid);
            cx.notify();
            return;
        };
        details.active = true;
        let creation = ServiceCreation {
            id: editor.base.id.clone(),
            service: NewCatalogService {
                details,
                staff_ids: draft.staff.clone(),
                catalog,
            },
        };
        match self.svc.store.queue_service_creation(
            &editor.generation,
            &creation,
            draft.replaces.as_deref(),
        ) {
            Ok(()) => {
                desk.pending_creations.push(creation);
                desk.editor = None;
                desk.notice = Some(Key::CatalogQueued);
                self.edited(cx);
            }
            Err(CoreError::CalendarGenerationChanged) => {
                desk.notice = Some(Key::CatalogCreationReview);
                cx.notify();
            }
            Err(_) => {
                desk.notice = Some(Key::CatalogCreateInvalid);
                cx.notify();
            }
        }
    }

    pub(super) fn render_creation_options(
        &self,
        draft: &Draft,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let filter = draft.target_search.read(cx).text().trim().to_lowercase();
        let eligible = |row: &Service| {
            row.active
                && match draft.choice {
                    KindChoice::Standalone => false,
                    KindChoice::Variant => row.catalog.is_none(),
                    KindChoice::Addon => !matches!(row.catalog, Some(ServiceOption::Addon { .. })),
                }
        };
        let choices = self.services.iter().filter(|row| {
            eligible(row)
                && (draft.targets.contains(&row.id) || row.name.to_lowercase().contains(&filter))
        });
        let unavailable = draft.targets.iter().filter(|id| {
            !self
                .services
                .iter()
                .any(|row| row.id == **id && eligible(row))
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(KindChoice::ALL.map(|choice| {
                        self.button(
                            ("create-service-kind", choice as usize),
                            self.t(choice.label()),
                            if draft.choice == choice {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Some(draft) = root.current_creation()
                                    && draft.choice != choice
                                {
                                    draft.choice = choice;
                                    draft.targets.clear();
                                    root.set_creation_timing_defaults(choice, cx);
                                }
                                cx.notify();
                            }),
                        )
                    })),
            )
            .when(draft.choice == KindChoice::Variant, |view| {
                view.child(div().text_sm().child(self.t(Key::CatalogOptionLabel)))
                    .child(draft.label.clone())
            })
            .when(draft.choice != KindChoice::Standalone, |view| {
                view.child(
                    div()
                        .text_sm()
                        .child(self.t(if draft.choice == KindChoice::Variant {
                            Key::CatalogParent
                        } else {
                            Key::CatalogEligible
                        })),
                )
                .children(unavailable.map(|id| {
                    let id = id.clone();
                    let name = self
                        .services
                        .iter()
                        .find(|row| row.id == id)
                        .map(|row| row.name.as_str())
                        .unwrap_or(&id);
                    let label =
                        i18n::fill(self.t(Key::CatalogRemoveUnavailable), &[("name", name)]);
                    self.button(
                        SharedString::from(format!("remove-target-{id}")),
                        label,
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Some(draft) = root.current_creation() {
                                draft.targets.remove(&id);
                            }
                            cx.notify();
                        }),
                    )
                }))
                .child(draft.target_search.clone())
                .child(
                    div()
                        .id("native-create-service-targets")
                        .max_h(px(150.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .children(choices.map(|row| {
                            let id = row.id.clone();
                            self.button(
                                SharedString::from(format!("service-create-target-{id}")),
                                row.name.clone(),
                                if draft.targets.contains(&id) {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    root.choose_catalogue_target(&id, cx)
                                }),
                            )
                        })),
                )
            })
            .child(div().text_sm().child(self.t(Key::Staff)))
            .children(
                draft
                    .staff
                    .iter()
                    .filter(|id| {
                        !self
                            .report_staff_options
                            .iter()
                            .any(|row| row.id == **id && row.active)
                    })
                    .map(|id| {
                        let id = id.clone();
                        let label = i18n::fill(
                            self.t(Key::CatalogRemoveUnavailable),
                            &[("name", &self.staff_name(&id))],
                        );
                        self.button(
                            SharedString::from(format!("remove-staff-{id}")),
                            label,
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(draft) = root.current_creation() {
                                    draft.staff_edited = true;
                                    draft.staff.remove(&id);
                                }
                                cx.notify();
                            }),
                        )
                    }),
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    self.report_staff_options
                        .iter()
                        .filter(|row| row.active)
                        .map(|row| {
                            let id = row.id.clone();
                            self.button(
                                SharedString::from(format!("service-create-staff-{id}")),
                                row.display_name.clone(),
                                if draft.staff.contains(&id) {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    if let Some(draft) = root.current_creation() {
                                        draft.staff_edited = true;
                                        if !draft.staff.remove(&id) {
                                            draft.staff.insert(id.clone());
                                        }
                                    }
                                    cx.notify();
                                }),
                            )
                        }),
                ),
            )
    }

    fn set_creation_timing_defaults(&mut self, choice: KindChoice, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        let mut defaults = editor.base.clone();
        if choice == KindChoice::Addon {
            defaults.details.duration_minutes = 0;
            defaults.details.buffer_minutes = 0;
        } else if defaults.details.duration_minutes == 0 {
            defaults.details.duration_minutes = 30;
        }
        editor.review(editor.generation.clone(), defaults, cx);
    }

    fn choose_catalogue_target(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        let Some(draft) = &mut editor.creation else {
            return;
        };
        if draft.targets.remove(id) {
            cx.notify();
            return;
        }
        let defaults_needed = draft.choice == KindChoice::Variant || draft.targets.is_empty();
        if draft.choice == KindChoice::Variant {
            draft.targets.clear();
        }
        draft.targets.insert(id.to_owned());
        if defaults_needed && let Some(source) = self.services.iter().find(|row| row.id == id) {
            if !draft.staff_edited {
                let mut team = self
                    .svc
                    .store
                    .catalogue_target_staff(id)
                    .unwrap_or_default();
                team.retain(|id| {
                    self.report_staff_options
                        .iter()
                        .any(|staff| staff.active && &staff.id == id)
                });
                draft.staff = team;
            }
            let mut base = editor.base.clone();
            if draft.choice == KindChoice::Variant {
                if let Ok(Some(template)) = self.svc.store.catalogue_template(id) {
                    base.details = template;
                } else {
                    base.details.name = source.name.clone();
                    base.details.currency = source.currency.clone();
                }
            } else {
                base.details.currency = source.currency.clone();
            }
            editor.review(editor.generation.clone(), base, cx);
        }
        cx.notify();
    }

    fn current_creation(&mut self) -> Option<&mut Draft> {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return None;
        };
        if desk.confirm_close {
            return None;
        }
        desk.editor.as_mut()?.creation.as_mut()
    }

    pub(super) fn render_creation_action(
        &self,
        desk: &Desk,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if !self.can_create_catalogue_item() {
            return div().text_sm().child(self.t(Key::CatalogAccessLost));
        }
        if self
            .services
            .iter()
            .any(|service| service.id == editor.base.id)
        {
            return div().text_sm().child(self.t(Key::CatalogAlreadySaved));
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let restored = editor
            .creation
            .as_ref()
            .is_some_and(|draft| draft.needs_restore_review);
        if restored || generation.as_deref() != Some(editor.generation.as_str()) {
            let generation = generation.filter(|current| {
                desk.list
                    .as_ref()
                    .is_some_and(|list| list.generation == *current)
            });
            return div()
                .text_sm()
                .child(self.t(Key::CatalogCreationReview))
                .when_some(generation, |view, generation| {
                    view.child(self.button(
                        "catalog-review-create",
                        self.t(Key::CatalogReview),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                && let Some(editor) = &mut desk.editor
                                && let Some(draft) = &mut editor.creation
                            {
                                editor.generation.clone_from(&generation);
                                draft.needs_restore_review = false;
                                desk.notice = None;
                            }
                            cx.notify();
                        }),
                    ))
                });
        }
        div().child(self.button(
            "catalog-queue-create",
            self.t(Key::CatalogQueue),
            Kind::Primary,
            cx.listener(|root, _, _, cx| root.save_catalog_service(cx)),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn the_native_editor_creates_a_variant_from_the_offline_catalogue(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window.update(cx, |root, _, cx| {
            root.status.connectivity = Connectivity::Offline;
            root.open_service_catalog(cx);
            root.open_catalog_creation(None, cx);
            let parent = root.services.iter().find(|row| row.name == "Haircut").unwrap().id.clone();
            root.current_creation().unwrap().choice = KindChoice::Variant;
            root.choose_catalogue_target(&parent, cx);
            let draft = root.current_creation().unwrap();
            assert!(!draft.staff.is_empty());
            draft.label.update(cx, |field, cx| field.set_text("Long hair", cx));
            root.queue_catalog_creation(cx);
            let queued = root.svc.store.pending_service_creations().unwrap();
            assert_eq!(queued.len(), 1);
            assert_eq!(queued[0].service.details.name, "Haircut");
            assert!(matches!(&queued[0].service.catalog, Some(ServiceOption::Variant { parent_service_id, option_label })
                if parent_service_id == &parent && option_label == "Long hair"));
        }).unwrap();
    }
}
