use super::*;
use sob_core::store::{AssignmentSnapshot, AssignmentWork, ServiceAssignment};
use std::collections::BTreeSet;

pub(super) struct Desk {
    search: Entity<TextField>,
    catalogue: Vec<Service>,
    editor: Option<Editor>,
    message: Option<Key>,
}

struct Editor {
    service: Service,
    reviewing_conflict: Option<String>,
    snapshot: AssignmentSnapshot,
    proposed: BTreeSet<String>,
    stale: bool,
    reviewed: bool,
    confirm_back: bool,
}

impl Editor {
    fn change(&self) -> ServiceAssignment {
        ServiceAssignment {
            id: self.service.id.clone(),
            reviewed_staff_ids: self.snapshot.reviewed_team().clone(),
            staff_ids: self.proposed.clone(),
        }
    }

    fn dirty(&self) -> bool {
        self.reviewed && &self.proposed != self.snapshot.reviewed_team()
    }

    fn pending(&self) -> bool {
        matches!(self.snapshot.work, AssignmentWork::Pending(_))
    }

    fn conflict(&self) -> Option<(&str, &ServiceAssignment)> {
        if let AssignmentWork::Conflict { id, change } = &self.snapshot.work {
            Some((id, change))
        } else {
            None
        }
    }
}

impl Root {
    pub(super) fn preserve_open_assignment_draft(&mut self) -> bool {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return false;
        };
        let Some(editor) = &mut desk.editor else {
            return false;
        };
        if !editor.dirty() {
            return false;
        }
        editor.stale = true;
        true
    }

    pub(super) fn open_service_assignments(
        &mut self,
        conflict: Option<(&str, &str)>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_configure_salon() {
            return;
        }
        let search = cx.new(|cx| TextField::new(self.t(Key::AssignmentSearch), false, cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        let catalogue = self.svc.store.services();
        let mut desk = Desk {
            search,
            message: catalogue.is_err().then_some(Key::AssignmentUnavailable),
            catalogue: catalogue.unwrap_or_default(),
            editor: None,
        };
        if let Some((service_id, mutation_id)) = conflict {
            desk.open(&self.svc.store, service_id, Some(mutation_id));
        }
        self.overlay = Overlay::ServiceAssignments(Box::new(desk));
        cx.notify();
    }

    fn select_service_assignment(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        desk.open(&self.svc.store, id, None);
        cx.notify();
    }

    pub(super) fn refresh_service_assignments(&mut self, catalogue: &[Service]) {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        desk.catalogue = catalogue.to_vec();
        let Some(editor) = &mut desk.editor else {
            return;
        };
        let Ok(next) = self
            .svc
            .store
            .review_service_assignment(&editor.service.id, editor.reviewing_conflict.as_deref())
        else {
            editor.stale = true;
            desk.message = Some(Key::AssignmentUnavailable);
            return;
        };
        if let Some(service) = catalogue.iter().find(|s| s.id == editor.service.id) {
            editor.service = service.clone();
        }
        if editor.snapshot == next {
            return;
        }
        if editor.dirty() {
            editor.stale = true;
        } else {
            editor.stale = false;
            editor.reviewed = false;
            editor.proposed = next.reviewed_team().clone();
            editor.snapshot = next;
            desk.message = None;
        }
    }

    fn review_service_assignment(&mut self, cx: &mut Context<Self>) {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        let Ok(snapshot) = self
            .svc
            .store
            .review_service_assignment(&editor.service.id, editor.reviewing_conflict.as_deref())
        else {
            desk.message = Some(Key::AssignmentUnavailable);
            cx.notify();
            return;
        };
        let change = if editor.dirty() {
            editor.change()
        } else if let AssignmentWork::Conflict { change, .. } = &snapshot.work {
            change.clone()
        } else {
            editor.change()
        };
        let mut proposed = change.proposed_on(snapshot.reviewed_team());
        let before = proposed.len();
        proposed.retain(|id| {
            snapshot.reviewed_team().contains(id) || snapshot.active_staff_ids.contains(id)
        });
        desk.message = (before != proposed.len()).then_some(Key::AssignmentInactiveSkipped);
        editor.snapshot = snapshot;
        editor.proposed = proposed;
        editor.stale = false;
        editor.reviewed = true;
        cx.notify();
    }

    fn toggle_service_staff(&mut self, staff_id: &str, cx: &mut Context<Self>) {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        if editor.stale
            || editor.confirm_back
            || (editor.conflict().is_some() && !editor.reviewed)
            || !editor.snapshot.active_staff_ids.contains(staff_id)
        {
            return;
        }
        if !editor.proposed.remove(staff_id) {
            editor.proposed.insert(staff_id.to_owned());
        }
        editor.reviewed = true;
        cx.notify();
    }

    fn save_service_assignment(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        if !editor.reviewed || editor.stale || editor.confirm_back {
            return;
        }
        let result = self.svc.store.queue_service_assignment(
            &editor.snapshot.generation,
            &editor.change(),
            editor.conflict().map(|(id, _)| id),
        );
        if result.is_ok() {
            editor.reviewing_conflict = None;
            editor.reviewed = false;
            self.edited(cx);
        } else {
            editor.stale = true;
            desk.message = Some(Key::AssignmentUnavailable);
            cx.notify();
        }
    }

    pub(super) fn close_service_assignment(&mut self, cx: &mut Context<Self>) {
        let Overlay::ServiceAssignments(desk) = &mut self.overlay else {
            return;
        };
        if let Some(editor) = &mut desk.editor {
            if editor.dirty() {
                editor.confirm_back = !editor.confirm_back;
            } else {
                desk.editor = None;
                desk.message = None;
            }
        } else {
            self.overlay = Overlay::None;
        }
        cx.notify();
    }

    pub(super) fn render_service_assignments(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::ServiceAssignments)),
                    )
                    .child(self.button(
                        "assignments-back",
                        self.t(if desk.editor.is_some() {
                            Key::Back
                        } else {
                            Key::Close
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_service_assignment(cx)),
                    )),
            )
            .when_some(desk.message, |body, key| {
                body.child(div().text_sm().child(self.t(key)))
            });
        let body = match &desk.editor {
            Some(editor) => body.child(self.render_assignment_editor(editor, cx)),
            None => {
                let query = desk.search.read(cx).text().trim().to_lowercase();
                let mut matches = desk
                    .catalogue
                    .iter()
                    .filter(|service| service.name.to_lowercase().contains(&query))
                    .peekable();
                let empty = matches.peek().is_none();
                body.child(desk.search.clone()).child(
                    div()
                        .id("assignment-services")
                        .flex()
                        .flex_col()
                        .gap_1()
                        .min_h(px(0.))
                        .overflow_y_scroll()
                        .when(empty, |list| {
                            list.child(div().text_sm().child(self.t(Key::AssignmentNoServices)))
                        })
                        .children(matches.map(|service| {
                            let id = service.id.clone();
                            let name = if service.active {
                                service.name.clone()
                            } else {
                                format!("{} · {}", service.name, self.t(Key::StaffPortraitInactive))
                            };
                            self.button(
                                SharedString::from(format!("assigned-service-{id}")),
                                name,
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.select_service_assignment(&id, cx)
                                }),
                            )
                        })),
                )
            }
        };
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(260.)).min(px(640.)),
            (viewport.height - px(32.)).max(px(210.)).min(px(680.)),
            Some(cx),
        )
    }

    fn render_assignment_editor(
        &self,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let awaiting_review = editor.stale || (editor.conflict().is_some() && !editor.reviewed);
        let content = div()
            .id("assignment-editor")
            .min_h(px(0.))
            .flex()
            .flex_col()
            .gap_3()
            .overflow_y_scroll()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(editor.service.name.clone()),
            );
        if editor.confirm_back {
            return content
                .child(self.t(Key::SalonConfirmDiscard))
                .child(self.button(
                    "assignment-discard",
                    self.t(Key::SalonDiscard),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::ServiceAssignments(desk) = &mut root.overlay {
                            desk.editor = None;
                            desk.message = None;
                        }
                        cx.notify();
                    }),
                ));
        }
        let selected = &editor.proposed;
        content
            .when(editor.pending(), |content| {
                content.child(self.t(Key::AssignmentPending))
            })
            .when(awaiting_review, |content| {
                content
                    .child(self.t(Key::AssignmentChanged))
                    .child(self.button(
                        "assignment-review",
                        self.t(Key::AssignmentReview),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.review_service_assignment(cx)),
                    ))
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .when(self.report_staff_options.is_empty(), |list| {
                        list.child(self.t(Key::AssignmentNoStaff))
                    })
                    .children(self.report_staff_options.iter().map(|member| {
                        let id = member.id.clone();
                        let assigned = selected.contains(&id);
                        let before = editor.snapshot.staff_ids.contains(&id);
                        let mut label = format!(
                            "{} · {}",
                            member.display_name,
                            self.t(match (before, assigned) {
                                (true, true) => Key::AssignmentAssigned,
                                (false, false) => Key::AssignmentUnassigned,
                                (false, true) => Key::AssignmentWillAdd,
                                (true, false) => Key::AssignmentWillRemove,
                            })
                        );
                        if !member.active {
                            label.push_str(" · ");
                            label.push_str(self.t(Key::StaffPortraitInactive));
                        }
                        if !member.active || awaiting_review {
                            div().p_2().text_sm().child(label).into_any_element()
                        } else {
                            self.button(
                                SharedString::from(format!("assignment-staff-{id}")),
                                label,
                                if assigned { Kind::Primary } else { Kind::Ghost },
                                cx.listener(move |root, _, _, cx| {
                                    root.toggle_service_staff(&id, cx)
                                }),
                            )
                            .into_any_element()
                        }
                    })),
            )
            .when(
                !awaiting_review
                    && (editor.dirty() || (editor.reviewed && editor.conflict().is_some())),
                |content| {
                    content.child(self.button(
                        "assignment-save",
                        self.t(Key::AssignmentSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_service_assignment(cx)),
                    ))
                },
            )
    }
}

impl Desk {
    fn open(&mut self, store: &sob_core::store::Store, id: &str, mutation_id: Option<&str>) {
        let service = self.catalogue.iter().find(|service| service.id == id);
        if let (Some(service), Ok(snapshot)) =
            (service, store.review_service_assignment(id, mutation_id))
        {
            self.editor = Some(Editor {
                service: service.clone(),
                reviewing_conflict: mutation_id.map(str::to_owned),
                proposed: snapshot.reviewed_team().clone(),
                snapshot,
                stale: false,
                reviewed: false,
                confirm_back: false,
            });
            self.message = None;
        } else {
            self.message = Some(Key::AssignmentUnavailable);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use serde_json::json;
    use sob_core::model::RawChange;

    #[gpui::test]
    async fn refreshing_an_open_assignment_keeps_the_edit_for_review(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let change = |seq, entity: &str, id: &str, data| RawChange {
                seq, entity: entity.into(), id: id.into(), op: "upsert".into(), data: Some(data),
            };
            let time = "2026-11-21T00:00:00Z";
            let staff = |seq, id| change(seq, "staff", id,
                json!({"id": id, "displayName": id, "active": true, "userId": null, "updatedAt": time}));
            let link = |seq, id, staff_id| change(seq, "service_staff", id,
                json!({"id": id, "serviceId": "style", "staffId": staff_id}));
            let cursor = root.svc.store.cursor().unwrap();
            root.svc.store.apply_page(&[
                change(cursor + 1, "service", "style", json!({
                    "id": "style", "name": "Style", "description": null, "durationMinutes": 20,
                    "bufferMinutes": 0, "priceCents": 1500, "currency": "EUR", "active": true, "updatedAt": time
                })),
                staff(cursor + 2, "assignment-ana"),
                staff(cursor + 3, "assignment-bea"),
                link(cursor + 4, "link-ana", "assignment-ana"),
            ], cursor + 4).unwrap();
            root.reload(cx);
            let catalogue = root.svc.store.services().unwrap();
            let mut desk = Desk {
                search: cx.new(|cx| TextField::new("", false, cx)),
                catalogue,
                editor: None,
                message: None,
            };
            desk.open(&root.svc.store, "style", None);
            root.overlay = Overlay::ServiceAssignments(Box::new(desk));
            root.toggle_service_staff("assignment-ana", cx);

            root.svc.store.apply_page(&[link(cursor + 5, "link-bea", "assignment-bea")], cursor + 5).unwrap();
            root.reload(cx);
            assert!(matches!(&root.overlay, Overlay::ServiceAssignments(desk)
                if desk.editor.as_ref().unwrap().stale && desk.editor.as_ref().unwrap().proposed.is_empty()));
            root.review_service_assignment(cx);
            assert!(matches!(&root.overlay, Overlay::ServiceAssignments(desk)
                if !desk.editor.as_ref().unwrap().stale
                    && desk.editor.as_ref().unwrap().proposed == ["assignment-bea".into()].into()));
        }).unwrap();
    }
}
