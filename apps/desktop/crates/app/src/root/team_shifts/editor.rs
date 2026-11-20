use super::*;
use sob_core::http::{
    DatedShiftCopy, DatedShiftDay, DatedShiftEdit, DatedShiftSelection, ReviewedDatedShift,
};
use sob_core::sync::TransportError;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Weekly,
    Closed,
    Custom,
}

enum Stage {
    Loading,
    Draft,
    Reviewing,
    Reviewed(Arc<ReviewedDatedShift>),
    Saving,
    Retry(Arc<ReviewedDatedShift>),
    Stale,
}

#[derive(Clone, Copy)]
enum Discard {
    Close,
    Reload,
}

pub(super) struct Editor {
    staff_id: String,
    staff_name: String,
    date: NaiveDate,
    request: Arc<()>,
    original: Option<DatedShiftDay>,
    stage: Stage,
    mode: Mode,
    ranges: Vec<(Entity<TextField>, Entity<TextField>)>,
    copy: Option<CopyFields>,
    error: Option<Key>,
    preview_detail: Option<String>,
    pending_appointment_id: Option<String>,
    discard: Option<Discard>,
}

impl Editor {
    fn new(staff_id: String, staff_name: String, date: NaiveDate) -> Self {
        Self {
            staff_id,
            staff_name,
            date,
            request: Arc::new(()),
            original: None,
            stage: Stage::Draft,
            mode: Mode::Weekly,
            ranges: Vec::new(),
            copy: None,
            error: None,
            preview_detail: None,
            pending_appointment_id: None,
            discard: None,
        }
    }

    pub(super) fn appointment_edited(&mut self, id: &str) {
        if matches!(self.stage, Stage::Reviewed(_)) {
            self.pending_appointment_id = Some(id.to_owned());
            self.stage = Stage::Draft;
            self.error = Some(Key::ShiftAppointmentEdited);
        }
    }

    pub(super) fn busy(&self) -> bool {
        matches!(
            self.stage,
            Stage::Loading | Stage::Reviewing | Stage::Saving
        )
    }

    fn edit(&self, cx: &App) -> Option<DatedShiftEdit> {
        let ranges = match self.mode {
            Mode::Weekly => None,
            Mode::Closed => Some(Vec::new()),
            Mode::Custom => {
                Some(DatedShiftEdit::parse_ranges(self.ranges.iter().map(
                    |(start, end)| (start.read(cx).text(), end.read(cx).text()),
                ))?)
            }
        };
        Some(DatedShiftEdit {
            date: self.date,
            ranges,
        })
    }

    fn dirty(&self, cx: &App) -> bool {
        matches!(self.stage, Stage::Retry(_))
            || match &self.copy {
                Some(copy) => copy.dirty(self.date, cx),
                None => self.original.as_ref().is_some_and(|original| {
                    self.edit(cx)
                        .is_none_or(|edit| edit.ranges != original.ranges)
                }),
            }
    }

    fn selection(&self, timezone: chrono_tz::Tz, cx: &App) -> Result<DatedShiftSelection, Key> {
        if let Some(copy) = &self.copy {
            return copy
                .selection(cx)
                .map(DatedShiftSelection::Copy)
                .ok_or(Key::ShiftInvalidCopy);
        }
        let edit = self.edit(cx).ok_or(Key::ShiftInvalidRanges)?;
        if edit.has_nonexistent_time(timezone) {
            return Err(Key::ShiftNonexistentTime);
        }
        if self
            .original
            .as_ref()
            .is_some_and(|original| original.ranges == edit.ranges)
        {
            return Err(Key::ShiftNoChange);
        }
        Ok(DatedShiftSelection::Edit { changes: [edit] })
    }

    pub(super) fn can_close(&mut self, cx: &App) -> bool {
        if self.busy() || self.discard.take().is_some() {
            return false;
        }
        if self.dirty(cx) {
            self.discard = Some(Discard::Close);
            return false;
        }
        true
    }
}

struct CopyFields {
    source: Entity<TextField>,
    target: Entity<TextField>,
    days: Entity<TextField>,
    weeks: Entity<TextField>,
}

impl CopyFields {
    fn new(date: NaiveDate, format: &'static str, cx: &mut Context<Root>) -> Self {
        let mut field = |placeholder, text: &str| {
            cx.new(|cx| {
                let mut field = TextField::new(placeholder, false, cx);
                field.set_text(text, cx);
                field
            })
        };
        Self {
            source: field(format, &date.to_string()),
            target: field(format, ""),
            days: field("1–7", "7"),
            weeks: field("1–12", "1"),
        }
    }

    fn selection(&self, cx: &App) -> Option<DatedShiftCopy> {
        let date = |value: &str| {
            let value = value.trim();
            let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
            (date.to_string() == value).then_some(date)
        };
        DatedShiftCopy::new(
            date(self.source.read(cx).text())?,
            self.days.read(cx).text().trim().parse().ok()?,
            date(self.target.read(cx).text())?,
            self.weeks.read(cx).text().trim().parse().ok()?,
        )
    }

    fn dirty(&self, date: NaiveDate, cx: &App) -> bool {
        self.source.read(cx).text() != date.to_string()
            || !self.target.read(cx).text().is_empty()
            || self.days.read(cx).text() != "7"
            || self.weeks.read(cx).text() != "1"
    }
}

pub(super) fn range_fields(
    range: Option<&DateShiftRange>,
    cx: &mut Context<Root>,
) -> (Entity<TextField>, Entity<TextField>) {
    let mut field = |value: &str| {
        cx.new(|cx| {
            let mut result = TextField::new("HH:MM", false, cx);
            result.set_text(value, cx);
            result
        })
    };
    let start = range.map_or("", |r| r.start_time.get(..5).unwrap_or(&r.start_time));
    let end = range.map_or("", |r| r.end_time.get(..5).unwrap_or(&r.end_time));
    (field(start), field(end))
}

impl Root {
    pub(super) fn can_edit_staff_hours(&self) -> bool {
        self.time_off_scope == "all" && self.status.connectivity == Connectivity::Online
    }

    fn dated_shift_editor(&mut self) -> Option<&mut Editor> {
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return None;
        };
        desk.editor.as_mut()
    }

    pub(super) fn open_dated_shift(
        &mut self,
        staff_id: String,
        staff_name: String,
        date: NaiveDate,
        cx: &mut Context<Self>,
    ) {
        if !self.can_edit_staff_hours() {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return;
        };
        let mut editor = Editor::new(staff_id.clone(), staff_name, date);
        let request = editor.request.clone();
        editor.stage = Stage::Loading;
        desk.editor = Some(editor);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.dated_shift(&staff_id, date) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Some(editor) = this
                    .dated_shift_editor()
                    .filter(|editor| Arc::ptr_eq(&editor.request, &request))
                else {
                    return;
                };
                editor.stage = Stage::Draft;
                if let Ok(day) = result {
                    editor.mode = match day.ranges.as_deref() {
                        None => Mode::Weekly,
                        Some([]) => Mode::Closed,
                        Some(_) => Mode::Custom,
                    };
                    if day.effective_ranges.len() <= 8 {
                        editor.ranges = day
                            .effective_ranges
                            .iter()
                            .map(|range| range_fields(Some(range), cx))
                            .collect();
                    }
                    editor.original = Some(day);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn open_shift_copy(
        &mut self,
        staff_id: String,
        staff_name: String,
        date: NaiveDate,
        cx: &mut Context<Self>,
    ) {
        if !self.can_edit_staff_hours() {
            return;
        }
        let format = self.t(Key::ShiftDatePlaceholder);
        if let Overlay::TeamShifts(desk) = &mut self.overlay
            && desk.editor.is_none()
        {
            let mut editor = Editor::new(staff_id, staff_name, date);
            editor.copy = Some(CopyFields::new(date, format, cx));
            desk.editor = Some(editor);
            cx.notify();
        }
    }

    fn reload_dated_shift_editor(&mut self, discard: bool, cx: &mut Context<Self>) {
        if let Some(editor) = self.dated_shift_editor().filter(|editor| !editor.busy()) {
            if !discard && editor.dirty(cx) {
                editor.discard = Some(Discard::Reload);
                cx.notify();
                return;
            }
            let (id, name, date) = (
                editor.staff_id.clone(),
                editor.staff_name.clone(),
                editor.date,
            );
            self.open_dated_shift(id, name, date, cx);
        }
    }

    fn discard_shift_draft(&mut self, cx: &mut Context<Self>) {
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        match editor.discard.take() {
            Some(Discard::Close) => {
                desk.editor = None;
                cx.notify();
            }
            Some(Discard::Reload) => self.reload_dated_shift_editor(true, cx),
            None => {}
        }
    }

    fn preview_dated_shift(&mut self, cx: &mut Context<Self>) {
        if !self.can_edit_staff_hours() {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let timezone = self.tz;
        let sync_error = match &self.overlay {
            Overlay::TeamShifts(desk) => desk
                .editor
                .as_ref()
                .and_then(|editor| editor.pending_appointment_id.as_deref())
                .and_then(|id| match self.svc.store.appointment_edit_sync(id) {
                    Ok(AppointmentEditSync::Settled) => None,
                    Ok(AppointmentEditSync::NeedsResolution) => Some(Key::ShiftAppointmentRejected),
                    Ok(AppointmentEditSync::Pending) | Err(_) => Some(Key::ShiftAppointmentPending),
                }),
            _ => None,
        };
        if sync_error == Some(Key::ShiftAppointmentPending) {
            self.svc.wake(Wake::Manual);
        }
        let Some(editor) = self.dated_shift_editor().filter(|editor| {
            matches!(editor.stage, Stage::Draft)
                && (editor.copy.is_some() || editor.original.is_some())
        }) else {
            return;
        };
        if let Some(error) = sync_error {
            editor.error = Some(error);
            cx.notify();
            return;
        }
        editor.pending_appointment_id = None;
        editor.preview_detail = None;
        let selection = match editor.selection(timezone, cx) {
            Ok(selection) => selection,
            Err(error) => {
                editor.error = Some(error);
                cx.notify();
                return;
            }
        };
        let staff_id = editor.staff_id.clone();
        let request = editor.request.clone();
        editor.stage = Stage::Reviewing;
        editor.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.review_dated_shifts(&staff_id, selection) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Some(editor) = this
                    .dated_shift_editor()
                    .filter(|editor| Arc::ptr_eq(&editor.request, &request))
                else {
                    return;
                };
                editor.stage = match result {
                    Ok(review)
                        if editor.copy.is_some()
                            || review.review.changes.first().is_some_and(|change| {
                                editor.original.as_ref() == Some(&change.previous)
                            }) =>
                    {
                        Stage::Reviewed(Arc::new(review))
                    }
                    Ok(_) => Stage::Stale,
                    Err(error) => {
                        editor.error = Some(Key::ShiftPreviewFailed);
                        if let TransportError::BadRequest(reason) = error {
                            editor.preview_detail = Some(reason.chars().take(240).collect());
                        }
                        Stage::Draft
                    }
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn review_with_current_appointment(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.dated_shift_editor() else {
            return;
        };
        if editor.error == Some(Key::ShiftAppointmentRejected) {
            editor.pending_appointment_id = None;
            self.preview_dated_shift(cx);
        }
    }

    fn save_dated_shift(&mut self, cx: &mut Context<Self>) {
        if !self.can_edit_staff_hours() {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Some(editor) = self.dated_shift_editor() else {
            return;
        };
        let (Stage::Reviewed(review) | Stage::Retry(review)) = &editor.stage else {
            return;
        };
        let was_retry = matches!(editor.stage, Stage::Retry(_));
        let review = review.clone();
        let request = editor.request.clone();
        editor.stage = Stage::Saving;
        editor.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let sent = review.clone();
            let result = cx
                .background_executor()
                .spawn(async move { transport.commit_dated_shifts(&sent) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Overlay::TeamShifts(desk) = &mut this.overlay else {
                    return;
                };
                let Some(editor) = desk
                    .editor
                    .as_mut()
                    .filter(|editor| Arc::ptr_eq(&editor.request, &request))
                else {
                    return;
                };
                match result {
                    Ok(Some(_)) => {
                        desk.editor = None;
                        this.svc.wake(Wake::Manual);
                    }
                    Ok(None) => editor.stage = Stage::Stale,
                    Err(TransportError::Offline(_) | TransportError::Server(_)) => {
                        editor.stage = Stage::Retry(review);
                    }
                    Err(TransportError::RateLimited(_)) => {
                        editor.stage = if was_retry {
                            Stage::Retry(review)
                        } else {
                            Stage::Reviewed(review)
                        };
                        editor.error = Some(Key::ShiftTryLater);
                    }
                    Err(_) if was_retry => {
                        editor.stage = Stage::Retry(review);
                        editor.error = Some(Key::ShiftRetryRejected);
                    }
                    Err(_) => {
                        editor.stage = Stage::Draft;
                        editor.error = Some(Key::ShiftSaveRejected);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_shift_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(if editor.copy.is_some() {
                        Key::ShiftCopyPeriod
                    } else {
                        Key::ShiftEditDay
                    })),
            )
            .when(!editor.busy(), |header| {
                header.child(self.button(
                    "shift-editor-back",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
                ))
            });
        let description = if editor.copy.is_some() {
            editor.staff_name.clone()
        } else {
            format!(
                "{} · {}",
                editor.staff_name,
                i18n::date_label(self.locale, editor.date)
            )
        };
        let body = if editor.discard.is_some() {
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(self.t(if matches!(editor.stage, Stage::Retry(_)) {
                    Key::ShiftDiscardUncertain
                } else {
                    Key::ShiftDiscardPrompt
                }))
                .child(self.button(
                    "keep-shift-draft",
                    self.t(Key::Cancel),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| {
                        if let Some(editor) = this.dated_shift_editor() {
                            editor.discard = None;
                            cx.notify();
                        }
                    }),
                ))
                .child(self.button(
                    "discard-shift-draft",
                    self.t(Key::ShiftDiscard),
                    Kind::Danger,
                    cx.listener(|this, _, _, cx| this.discard_shift_draft(cx)),
                ))
        } else {
            match &editor.stage {
                Stage::Loading | Stage::Reviewing | Stage::Saving => {
                    div().child(self.t(Key::ShiftChecking))
                }
                Stage::Stale if editor.copy.is_some() => div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.t(Key::ShiftCopyStale))
                    .child(self.button(
                        "shift-copy-change-dates",
                        self.t(Key::ShiftChangeCopyDates),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| {
                            if let Some(editor) = this.dated_shift_editor() {
                                editor.stage = Stage::Draft;
                                cx.notify();
                            }
                        }),
                    )),
                Stage::Stale => div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.t(Key::ShiftStaleReview))
                    .child(self.button(
                        "shift-editor-reload",
                        self.t(Key::ShiftReloadDay),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.reload_dated_shift_editor(false, cx)),
                    )),
                Stage::Reviewed(review) | Stage::Retry(review) => self.render_shift_review(
                    review,
                    editor.copy.is_some(),
                    matches!(editor.stage, Stage::Retry(_)),
                    cx,
                ),
                Stage::Draft if editor.original.is_none() && editor.copy.is_none() => div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.t(Key::ShiftLoadFailed))
                    .child(self.button(
                        "shift-editor-reload",
                        self.t(Key::ShiftReloadDay),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.reload_dated_shift_editor(false, cx)),
                    )),
                Stage::Draft => match &editor.copy {
                    Some(copy) => self.render_copy_fields(copy, cx),
                    None => self.render_shift_fields(editor, cx),
                },
            }
        };
        div().child(header).child(description).child(
            div()
                .id("dated-shift-editor-scroll")
                .min_h_0()
                .overflow_y_scroll()
                .child(body)
                .when_some(editor.error, |body, error| {
                    body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
                })
                .when(
                    editor.error == Some(Key::ShiftAppointmentRejected)
                        && self.can_edit_staff_hours()
                        && editor.discard.is_none(),
                    |body| {
                        body.child(self.button(
                            "shift-review-current-appointment",
                            self.t(Key::ShiftReviewCurrentAppointment),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.review_with_current_appointment(cx)),
                        ))
                    },
                )
                .when_some(editor.preview_detail.as_ref(), |body, detail| {
                    body.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(detail.clone()),
                    )
                }),
        )
    }

    fn render_shift_fields(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let controls = div().flex().flex_wrap().gap_2().children(
            [
                (Mode::Weekly, Key::ShiftUseWeekly),
                (Mode::Closed, Key::ShiftCloseDay),
                (Mode::Custom, Key::ShiftCustom),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, (mode, label))| {
                self.chip(
                    ("shift-editor-mode", index),
                    self.t(label),
                    editor.mode == mode,
                    cx.listener(move |this, _, _, cx| {
                        if let Some(editor) = this.dated_shift_editor() {
                            editor.mode = mode;
                            editor.error = None;
                            if mode == Mode::Custom && editor.ranges.is_empty() {
                                editor.ranges.push(range_fields(None, cx));
                            }
                            cx.notify();
                        }
                    }),
                )
            }),
        );
        div()
            .flex()
            .flex_col()
            .gap_3()
            .when_some(editor.original.as_ref(), |body, original| {
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(self.label(Key::ShiftBefore))
                        .child(self.dated_hours_label(original)),
                )
            })
            .child(controls)
            .when(editor.mode == Mode::Custom, |form| {
                form.child(div().text_sm().child(self.t(Key::ShiftTimeFormat)))
                    .children(
                        editor
                            .ranges
                            .iter()
                            .enumerate()
                            .map(|(index, (start, end))| {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(div().flex_1().child(start.clone()))
                                    .child(div().flex_1().child(end.clone()))
                                    .when(editor.ranges.len() > 1, |row| {
                                        row.child(self.button(
                                            ("shift-remove-range", index),
                                            self.t(Key::ShiftRemoveRange),
                                            Kind::Ghost,
                                            cx.listener(move |this, _, _, cx| {
                                                if let Some(editor) = this.dated_shift_editor()
                                                    && index < editor.ranges.len()
                                                {
                                                    editor.ranges.remove(index);
                                                    cx.notify();
                                                }
                                            }),
                                        ))
                                    })
                            }),
                    )
                    .when(editor.ranges.len() < 8, |form| {
                        form.child(self.button(
                            "shift-add-range",
                            self.t(Key::ShiftAddRange),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                if let Some(editor) = this.dated_shift_editor()
                                    && editor.ranges.len() < 8
                                {
                                    editor.ranges.push(range_fields(None, cx));
                                    cx.notify();
                                }
                            }),
                        ))
                    })
            })
            .when(self.can_edit_staff_hours(), |form| {
                form.child(self.shift_preview_button(cx))
            })
    }

    fn shift_preview_button(&self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        self.button(
            "shift-editor-preview",
            self.t(Key::ShiftReview),
            Kind::Primary,
            cx.listener(|this, _, _, cx| this.preview_dated_shift(cx)),
        )
    }

    fn render_copy_fields(&self, copy: &CopyFields, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().text_sm().child(self.t(Key::ShiftCopyHelp)))
            .children(
                [
                    (Key::ShiftCopySource, &copy.source),
                    (Key::ShiftCopyDays, &copy.days),
                    (Key::ShiftCopyTarget, &copy.target),
                    (Key::ShiftCopyWeeks, &copy.weeks),
                ]
                .map(|(key, field)| {
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(self.label(key))
                        .child(field.clone())
                }),
            )
            .when(self.can_edit_staff_hours(), |form| {
                form.child(self.shift_preview_button(cx))
            })
    }

    fn dated_hours_label(&self, day: &DatedShiftDay) -> String {
        let hours = if day.effective_ranges.is_empty() {
            self.t(Key::ShiftClosed).to_owned()
        } else {
            day.effective_ranges
                .iter()
                .map(|r| {
                    format!(
                        "{}–{}",
                        r.start_time.get(..5).unwrap_or(&r.start_time),
                        r.end_time.get(..5).unwrap_or(&r.end_time)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        if day.ranges.is_none() {
            format!("{} · {}", hours, self.t(Key::ShiftUseWeekly))
        } else {
            hours
        }
    }

    fn render_shift_review(
        &self,
        review: &ReviewedDatedShift,
        copy: bool,
        retry: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let review = &review.review;
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().text_sm().child(i18n::fill(
                self.t(Key::ShiftReviewTimezone),
                &[("timezone", review.timezone.name())],
            )))
            .when(!review.conflicts.is_empty(), |body| {
                body.child(self.schedule_conflict_list(
                    &review.conflicts,
                    review.timezone,
                    !retry,
                    cx,
                ))
            })
            .when(review.withdrawn_offers > 0, |body| {
                body.child(i18n::fill(
                    self.t(Key::ShiftWithdrawnOffers),
                    &[("n", &review.withdrawn_offers.to_string())],
                ))
            })
            .children(review.changes.iter().map(|change| {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .when(copy, |row| {
                        row.rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .p_2()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                                "{} · {}",
                                i18n::date_label(self.locale, change.date),
                                change.date
                            )))
                    })
                    .child(self.label(Key::ShiftBefore))
                    .child(self.dated_hours_label(&change.previous))
                    .child(self.label(Key::ShiftAfter))
                    .child(self.dated_hours_label(&change.next))
                    .when(change.previous.version == change.next.version, |row| {
                        row.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::ShiftNoChange)),
                        )
                    })
            }))
            .when(retry, |body| body.child(self.t(Key::ShiftSaveUncertain)))
            .when(!retry, |body| {
                body.child(self.button(
                    "shift-review-back",
                    self.t(Key::Cancel),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| {
                        if let Some(editor) = this.dated_shift_editor()
                            && matches!(editor.stage, Stage::Reviewed(_))
                        {
                            editor.stage = Stage::Draft;
                            cx.notify();
                        }
                    }),
                ))
            })
            .when(self.can_edit_staff_hours(), |body| {
                body.child(self.button(
                    "shift-review-save",
                    self.t(if retry {
                        Key::ShiftRetrySave
                    } else {
                        Key::ShiftConfirm
                    }),
                    Kind::Primary,
                    cx.listener(|this, _, _, cx| this.save_dated_shift(cx)),
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn closing_a_changed_shift_requires_explicit_discard(cx: &mut TestAppContext) {
        let (_dir, window) = super::super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let date = root.date;
                let mut editor = Editor {
                    staff_id: "fixture-staff".into(),
                    staff_name: "Fixture staff".into(),
                    date,
                    request: Arc::new(()),
                    original: Some(DatedShiftDay {
                        date,
                        version: 0,
                        ranges: None,
                        effective_ranges: vec![],
                    }),
                    stage: Stage::Draft,
                    mode: Mode::Weekly,
                    ranges: vec![],
                    copy: None,
                    error: None,
                    preview_detail: None,
                    pending_appointment_id: None,
                    discard: None,
                };
                assert!(editor.can_close(cx));
                editor.mode = Mode::Closed;
                assert!(!editor.can_close(cx));
                assert!(matches!(editor.discard, Some(Discard::Close)));
                assert!(!editor.can_close(cx));
                assert!(editor.discard.is_none());
                assert_eq!(editor.edit(cx).unwrap().ranges, Some(vec![]));
                editor.copy = Some(CopyFields::new(date, "YYYY-MM-DD", cx));
                assert!(editor.can_close(cx));
                let target = editor.copy.as_ref().unwrap().target.clone();
                target.update(cx, |field, cx| field.set_text("not a date", cx));
                assert!(editor.copy.as_ref().unwrap().selection(cx).is_none());
                assert!(!editor.can_close(cx));
                assert!(matches!(editor.discard, Some(Discard::Close)));
            })
            .unwrap();
    }
}
