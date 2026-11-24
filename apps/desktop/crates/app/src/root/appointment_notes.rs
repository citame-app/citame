use super::annotations::note_field;
use super::*;

pub(super) struct Draft {
    reviewed: String,
    lines: Vec<Entity<TextField>>,
    conflict_id: Option<String>,
    review_required: bool,
    discard_requested: bool,
    error: Option<Key>,
}

impl Draft {
    fn new(
        reviewed: &str,
        text: &str,
        conflict_id: Option<String>,
        cx: &mut Context<Root>,
    ) -> Self {
        Self {
            reviewed: reviewed.to_owned(),
            lines: text
                .split('\n')
                .map(|line| appointment_note_field(line, cx))
                .collect(),
            review_required: conflict_id.is_some(),
            discard_requested: false,
            conflict_id,
            error: None,
        }
    }

    fn text(&self, cx: &App) -> String {
        self.lines
            .iter()
            .map(|line| line.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn needs_review(&self, latest: &str) -> bool {
        self.review_required || self.reviewed != latest
    }
}

fn appointment_note_field(text: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    let field = note_field(text, true, cx);
    cx.subscribe(&field, |root, sender, event, cx| {
        let Some(draft) = root.appointment_note_draft() else {
            return;
        };
        let Some(index) = draft.lines.iter().position(|field| *field == sender) else {
            return;
        };
        match event {
            FieldEvent::PasteLines(tail) => {
                draft.lines.splice(
                    index + 1..index + 1,
                    tail.iter().map(|line| appointment_note_field(line, cx)),
                );
                draft.error = None;
            }
            FieldEvent::PasteTooLong => draft.error = Some(Key::InternalNoteTooLong),
            FieldEvent::Changed if draft.error == Some(Key::InternalNoteTooLong) => {
                draft.error = None
            }
            _ => return,
        }
        cx.notify();
    })
    .detach();
    field
}

impl Root {
    fn can_edit_appointment_note(&self, appointment: &Appointment, details: &Details) -> bool {
        self.can_edit_staff_calendar(&appointment.staff_id)
            && !matches!(
                details.annotations,
                Some(annotations::Annotations::Editing(_))
            )
            && details.start == details.reviewed.starts_at
            && details.staff_id == details.reviewed.staff_id
            && !details.confirm_cancel
    }

    fn appointment_note_draft(&mut self) -> Option<&mut Draft> {
        let Overlay::Details(details) = &mut self.overlay else {
            return None;
        };
        details.note_draft.as_mut()
    }

    fn edit_appointment_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        let Ok(view) = calendar::appointment_view(&self.svc.store, &details.id) else {
            return;
        };
        let Some(appointment) = view.appointment else {
            return;
        };
        if view.stale_edits
            || !self.can_edit_appointment_note(&appointment, details)
            || details.conflict_to_resolve().is_some()
        {
            return;
        }
        let note = appointment.notes.as_deref().unwrap_or_default();
        let draft = Draft::new(note, note, None, cx);
        draft.lines[0].read(cx).focus(window);
        if let Overlay::Details(details) = &mut self.overlay {
            details.note_draft = Some(draft);
        }
        cx.notify();
    }

    pub(super) fn appointment_note_conflict_access(&self, conflict: &Conflict) -> bool {
        conflict.kind == ops::APPOINTMENT_NOTES_KIND
            && self
                .svc
                .store
                .appointment(&conflict.entity_id)
                .ok()
                .flatten()
                .is_some_and(|appointment| self.can_edit_staff_calendar(&appointment.staff_id))
    }

    pub(super) fn copy_appointment_note_conflict(&self, id: &str, cx: &App) {
        if let Ok(Some(conflict)) = self.svc.store.conflict(id)
            && self.appointment_note_conflict_access(&conflict)
            && let Some(note) = conflict.payload["notes"].as_str()
        {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(note.to_owned()));
        }
    }

    fn explain_note_review_wait(&mut self, cx: &mut Context<Self>) {
        let message = self.t(Key::AppointmentNoteRefreshRequired).to_owned();
        if let Overlay::Conflicts { error, .. } = &mut self.overlay {
            *error = Some(message);
        }
        self.svc.wake(Wake::Manual);
        cx.notify();
    }

    pub(super) fn open_appointment_note_conflict(
        &mut self,
        conflict: &Conflict,
        cx: &mut Context<Self>,
    ) {
        if !self
            .svc
            .store
            .appointment_conflict_review_ready(&conflict.mutation_id, &conflict.entity_id)
            .unwrap_or(false)
        {
            self.explain_note_review_wait(cx);
            return;
        }
        let current = self
            .svc
            .store
            .appointment(&conflict.entity_id)
            .ok()
            .flatten()
            .filter(|appointment| self.can_edit_staff_calendar(&appointment.staff_id));
        if let Some((current, text)) = current.zip(conflict.payload["notes"].as_str())
            && !conflict.requires_restored_review()
        {
            let draft = Draft::new(
                current.notes.as_deref().unwrap_or_default(),
                text,
                Some(conflict.mutation_id.clone()),
                cx,
            );
            self.show_appointment_details(
                current,
                Some(AppointmentReturn::Conflict {
                    mutation_id: conflict.mutation_id.clone(),
                    schedule: None,
                }),
                cx,
            );
            if let Overlay::Details(details) = &mut self.overlay {
                details.note_draft = Some(draft);
            }
        } else {
            let message = self.t(Key::AppointmentChanged).to_owned();
            if let Overlay::Conflicts { error, .. } = &mut self.overlay {
                *error = Some(message);
            }
        }
        cx.notify();
    }

    fn review_appointment_note(&mut self, displayed: &str, cx: &mut Context<Self>) {
        let Some(draft) = self.appointment_note_draft() else {
            return;
        };
        draft.reviewed = displayed.to_owned();
        draft.review_required = false;
        draft.error = None;
        cx.notify();
    }

    fn save_appointment_note(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        let Some(draft) = details
            .note_draft
            .as_ref()
            .filter(|d| !d.review_required && !d.discard_requested)
        else {
            return;
        };
        let text = draft.text(cx);
        let resolving = draft.conflict_id.is_some();
        let result = ops::queue_appointment_notes(
            &mut self.svc.store,
            &details.id,
            &draft.reviewed,
            &text,
            draft.conflict_id.as_deref(),
        );
        match result {
            Ok(()) => {
                if resolving {
                    self.close_appointment_details(true);
                } else if let Overlay::Details(details) = &mut self.overlay {
                    details.note_draft = None;
                    if let Ok(Some(saved)) =
                        calendar::effective_appointment(&self.svc.store, &details.id)
                    {
                        details.reviewed = (&saved).into();
                        details.start = saved.starts_at;
                        details.staff_id = saved.staff_id;
                    }
                }
                self.edited(cx);
            }
            Err(error) => {
                if let Some(draft) = self.appointment_note_draft() {
                    draft.error = Some(match error {
                        CoreError::AppointmentChanged => {
                            draft.review_required = true;
                            Key::AppointmentNoteReview
                        }
                        CoreError::AppointmentScopeDenied => Key::ConflictForbidden,
                        CoreError::AppointmentEditsAwaitingSync => {
                            Key::AppointmentEditsAwaitingSync
                        }
                        CoreError::AppointmentNoteRefreshRequired => {
                            Key::AppointmentNoteRefreshRequired
                        }
                        _ if text.encode_utf16().count() > ops::APPOINTMENT_NOTES_LIMIT => {
                            Key::InternalNoteTooLong
                        }
                        _ => Key::AppointmentNoteLocalSaveFailed,
                    });
                }
                cx.notify();
            }
        }
    }

    pub(super) fn discard_appointment_note_editor(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Details(details) = &mut self.overlay
            && let Some(draft) = details.note_draft.take()
        {
            if draft.conflict_id.is_some() {
                self.close_appointment_details(false);
            }
            cx.notify();
        }
    }

    pub(super) fn request_appointment_note_close(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.appointment_note_draft() else {
            return;
        };
        if draft.conflict_id.is_none() && draft.text(cx) == draft.reviewed {
            self.discard_appointment_note_editor(cx);
            return;
        }
        draft.discard_requested = !draft.discard_requested;
        cx.notify();
    }

    pub(super) fn render_appointment_note(
        &self,
        appointment: &Appointment,
        details: &Details,
        allow_changes: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let saved = appointment.notes.as_deref().unwrap_or_default();
        let form = div().flex().flex_col().gap_2();
        let editable = allow_changes && self.can_edit_appointment_note(appointment, details);
        let Some(draft) = details.note_draft.as_ref() else {
            return form
                .when(!saved.trim().is_empty(), |panel| {
                    panel.child(div().text_sm().child(saved.to_owned()))
                })
                .when(
                    editable && details.conflict_to_resolve().is_none(),
                    |panel| {
                        panel.child(
                            self.button(
                                "edit-appointment-note",
                                self.t(Key::EditAppointmentNote),
                                Kind::Ghost,
                                cx.listener(|root, _, window, cx| {
                                    root.edit_appointment_note(window, cx)
                                }),
                            )
                            .debug_selector(|| "edit-appointment-note".to_owned()),
                        )
                    },
                );
        };
        if draft.discard_requested {
            return form
                .child(self.label(Key::AppointmentNoteDiscardPrompt))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "keep-editing-appointment-note",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.request_appointment_note_close(cx)),
                        ))
                        .child(self.button(
                            "confirm-discard-appointment-note",
                            self.t(Key::ReviewDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| root.discard_appointment_note_editor(cx)),
                        )),
                );
        }
        let needs_review = draft.needs_review(saved);
        let text = draft.text(cx);
        let too_long = text.encode_utf16().count() > ops::APPOINTMENT_NOTES_LIMIT;
        let can_save = editable
            && !too_long
            && !needs_review
            && (text != saved || draft.conflict_id.is_some());
        form.child(self.label(Key::EditAppointmentNote))
            .when(needs_review, |panel| {
                let displayed = saved.to_owned();
                panel.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .p_3()
                        .rounded_md()
                        .bg(theme::conflict_bg())
                        .child(self.label(Key::AppointmentNoteCurrent))
                        .child(div().text_sm().child(if saved.is_empty() {
                            self.t(Key::AppointmentNoteNoText).to_owned()
                        } else {
                            saved.to_owned()
                        }))
                        .child(div().text_sm().child(self.t(Key::AppointmentNoteReview)))
                        .when(editable, |review| {
                            review.child(
                                self.button(
                                    "review-appointment-note",
                                    self.t(Key::AppointmentNoteKeepDraft),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.review_appointment_note(&displayed, cx)
                                    }),
                                )
                                .debug_selector(|| "review-appointment-note".to_owned()),
                            )
                        }),
                )
            })
            .child(
                div()
                    .id("appointment-note-draft")
                    .max_h(px(260.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(draft.lines.iter().enumerate().map(|(index, field)| {
                        div()
                            .flex()
                            .gap_2()
                            .child(div().min_w_0().flex_1().child(field.clone()))
                            .when(draft.lines.len() > 1, |row| {
                                row.child(self.button(
                                    ("remove-appointment-note-line", index),
                                    self.t(Key::RemoveNoteLine),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        if let Some(draft) = root.appointment_note_draft()
                                            && draft.lines.len() > 1
                                            && index < draft.lines.len()
                                        {
                                            draft.lines.remove(index);
                                            cx.notify();
                                        }
                                    }),
                                ))
                            })
                    })),
            )
            .when_some(
                draft.error.or(too_long.then_some(Key::InternalNoteTooLong)),
                |panel, error| {
                    panel.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                },
            )
            .child(div().flex().flex_wrap().gap_2().child(self.button(
                "add-appointment-note-line",
                self.t(Key::AddNoteLine),
                Kind::Ghost,
                cx.listener(|root, _, window, cx| {
                    if let Some(draft) = root.appointment_note_draft()
                        && draft.lines.len() <= ops::APPOINTMENT_NOTES_LIMIT
                    {
                        let line = appointment_note_field("", cx);
                        line.read(cx).focus(window);
                        draft.lines.push(line);
                        cx.notify();
                    }
                }),
            )))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_end()
                    .gap_2()
                    .child(self.button(
                        "discard-appointment-note-editor",
                        self.t(if draft.conflict_id.is_some() {
                            Key::Back
                        } else {
                            Key::ReviewDiscard
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_appointment_note_close(cx)),
                    ))
                    .when(can_save, |actions| {
                        actions.child(
                            self.button(
                                "save-appointment-note",
                                self.t(Key::SaveAppointmentNote),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_appointment_note(cx)),
                            )
                            .debug_selector(|| "save-appointment-note".to_owned()),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn appointment_note_editor_keeps_the_draft_when_cloud_changes_the_note(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(900.), px(900.)));
        let id = root.update(cx, |root, cx| {
            let id = root.view.as_ref().unwrap().columns[0].items[0]
                .appointment
                .id
                .clone();
            root.open_details(&id, cx);
            id
        });
        cx.run_until_parked();
        let edit = cx.debug_bounds("edit-appointment-note").unwrap();
        cx.simulate_click(edit.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |_, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                "Desktop draft\nSecond line".into(),
            ));
        });
        cx.simulate_keystrokes("ctrl-v");
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let mut cloud = root.svc.store.appointment(&id).unwrap().unwrap();
            cloud.version += 1;
            cloud.notes = Some("Cloud note".into());
            root.svc
                .store
                .apply_page(
                    &[RawChange {
                        seq: 10,
                        entity: "appointment".into(),
                        id: id.clone(),
                        op: "upsert".into(),
                        data: Some(serde_json::to_value(cloud).unwrap()),
                    }],
                    10,
                )
                .unwrap();
            root.reload(cx);
            assert_eq!(
                root.appointment_note_draft().unwrap().text(cx),
                "Desktop draft\nSecond line"
            );
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("save-appointment-note").is_none());
        let review = cx.debug_bounds("review-appointment-note").unwrap();
        cx.simulate_click(review.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert_eq!(root.svc.store.outbox_len().unwrap(), 0)
        });
        let save = cx.debug_bounds("save-appointment-note").unwrap();
        cx.simulate_click(save.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let jobs = root.svc.store.outbox(10).unwrap();
            assert_eq!(jobs.len(), 1);
            assert_eq!(jobs[0].kind, ops::APPOINTMENT_NOTES_KIND);
            assert_eq!(jobs[0].payload["version"], 4);
            assert_eq!(jobs[0].payload["notes"], "Desktop draft\nSecond line");
            assert!(root.appointment_note_draft().is_none());
        });
    }
}
