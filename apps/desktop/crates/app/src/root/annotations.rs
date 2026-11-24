use super::*;
use std::sync::Arc;

pub(super) enum Annotations {
    Loading {
        request: Arc<()>,
        previous: Option<AppointmentAnnotations>,
    },
    Ready(AppointmentAnnotations),
    Editing(Box<NoteDraft>),
    Unavailable,
}

impl Annotations {
    pub(super) fn context(&self) -> Option<&AppointmentAnnotations> {
        match self {
            Self::Loading { previous, .. } => previous.as_ref(),
            Self::Ready(context) => Some(context),
            Self::Editing(draft) => Some(&draft.notes),
            Self::Unavailable => None,
        }
    }

    fn forget_protection(&mut self) {
        let context = match self {
            Self::Loading { previous, .. } => previous.as_mut(),
            Self::Ready(context) => Some(context),
            Self::Editing(draft) => Some(&mut draft.notes),
            Self::Unavailable => None,
        };
        if let Some(context) = context {
            context.protection = None;
            context.has_visit_checkout = false;
        }
    }
}

impl Details {
    pub(super) fn install_annotation_context(&mut self, context: AppointmentAnnotations) {
        self.deposit_outcome_block = context
            .protection
            .as_ref()
            .and_then(|deposit| deposit.status.attendance_block);
        self.annotations = Some(Annotations::Ready(context));
    }
}

pub(super) struct NoteDraft {
    notes: AppointmentAnnotations,
    position: usize,
    lines: Vec<Entity<TextField>>,
    original_requested: bool,
    requested: bool,
    preference_edited: bool,
    reviewed_staff: String,
    reviewed_preference: Option<String>,
    reviewed_note: String,
    preserve_note_edit: bool,
    pending: Option<Arc<()>>,
    refreshing: Option<Arc<()>>,
    rejected: Option<(i64, u32)>,
    error: Option<Key>,
}

impl NoteDraft {
    fn text(&self, cx: &App) -> String {
        self.lines
            .iter()
            .map(|line| line.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn row(&self) -> Option<&ServiceAnnotations> {
        self.notes
            .rows
            .iter()
            .find(|row| row.service_position == self.position)
    }

    fn saved_note(&self) -> &str {
        self.row()
            .and_then(|row| row.internal_note.as_deref())
            .unwrap_or_default()
    }

    fn saved_preference(&self) -> Option<&str> {
        self.row().and_then(|row| row.requested_staff_id.as_deref())
    }

    fn saved_requested(&self) -> bool {
        self.row()
            .map(|row| row.requested_staff_id.is_some())
            .or(self.notes.default_requested)
            .unwrap_or(self.original_requested)
    }

    fn revision(&self) -> Option<(i64, u32)> {
        Self::context_revision(&self.notes, self.position)
    }

    fn context_revision(notes: &AppointmentAnnotations, position: usize) -> Option<(i64, u32)> {
        let row = notes
            .rows
            .iter()
            .find(|row| row.service_position == position);
        Some((notes.appointment_version?, row.map_or(0, |row| row.version)))
    }

    fn awaiting_review(&self, text: &str, staff: &str) -> bool {
        let note_changed = text.trim() != self.saved_note().trim()
            && self.reviewed_note.trim() != self.saved_note().trim();
        let preference_changed = self.preference_edited
            && ((self.requested && self.reviewed_staff != staff)
                || (self.request_change(staff).is_some()
                    && self.reviewed_preference.as_deref() != self.saved_preference()));
        note_changed || preference_changed
    }

    fn request_change(&self, staff: &str) -> Option<bool> {
        (self.preference_edited
            && (self.requested != self.saved_requested()
                || (self.requested && self.saved_preference().is_some_and(|id| id != staff))))
        .then_some(self.requested)
    }

    fn update(&self, internal_note: String) -> Option<UpdateServiceAnnotations> {
        let (appointment_version, version) = self.revision()?;
        let requested = self.request_change(&self.reviewed_staff);
        if requested.is_none() && self.saved_note().trim() == internal_note.trim() {
            return None;
        }
        Some(UpdateServiceAnnotations {
            appointment_version,
            service_position: self.position,
            version,
            requested,
            internal_note,
        })
    }

    fn needs_current_assignment(&self, appointment: &Appointment) -> bool {
        self.preference_edited
            && self.requested
            && self.notes.appointment_version != Some(appointment.version)
    }

    fn receive(&mut self, notes: AppointmentAnnotations, cx: &mut Context<Root>) {
        if Self::context_revision(&notes, self.position) < self.revision() {
            return;
        }
        let text = self.text(cx);
        let keep_edit = self.preserve_note_edit || self.reviewed_note.trim() != text.trim();
        self.notes = notes;
        if self
            .rejected
            .is_some_and(|attempt| self.revision().is_some_and(|read| read > attempt))
        {
            self.rejected = None;
            self.error = None;
        }
        if keep_edit && text.trim() != self.saved_note().trim() {
            self.preserve_note_edit = true;
        } else {
            self.preserve_note_edit = false;
            self.reviewed_note = self.saved_note().to_owned();
            if text != self.reviewed_note {
                self.lines = self
                    .reviewed_note
                    .split('\n')
                    .map(|line| note_field(line, false, cx))
                    .collect();
            }
        }
        if self.preference_edited
            && self.requested == self.saved_requested()
            && (!self.requested || self.saved_preference() == Some(self.reviewed_staff.as_str()))
        {
            self.preference_edited = false;
        }
        if !self.preference_edited {
            self.original_requested = self.saved_requested();
            self.requested = self.original_requested;
            self.reviewed_preference = self.saved_preference().map(str::to_owned);
        }
    }
}

fn can_edit_service_annotations(notes: &AppointmentAnnotations, time_off_scope: &str) -> bool {
    notes.appointment_version.is_some() && time_off_scope != "none" && notes.can_edit != Some(false)
}

pub(super) fn note_field(text: &str, multiline: bool, cx: &mut Context<Root>) -> Entity<TextField> {
    let field = cx.new(|cx| {
        let field = TextField::new("", false, cx);
        let mut field = if multiline {
            field.with_line_paste(ops::APPOINTMENT_NOTES_LIMIT)
        } else {
            field
        };
        field.set_text(text, cx);
        field
    });
    cx.observe(&field, |_, _, cx| cx.notify()).detach();
    field
}

impl Root {
    fn editable_service_appointment(&self) -> Option<Appointment> {
        let Overlay::Details(details) = &self.overlay else {
            return None;
        };
        self.svc
            .store
            .appointment(&details.id)
            .ok()
            .flatten()
            .filter(|appointment| self.can_edit_staff_calendar(&appointment.staff_id))
    }

    pub(super) fn refresh_open_annotations(&mut self, force_refresh: bool, cx: &mut Context<Self>) {
        if force_refresh
            && let Overlay::Details(details) = &mut self.overlay
            && let Some(annotations) = &mut details.annotations
        {
            annotations.forget_protection();
        }
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        if force_refresh
            && matches!(&self.overlay, Overlay::Details(details)
                if details.visit_payment.is_some()
                && matches!(details.annotations, Some(Annotations::Loading { .. })))
        {
            self.open_annotations(cx);
            return;
        }
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        let loaded_version = match &details.annotations {
            Some(Annotations::Loading { .. }) => return,
            Some(Annotations::Editing(draft))
                if draft.pending.is_some() || draft.refreshing.is_some() =>
            {
                return;
            }
            Some(Annotations::Editing(draft)) => draft.notes.appointment_version,
            Some(Annotations::Ready(notes)) => notes.appointment_version,
            Some(Annotations::Unavailable) if force_refresh => {
                self.open_annotations(cx);
                return;
            }
            _ => None,
        };
        let known_version = loaded_version.max(details.annotations_requested_version);
        let commerce_revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        if force_refresh
            || commerce_revision != details.annotations_commerce_revision
            || self
                .svc
                .store
                .appointment(&details.id)
                .ok()
                .flatten()
                .is_some_and(|appointment| Some(appointment.version) > known_version)
        {
            self.open_annotations(cx);
        }
    }

    pub(super) fn saving_service_annotations(&self) -> bool {
        matches!(&self.overlay, Overlay::Details(details) if matches!(&details.annotations,
            Some(Annotations::Editing(draft)) if draft.pending.is_some()))
    }

    fn draft(&mut self) -> Option<&mut NoteDraft> {
        let Overlay::Details(details) = &mut self.overlay else {
            return None;
        };
        match &mut details.annotations {
            Some(Annotations::Editing(draft)) => Some(draft),
            _ => None,
        }
    }

    fn edit_service_annotations(&mut self, position: usize, cx: &mut Context<Self>) {
        let Some(appointment) = self.editable_service_appointment() else {
            return;
        };
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        if details.note_draft.is_some()
            || self.svc.store.appointment_edit_sync(&details.id).ok()
                == Some(AppointmentEditSync::Pending)
        {
            return;
        }
        let Some(Annotations::Ready(notes)) = details.annotations.as_ref() else {
            return;
        };
        if !can_edit_service_annotations(notes, &self.time_off_scope) {
            return;
        }
        let row = notes
            .rows
            .iter()
            .find(|row| row.service_position == position);
        let requested = row
            .map(|row| row.requested_staff_id.is_some())
            .or(notes.default_requested)
            .unwrap_or_else(|| {
                appointment
                    .service_badges
                    .iter()
                    .any(|badge| badge.service_position == position && badge.requested)
            });
        let text = row
            .and_then(|row| row.internal_note.as_deref())
            .unwrap_or_default()
            .to_owned();
        let reviewed_preference = row.and_then(|row| row.requested_staff_id.clone());
        let lines = text
            .split('\n')
            .map(|line| note_field(line, false, cx))
            .collect();
        if let Some(Annotations::Ready(notes)) = details.annotations.take() {
            details.annotations = Some(Annotations::Editing(Box::new(NoteDraft {
                notes,
                position,
                lines,
                original_requested: requested,
                requested,
                preference_edited: false,
                reviewed_staff: appointment.staff_id,
                reviewed_preference,
                reviewed_note: text,
                preserve_note_edit: false,
                pending: None,
                refreshing: None,
                rejected: None,
                error: None,
            })));
        }
        cx.notify();
    }

    fn save_service_annotations(&mut self, cx: &mut Context<Self>) {
        let Some(appointment) = self.editable_service_appointment() else {
            return;
        };
        let transport = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity != Connectivity::Offline);
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        let Some(Annotations::Editing(draft)) = &mut details.annotations else {
            return;
        };
        if draft.pending.is_some()
            || draft.refreshing.is_some()
            || draft.rejected.is_some()
            || !can_edit_service_annotations(&draft.notes, &self.time_off_scope)
        {
            return;
        }
        if !self
            .svc
            .store
            .outbox(usize::MAX)
            .is_ok_and(|queue| queue.iter().all(|edit| edit.entity_id != details.id))
        {
            draft.error = Some(Key::InternalNotePendingAppointment);
            cx.notify();
            return;
        }
        let Some(transport) = transport else {
            draft.error = Some(Key::InternalNoteSaveFailed);
            cx.notify();
            return;
        };
        let internal_note = draft.text(cx);
        if draft.awaiting_review(&internal_note, &appointment.staff_id)
            || draft.needs_current_assignment(&appointment)
        {
            return;
        }
        if internal_note.encode_utf16().count() > 2000 {
            draft.error = Some(Key::InternalNoteTooLong);
            cx.notify();
            return;
        }
        let Some(input) = draft.update(internal_note) else {
            return;
        };
        let attempted = (input.appointment_version, input.version);
        let id = details.id.clone();
        let session = self.svc.session.clone();
        let time_off_scope = self.time_off_scope.clone();
        let request = Arc::new(());
        draft.pending = Some(request.clone());
        draft.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.update_service_annotations(&id, &input) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::Details(details) = &mut this.overlay else {
                    return;
                };
                let Some(Annotations::Editing(draft)) = &mut details.annotations else {
                    return;
                };
                if !draft
                    .pending
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    return;
                }
                draft.pending = None;
                match result {
                    Ok(Some(notes)) => {
                        let permissions_changed = this.time_off_scope != time_off_scope;
                        details.install_annotation_context(notes);
                        this.svc.wake(Wake::Manual);
                        this.refresh_open_annotations(permissions_changed, cx);
                    }
                    Ok(None) => {
                        draft.rejected = Some(attempted);
                        this.open_annotations(cx);
                    }
                    Err(_) => draft.error = Some(Key::InternalNoteSaveFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn cancel_service_annotations(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        if !matches!(&details.annotations, Some(Annotations::Editing(draft)) if draft.pending.is_none())
        {
            return;
        }
        let Some(Annotations::Editing(draft)) = details.annotations.take() else {
            return;
        };
        if let Some(request) = draft.refreshing {
            details.annotations = Some(Annotations::Loading {
                request,
                previous: Some(draft.notes),
            });
        } else {
            details.annotations = Some(Annotations::Ready(draft.notes));
            if self.status.connectivity != Connectivity::Offline
                && (draft.rejected.is_some() || draft.error == Some(Key::InternalNoteSaveFailed))
            {
                self.open_annotations(cx);
            } else {
                self.refresh_open_annotations(false, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn open_annotations(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity != Connectivity::Offline)
        else {
            if let Some(Annotations::Editing(draft)) = &mut details.annotations {
                draft.error = Some(Key::InternalNoteSaveFailed);
            } else {
                details.annotations = Some(Annotations::Unavailable);
            }
            cx.notify();
            return;
        };
        let id = details.id.clone();
        details.annotations_commerce_revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        details.annotations_requested_version = self
            .svc
            .store
            .appointment(&id)
            .ok()
            .flatten()
            .map(|appointment| appointment.version);
        let time_off_scope = self.time_off_scope.clone();
        let session = self.svc.session.clone();
        let request = Arc::new(());
        if let Some(Annotations::Editing(draft)) = &mut details.annotations {
            if draft.pending.is_some() || draft.refreshing.is_some() {
                return;
            }
            draft.refreshing = Some(request.clone());
        } else {
            let previous = match details.annotations.take() {
                Some(Annotations::Ready(notes)) => Some(notes),
                _ => None,
            };
            details.annotations = Some(Annotations::Loading {
                request: request.clone(),
                previous,
            });
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.appointment_annotations(&id) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::Details(details) = &mut this.overlay else {
                    return;
                };
                if let Some(Annotations::Editing(draft)) = &mut details.annotations
                    && draft.refreshing.as_ref().is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    draft.refreshing = None;
                    match result {
                        Ok(notes) => {
                            draft.receive(notes, cx);
                            if draft.notes.appointment_version > details.annotations_requested_version {
                                this.svc.wake(Wake::Manual);
                            }
                        }
                        Err(_) => draft.error = Some(Key::InternalNoteSaveFailed),
                    }
                    this.refresh_open_annotations(this.time_off_scope != time_off_scope, cx);
                    cx.notify();
                    return;
                }
                if !matches!(&details.annotations, Some(Annotations::Loading { request: current, .. }) if Arc::ptr_eq(current, &request))
                {
                    return;
                }
                match result {
                    Ok(notes) => {
                        let newer = notes
                            .appointment_version
                            .zip(details.annotations_requested_version)
                            .is_some_and(|(remote, requested)| remote > requested);
                        details.install_annotation_context(notes);
                        if newer {
                            this.svc.wake(Wake::Manual);
                        }
                    }
                    Err(_) => details.annotations = Some(Annotations::Unavailable),
                }
                this.refresh_open_annotations(this.time_off_scope != time_off_scope, cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_annotations(
        &self,
        appointment: &Appointment,
        details: &Details,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let state = details.annotations.as_ref();
        let booking_note = appointment
            .notes
            .as_deref()
            .filter(|note| !note.trim().is_empty());
        let mut content = div()
            .debug_selector(|| "appointment-notes-inline".to_string())
            .flex()
            .flex_none()
            .flex_col()
            .gap_2()
            .mt_2()
            .pt_3()
            .border_t_1()
            .border_color(theme::line())
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::AppointmentAnnotations)),
            )
            .child(self.render_appointment_note(appointment, details, cx));
        match state {
            Some(Annotations::Editing(draft)) => {
                let name = appointment
                    .services
                    .get(draft.position)
                    .map(|s| s.name.as_str());
                content = content.child(self.render_note_draft(draft, appointment, name, cx));
            }
            Some(
                Annotations::Ready(notes)
                | Annotations::Loading {
                    previous: Some(notes),
                    ..
                },
            ) => {
                let mut found = booking_note.is_some();
                let mut add = |heading: Option<&str>, label, body: Option<&str>| {
                    if let Some(body) = body.filter(|text| !text.trim().is_empty()) {
                        found = true;
                        Some(
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .when_some(heading, |line, name| {
                                    line.child(
                                        div()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(name.to_owned()),
                                    )
                                })
                                .child(self.label(label))
                                .child(div().text_sm().child(body.to_owned())),
                        )
                    } else {
                        None
                    }
                };
                content = content
                    .children(add(
                        None,
                        Key::AppointmentCustomerComment,
                        notes.customer_comment.as_deref(),
                    ))
                    .children(add(
                        None,
                        Key::AppointmentBusinessMessage,
                        notes.business_message.as_deref(),
                    ));
                for row in &notes.rows {
                    let name = appointment
                        .services
                        .get(row.service_position)
                        .map(|service| service.name.as_str());
                    content = content
                        .children(add(
                            name,
                            Key::AppointmentInternalNote,
                            row.internal_note.as_deref(),
                        ))
                        .children(add(
                            name,
                            Key::AppointmentCustomerComment,
                            row.customer_comment.as_deref(),
                        ));
                }
                if !found {
                    content = content.child(self.t(Key::AppointmentAnnotationsEmpty));
                }
                if matches!(state, Some(Annotations::Ready(_)))
                    && can_edit_service_annotations(notes, &self.time_off_scope)
                    && details.note_draft.is_none()
                    && self.svc.store.appointment_edit_sync(&appointment.id).ok()
                        != Some(AppointmentEditSync::Pending)
                {
                    content = content.children(appointment.services.iter().enumerate().map(
                        |(position, service)| {
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .child(div().text_sm().child(service.name.clone()))
                                .child(
                                    self.button(
                                        ("edit-internal-note", position),
                                        self.t(Key::EditServiceAnnotations),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.edit_service_annotations(position, cx)
                                        }),
                                    )
                                    .debug_selector(|| format!("appointment-note-edit-{position}")),
                                )
                        },
                    ));
                }
            }
            Some(Annotations::Loading { previous: None, .. }) => {
                content = content.child(
                    div()
                        .text_sm()
                        .child(self.t(Key::AppointmentAnnotationsLoading)),
                );
            }
            Some(Annotations::Unavailable) => {
                content = content
                    .child(
                        div()
                            .text_sm()
                            .child(self.t(Key::AppointmentAnnotationsUnavailable)),
                    )
                    .child(self.button(
                        "retry-appointment-notes",
                        self.t(Key::AppointmentAnnotationsRetry),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.open_annotations(cx)),
                    ));
            }
            None if booking_note.is_none() => {
                content = content.child(self.t(Key::AppointmentAnnotationsEmpty));
            }
            None => {}
        }
        content
    }

    fn render_note_draft(
        &self,
        draft: &NoteDraft,
        appointment: &Appointment,
        name: Option<&str>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let heading = div()
            .text_sm()
            .font_weight(FontWeight::BOLD)
            .child(self.t(Key::EditServiceAnnotations));
        let body = div()
            .debug_selector(|| "appointment-note-editor".to_string())
            .flex()
            .flex_col()
            .gap_2()
            .child(heading)
            .when_some(name, |body, name| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(name.to_owned()),
                )
            });
        if draft.pending.is_some() {
            return body.child(self.t(Key::SavingServiceAnnotations));
        }
        let preference = self.t(if draft.requested {
            Key::RequestedProfessional
        } else {
            Key::NoProfessionalPreference
        });
        let can_edit = self.can_edit_staff_calendar(&appointment.staff_id)
            && can_edit_service_annotations(&draft.notes, &self.time_off_scope);
        let text = draft.text(cx);
        let review_required = draft.awaiting_review(&text, &appointment.staff_id);
        let waiting_for_assignment = draft.needs_current_assignment(appointment);
        let can_review = can_edit
            && draft.refreshing.is_none()
            && draft.rejected.is_none()
            && !waiting_for_assignment;
        let can_save = can_review && !review_required && draft.update(text).is_some();
        let staff_id = appointment.staff_id.clone();
        let reviewed_staff = staff_id.clone();
        let reviewed_version = draft.revision();
        body.child(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .when(draft.refreshing.is_some(), |panel| {
                    panel.child(self.t(Key::AppointmentAnnotationsLoading))
                })
                .when(
                    draft.rejected.is_some() || waiting_for_assignment,
                    |panel| panel.child(self.t(Key::AppointmentNoteRefreshRequired)),
                )
                .when(
                    draft.refreshing.is_none()
                        && (draft.rejected.is_some()
                            || waiting_for_assignment
                            || draft.error == Some(Key::InternalNoteSaveFailed)),
                    |panel| {
                        panel.child(self.button(
                            "refresh-service-note",
                            self.t(Key::AppointmentAnnotationsRetry),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.svc.wake(Wake::Manual);
                                this.open_annotations(cx);
                            }),
                        ))
                    },
                )
                .when(review_required, |panel| {
                    panel.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .p_3()
                            .rounded_md()
                            .bg(theme::conflict_bg())
                            .child(self.label(Key::AppointmentNoteCurrent))
                            .child(div().text_sm().child(if draft.saved_note().is_empty() {
                                self.t(Key::AppointmentNoteNoText).to_owned()
                            } else {
                                draft.saved_note().to_owned()
                            }))
                            .when_some(draft.saved_preference(), |panel, staff| {
                                panel.child(div().text_sm().child(self.staff_name(staff)))
                            })
                            .when(draft.preference_edited && draft.requested, |panel| {
                                panel.child(self.label(Key::ProfessionalPreference)).child(
                                    div()
                                        .text_sm()
                                        .child(self.staff_name(&appointment.staff_id)),
                                )
                            })
                            .child(div().text_sm().child(self.t(Key::AppointmentNoteReview)))
                            .when(can_review, |panel| {
                                panel.child(
                                    self.button(
                                        "keep-service-note-draft",
                                        self.t(Key::AppointmentNoteKeepDraft),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            if let Some(draft) = this.draft()
                                                && draft.revision() == reviewed_version
                                                && draft.pending.is_none()
                                                && draft.refreshing.is_none()
                                                && draft.rejected.is_none()
                                            {
                                                draft.reviewed_note = draft.saved_note().to_owned();
                                                draft.reviewed_preference =
                                                    draft.saved_preference().map(str::to_owned);
                                                draft.reviewed_staff = reviewed_staff.clone();
                                                draft.preserve_note_edit =
                                                    draft.text(cx) != draft.reviewed_note;
                                                draft.preference_edited =
                                                    draft.request_change(&reviewed_staff).is_some();
                                                draft.error = None;
                                                cx.notify();
                                            }
                                        }),
                                    )
                                    .debug_selector(|| "keep-service-note-draft".to_owned()),
                                )
                            }),
                    )
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .flex_wrap()
                .gap_2()
                .child(self.label(Key::ProfessionalPreference))
                .when(!can_edit, |row| row.child(preference))
                .when(can_edit, |row| {
                    row.child(
                        self.button(
                            "toggle-service-preference",
                            preference,
                            if draft.requested {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |this, _, _, cx| {
                                if let Some(draft) = this.draft()
                                    && draft.pending.is_none()
                                {
                                    if !draft.preference_edited {
                                        draft.reviewed_staff = staff_id.clone();
                                        draft.reviewed_preference =
                                            draft.saved_preference().map(str::to_owned);
                                    }
                                    draft.requested = !draft.requested;
                                    draft.preference_edited =
                                        draft.requested != draft.saved_requested();
                                    cx.notify();
                                }
                            }),
                        )
                        .debug_selector(|| "service-preference-toggle".to_owned()),
                    )
                }),
        )
        .child(
            div()
                .id("internal-note-editor")
                .max_h(px(260.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap_1()
                .children(draft.lines.iter().enumerate().map(|(index, line)| {
                    div()
                        .flex()
                        .gap_2()
                        .child(div().min_w_0().flex_1().child(line.clone()))
                        .when(draft.lines.len() > 1, |row| {
                            row.child(self.button(
                                ("remove-note-line", index),
                                self.t(Key::RemoveNoteLine),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    if let Some(draft) = this.draft()
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
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .child(self.button(
                    "add-note-line",
                    self.t(Key::AddNoteLine),
                    Kind::Ghost,
                    cx.listener(|this, _, window, cx| {
                        if let Some(draft) = this.draft()
                            && draft.lines.len() <= 2000
                        {
                            let line = note_field("", false, cx);
                            line.read(cx).focus(window);
                            draft.lines.push(line);
                            cx.notify();
                        }
                    }),
                ))
                .child(self.button(
                    "paste-whole-note",
                    self.t(Key::PasteWholeNote),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| {
                        let Some(draft) = this.draft() else { return };
                        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                            if text.encode_utf16().count() > 2000 {
                                draft.error = Some(Key::InternalNoteTooLong);
                            } else {
                                draft.lines = text
                                    .replace("\r\n", "\n")
                                    .replace('\r', "\n")
                                    .split('\n')
                                    .map(|line| note_field(line, false, cx))
                                    .collect();
                                if draft.rejected.is_none() {
                                    draft.error = None;
                                }
                            }
                            cx.notify();
                        }
                    }),
                ))
                .when(review_required || draft.rejected.is_some(), |actions| {
                    actions.child(self.button(
                        "copy-note-draft",
                        self.t(Key::CopyNoteDraft),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.draft() {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                    draft.text(cx),
                                ));
                            }
                        }),
                    ))
                }),
        )
        .when_some(draft.error, |body, error| {
            body.child(
                div()
                    .text_sm()
                    .text_color(theme::conflict_fg())
                    .child(self.t(error)),
            )
        })
        .child(
            div()
                .flex()
                .gap_2()
                .child(self.button(
                    "cancel-note-edit",
                    self.t(Key::Cancel),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| this.cancel_service_annotations(cx)),
                ))
                .when(draft.rejected.is_none(), |actions| {
                    actions.child(
                        self.button(
                            "save-internal-note",
                            self.t(Key::SaveServiceAnnotations),
                            if can_save { Kind::Primary } else { Kind::Ghost },
                            cx.listener(move |this, _, _, cx| {
                                if can_save {
                                    this.save_service_annotations(cx);
                                }
                            }),
                        )
                        .debug_selector(|| "save-service-note".to_owned())
                        .when(!can_save, |button| button.opacity(0.55).cursor_default()),
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
    async fn service_notes_review_a_live_conflict_and_keep_an_independent_preference(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(880.), px(880.)));
        let snapshot = |visit_version, line_version, preference: Option<&str>, note: &str| {
            serde_json::from_value::<AppointmentAnnotations>(serde_json::json!({
                "appointmentVersion": visit_version,
                "canEdit": true,
                "rows": [{
                    "servicePosition": 0,
                    "version": line_version,
                    "requestedStaffId": preference,
                    "internalNote": note
                }]
            }))
            .unwrap()
        };
        root.update(cx, |root, cx| {
            let appointment = root.view.as_ref().unwrap().columns[0].items[0]
                .appointment
                .clone();
            root.open_details(&appointment.id, cx);
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("expected appointment");
            };
            details.install_annotation_context(snapshot(3, 1, None, "Original note"));
            root.edit_service_annotations(0, cx);
            let draft = root.draft().unwrap();
            draft.lines[0].update(cx, |field, cx| field.set_text("Local draft", cx));
            draft.rejected = Some((3, 1));
            draft.receive(snapshot(3, 1, None, "Original note"), cx);
            assert_eq!(draft.rejected, Some((3, 1)));
            draft.receive(
                snapshot(4, 2, Some(&appointment.staff_id), "Newest saved note"),
                cx,
            );
            assert!(draft.rejected.is_none());
            draft.receive(snapshot(4, 1, None, "Older read"), cx);
            assert_eq!(draft.saved_note(), "Newest saved note");
            assert_eq!(draft.text(cx), "Local draft");
            assert!(draft.requested);
            assert!(draft.awaiting_review(&draft.text(cx), &appointment.staff_id));
            cx.notify();
        });
        cx.run_until_parked();
        let keep = cx.debug_bounds("keep-service-note-draft").unwrap();
        cx.simulate_click(keep.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let draft = root.draft().unwrap();
            assert!(!draft.awaiting_review(&draft.text(cx), &draft.reviewed_staff));
            let payload = draft.update(draft.text(cx)).unwrap();
            assert_eq!(payload.appointment_version, 4);
            assert_eq!(payload.version, 2);
            assert_eq!(payload.requested, None);
            assert_eq!(payload.internal_note, "Local draft");
            let staff = draft.reviewed_staff.clone();
            draft.requested = false;
            draft.preference_edited = true;
            draft.receive(snapshot(5, 3, None, "Newest saved note"), cx);
            assert!(!draft.preference_edited);
            draft.receive(snapshot(6, 4, Some(&staff), "Newest saved note"), cx);
            assert!(draft.requested);
            assert_eq!(draft.update(draft.text(cx)).unwrap().requested, None);
        });
    }

    #[gpui::test]
    async fn the_open_notes_refresh_after_a_synced_change_without_replacing_a_draft(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let id = root.view.as_ref().unwrap().columns[0].items[0]
                    .appointment
                    .id
                    .clone();
                root.open_details(&id, cx);
                let notes = || AppointmentAnnotations {
                    appointment_version: Some(3),
                    can_edit: None,
                    has_visit_checkout: false,
                    default_requested: None,
                    protection: None,
                    customer_comment: None,
                    business_message: None,
                    rows: vec![],
                };
                let ready = |root: &mut Root| {
                    let Overlay::Details(details) = &mut root.overlay else {
                        panic!("missing details");
                    };
                    details.annotations = Some(Annotations::Ready(notes()));
                    details.annotations_requested_version = Some(3);
                };
                ready(root);
                root.status.connectivity = Connectivity::Online;
                root.refresh_open_annotations(false, cx);
                assert!(matches!(&root.overlay, Overlay::Details(details)
                    if matches!(&details.annotations, Some(Annotations::Ready(_)))));

                root.edit_service_annotations(0, cx);
                root.draft().unwrap().lines[0]
                    .update(cx, |field, cx| field.set_text("Unsaved private draft", cx));
                let mut row = root.svc.store.appointment(&id).unwrap().unwrap();
                row.version = 4;
                root.svc
                    .store
                    .apply_page(
                        &[RawChange {
                            seq: 10,
                            entity: "appointment".into(),
                            id: id.clone(),
                            op: "upsert".into(),
                            data: Some(serde_json::to_value(row).unwrap()),
                        }],
                        10,
                    )
                    .unwrap();
                root.refresh_open_annotations(false, cx);
                assert_eq!(root.draft().unwrap().text(cx), "Unsaved private draft");
                let request = root.draft().unwrap().refreshing.clone().unwrap();
                root.cancel_service_annotations(cx);
                assert!(matches!(&root.overlay, Overlay::Details(details)
                    if matches!(&details.annotations, Some(Annotations::Loading { request: current, previous: Some(_) })
                        if Arc::ptr_eq(current, &request))));

                ready(root);
                root.refresh_open_annotations(false, cx);
                assert!(matches!(&root.overlay, Overlay::Details(details)
                    if matches!(&details.annotations, Some(Annotations::Loading { previous: Some(notes), .. })
                        if notes.appointment_version == Some(3))
                        && details.annotations_requested_version == Some(4)));
                let Overlay::Details(details) = &mut root.overlay else {
                    panic!("missing details");
                };
                details.annotations = Some(Annotations::Unavailable);
                root.refresh_open_annotations(false, cx);
                assert!(matches!(&root.overlay, Overlay::Details(details)
                    if matches!(&details.annotations, Some(Annotations::Unavailable))));
                root.refresh_open_annotations(true, cx);
                assert!(matches!(&root.overlay, Overlay::Details(details)
                    if matches!(&details.annotations, Some(Annotations::Loading { .. }))));
            })
            .unwrap();
    }

    #[gpui::test]
    async fn notes_and_the_editor_stay_below_the_services_in_the_same_dialog(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(850.), px(850.)));
        root.update(cx, |root, cx| {
            let id = root.view.as_ref().unwrap().columns[0].items[0]
                .appointment
                .id
                .clone();
            root.open_details(&id, cx);
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("missing details");
            };
            assert!(details.annotations.is_some());
            details.annotations = Some(Annotations::Ready(AppointmentAnnotations {
                appointment_version: Some(3),
                can_edit: Some(true),
                has_visit_checkout: false,
                default_requested: Some(true),
                protection: None,
                customer_comment: Some("Customer message".into()),
                business_message: None,
                rows: vec![],
            }));
        });
        cx.run_until_parked();
        let services = cx.debug_bounds("appointment-details-services").unwrap();
        let notes = cx.debug_bounds("appointment-notes-inline").unwrap();
        assert!(services.bottom() <= notes.top());
        let edit = cx.debug_bounds("appointment-note-edit-0").unwrap();
        cx.simulate_click(edit.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(
                &root.overlay,
                Overlay::Details(details) if matches!(details.annotations, Some(Annotations::Editing(_)))
            ));
        });
        let notes = cx.debug_bounds("appointment-notes-inline").unwrap();
        let editor = cx.debug_bounds("appointment-note-editor").unwrap();
        assert!(notes.top() <= editor.top() && editor.bottom() <= notes.bottom());
        root.update(cx, |root, cx| {
            let draft = root.draft().unwrap();
            assert!(draft.update(draft.text(cx)).is_none());
        });
        let toggle = cx.debug_bounds("service-preference-toggle").unwrap();
        cx.simulate_click(toggle.center(), Default::default());
        root.update(cx, |root, cx| {
            let draft = root.draft().unwrap();
            assert!(draft.original_requested);
            assert!(!draft.requested);
            let payload = draft.update(draft.text(cx)).unwrap();
            assert_eq!(payload.requested, Some(false));
            assert_eq!(payload.version, 0);
            draft.pending = Some(Arc::new(()));
            root.dismiss_overlay(cx);
            let draft = root.draft().expect("a pending save keeps the draft open");
            assert!(draft.pending.take().is_some());
        });
        cx.simulate_resize(gpui::size(px(850.), px(420.)));
        cx.run_until_parked();
        let close = cx.debug_bounds("calendar-details-close").unwrap();
        assert!(close.bottom() < px(420.));
        cx.simulate_click(gpui::point(px(20.), px(210.)), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(
                &root.overlay,
                Overlay::Details(details) if matches!(details.annotations, Some(Annotations::Editing(_)))
            ));
        });
        cx.simulate_keystrokes("escape");
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::None));
            assert_eq!(root.svc.store.outbox_len().unwrap(), 0);
        });
    }

    #[gpui::test]
    async fn note_draft_preserves_blank_lines_and_keeps_changes_out_of_the_replica(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let id = root
                    .view
                    .as_ref()
                    .unwrap()
                    .columns
                    .iter()
                    .flat_map(|column| &column.items)
                    .next()
                    .unwrap()
                    .appointment
                    .id
                    .clone();
                root.open_details(&id, cx);
                let Overlay::Details(details) = &mut root.overlay else {
                    panic!("missing details")
                };
                details.annotations = Some(Annotations::Ready(AppointmentAnnotations {
                    appointment_version: Some(3),
                    can_edit: Some(true),
                    has_visit_checkout: false,
                    default_requested: Some(false),
                    protection: None,
                    customer_comment: None,
                    business_message: None,
                    rows: vec![ServiceAnnotations {
                        service_position: 0,
                        version: 1,
                        requested_staff_id: Some("original-professional".into()),
                        internal_note: Some("First line\n\nThird line".into()),
                        customer_comment: None,
                    }],
                }));
                root.edit_service_annotations(0, cx);
                let draft = root.draft().unwrap();
                assert_eq!(draft.text(cx), "First line\n\nThird line");
                draft.lines[1].update(cx, |field, cx| field.set_text("Second line", cx));
                assert_eq!(draft.text(cx), "First line\nSecond line\nThird line");
                assert!(draft.original_requested);
                let update = draft.update(draft.text(cx)).unwrap();
                assert_eq!(update.version, 1);
                assert!(
                    serde_json::to_value(update)
                        .unwrap()
                        .get("requested")
                        .is_none()
                );
                assert_eq!(root.svc.store.outbox_len().unwrap(), 0);
                assert!(
                    !root
                        .svc
                        .store
                        .appointment(&id)
                        .unwrap()
                        .unwrap()
                        .service_badges
                        .iter()
                        .any(|b| b.internal_note)
                );
            })
            .unwrap();
    }
}
