use super::*;
use std::collections::HashSet;

pub(super) struct BlockForm {
    original: Option<TimeOff>,
    staff_id: String,
    day: NaiveDate,
    start: Entity<TextField>,
    end: Entity<TextField>,
    reason: Entity<TextField>,
    review: Option<BlockReview>,
    confirm_remove: bool,
    error: Option<Key>,
}

struct BlockReview {
    mutation_id: String,
    proposed_times: Option<(DateTime<Utc>, DateTime<Utc>)>,
    unselected_proposal: Option<TimeOff>,
}

#[derive(Clone, Copy)]
pub(super) enum BlockField {
    Start,
    End,
    Reason,
}

impl BlockForm {
    fn reviewing_removal(&self) -> bool {
        self.review
            .as_ref()
            .is_some_and(|review| review.proposed_times.is_none())
    }
}

fn local_input(tz: Tz, instant: DateTime<Utc>) -> String {
    instant
        .with_timezone(&tz)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

fn parse_wall_time(input: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(input.trim(), "%Y-%m-%d %H:%M").ok()
}

fn parse_local_input(tz: Tz, input: &str) -> Option<DateTime<Utc>> {
    let value = parse_wall_time(input)?;
    tz.from_local_datetime(&value)
        .single()
        .map(|t| t.with_timezone(&Utc))
}

fn changed_time(tz: Tz, input: &str, original: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    if let Some(value) = original
        && local_input(tz, value) == input.trim()
    {
        return Some(value);
    }
    parse_local_input(tz, input)
}

pub(super) fn wall_minutes(row: &TimeOff, day: NaiveDate, tz: Tz) -> (u32, u32) {
    let from = row.starts_at.with_timezone(&tz);
    let to = row.ends_at.with_timezone(&tz);
    let start = if from.date_naive() < day {
        0
    } else {
        from.hour() * 60 + from.minute()
    };
    let end = if to.date_naive() > day {
        1440
    } else {
        to.hour() * 60 + to.minute()
    };
    (start, end.max((start + 1).min(1440)))
}

impl Root {
    pub(super) fn can_manage_block(&self, staff: &Staff) -> bool {
        !self.calendar_read_failed
            && (self.time_off_scope == "all" || self.time_off_scope == staff.id)
    }

    pub(super) fn render_time_off_list(&self, cx: &mut Context<Self>) -> gpui::Div {
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for (date, col) in self.calendar_columns() {
            for block in &col.blocks {
                if seen.insert(block.time_off.id.as_str()) {
                    rows.push((date, &col.staff, block));
                }
            }
        }
        rows.sort_by_key(|(_, _, block)| block.time_off.starts_at);
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::TimeOffList)),
                )
                .when(rows.is_empty(), |d| d.child(self.t(Key::TimeOffListEmpty)))
                .child(
                    div()
                        .id("time-off-list")
                        .max_h(px(380.))
                        .overflow_y_scroll()
                        .children(rows.into_iter().map(|(date, staff, block)| {
                            let row = &block.time_off;
                            let starts = local_input(self.tz, row.starts_at);
                            let ends = local_input(self.tz, row.ends_at);
                            div()
                                .id(SharedString::from(format!("block-list-{}", row.id)))
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .border_b_1()
                                .border_color(theme::line())
                                .py_2()
                                .child(
                                    div()
                                        .child(format!(
                                            "{} · {}",
                                            staff.display_name,
                                            row.reason.as_deref().unwrap_or(self.t(Key::TimeOff))
                                        ))
                                        .child(
                                            div()
                                                .text_sm()
                                                .text_color(theme::muted())
                                                .child(format!("{starts} – {ends}")),
                                        )
                                        .when(block.pending, |d| {
                                            d.child(
                                                div()
                                                    .text_xs()
                                                    .text_color(theme::warn())
                                                    .child(self.t(Key::PendingBadge)),
                                            )
                                        }),
                                )
                                .when(self.can_manage_block(staff), |d| {
                                    let row = row.clone();
                                    d.child(self.button(
                                        "edit-block",
                                        self.t(Key::EditTimeOff),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.open_block(Some(row.clone()), date, cx)
                                        }),
                                    ))
                                })
                        })),
                )
                .child(div().flex().justify_end().child(self.button(
                    "close-time-off-list",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| {
                        this.overlay = Overlay::None;
                        cx.notify();
                    }),
                ))),
        )
    }

    pub(super) fn open_block(
        &mut self,
        original: Option<TimeOff>,
        day: NaiveDate,
        cx: &mut Context<Self>,
    ) {
        let preferred = self.preferred_calendar_staff();
        let staff = self
            .staff
            .iter()
            .filter(|staff| staff.active && self.can_manage_block(staff));
        let staff_id = if let Some(row) = &original {
            if !self
                .staff
                .iter()
                .any(|staff| staff.id == row.staff_id && self.can_manage_block(staff))
            {
                return;
            }
            row.staff_id.clone()
        } else if let Some(member) = staff
            .clone()
            .find(|s| Some(s.id.as_str()) == preferred)
            .or_else(|| staff.into_iter().next())
        {
            member.id.clone()
        } else {
            return;
        };
        let (start_at, end_at) = original
            .as_ref()
            .map(|v| {
                (
                    local_input(self.tz, v.starts_at),
                    local_input(self.tz, v.ends_at),
                )
            })
            .unwrap_or_else(|| (format!("{day} 10:00"), format!("{day} 10:30")));
        let reason_value = original
            .as_ref()
            .and_then(|row| row.reason.as_deref())
            .unwrap_or("");
        let t = |key| self.t(key);
        let start = cx.new(|cx| {
            let mut field = TextField::new(t(Key::TimeOffStarts), false, cx);
            field.set_text(&start_at, cx);
            field
        });
        let end = cx.new(|cx| {
            let mut field = TextField::new(t(Key::TimeOffEnds), false, cx);
            field.set_text(&end_at, cx);
            field
        });
        let reason = cx.new(|cx| {
            let mut field = TextField::new(t(Key::TimeOffReason), false, cx);
            field.set_text(reason_value, cx);
            field
        });
        self.overlay = Overlay::Block(Box::new(BlockForm {
            original,
            staff_id,
            day,
            start,
            end,
            reason,
            review: None,
            confirm_remove: false,
            error: None,
        }));
        cx.notify();
    }

    pub(super) fn review_block_conflict(&mut self, mutation_id: &str, cx: &mut Context<Self>) {
        let review = ops::review_time_off_conflict(&self.svc.store, mutation_id);
        if let Ok(review) = review {
            let day = review.saved.starts_at.with_timezone(&self.tz).date_naive();
            let saved_times = (review.saved.starts_at, review.saved.ends_at);
            self.open_block(Some(review.saved), day, cx);
            if let Overlay::Block(form) = &mut self.overlay {
                let proposed_times = review.proposal.as_ref().map(|proposal| {
                    if review.requires_field_selection {
                        return saved_times;
                    }
                    form.start.update(cx, |field, cx| {
                        field.set_text(&local_input(self.tz, proposal.starts_at), cx);
                    });
                    form.end.update(cx, |field, cx| {
                        field.set_text(&local_input(self.tz, proposal.ends_at), cx);
                    });
                    form.reason.update(cx, |field, cx| {
                        field.set_text(proposal.reason.as_deref().unwrap_or(""), cx);
                    });
                    (proposal.starts_at, proposal.ends_at)
                });
                form.review = Some(BlockReview {
                    mutation_id: mutation_id.to_owned(),
                    proposed_times,
                    unselected_proposal: review
                        .proposal
                        .filter(|_| review.requires_field_selection),
                });
                cx.notify();
                return;
            }
        }
        let message = self.t(Key::TimeOffReviewUnavailable).to_owned();
        if let Overlay::Conflicts { error, .. } = &mut self.overlay {
            *error = Some(message);
        }
        self.svc.wake(Wake::Manual);
        cx.notify();
    }

    pub(super) fn use_block_proposal_field(
        &mut self,
        selected: BlockField,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Block(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = &mut form.review else {
            return;
        };
        let (Some(proposal), Some(times)) =
            (&review.unselected_proposal, &mut review.proposed_times)
        else {
            return;
        };
        let (field, text) = match selected {
            BlockField::Start => {
                times.0 = proposal.starts_at;
                (&form.start, local_input(self.tz, proposal.starts_at))
            }
            BlockField::End => {
                times.1 = proposal.ends_at;
                (&form.end, local_input(self.tz, proposal.ends_at))
            }
            BlockField::Reason => (&form.reason, proposal.reason.clone().unwrap_or_default()),
        };
        field.update(cx, |field, cx| field.set_text(&text, cx));
        cx.notify();
    }

    pub(super) fn close_block_form(&mut self, cx: &mut Context<Self>) {
        self.overlay = if matches!(&self.overlay, Overlay::Block(form) if form.review.is_some()) {
            Overlay::Conflicts {
                editing: None,
                error: None,
            }
        } else {
            Overlay::None
        };
        cx.notify();
    }

    pub(super) fn refresh_block_write_scope(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::Block(form)
            if self.time_off_scope != "all" && self.time_off_scope != form.staff_id)
        {
            self.close_block_form(cx);
        }
    }

    pub(super) fn open_selected_block(
        &mut self,
        slot: &slots::SelectedSlot,
        cx: &mut Context<Self>,
    ) {
        if !self
            .staff
            .iter()
            .any(|staff| staff.id == slot.staff_id && self.can_manage_block(staff))
        {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        let Some((start_at, end_at)) = slot.times(self.tz) else {
            return;
        };
        self.open_block(None, slot.date, cx);
        if let Overlay::Block(form) = &mut self.overlay {
            form.staff_id = slot.staff_id.clone();
            form.start.update(cx, |field, cx| {
                field.set_text(&local_input(self.tz, start_at), cx)
            });
            form.end.update(cx, |field, cx| {
                field.set_text(&local_input(self.tz, end_at), cx)
            });
        }
    }

    pub(super) fn save_block(&mut self, cx: &mut Context<Self>) {
        let Overlay::Block(form) = &mut self.overlay else {
            return;
        };
        if self.calendar_read_failed {
            form.error = Some(Key::CalendarReadFailed);
            cx.notify();
            return;
        }
        let (old_start, old_end) = form
            .review
            .as_ref()
            .and_then(|review| review.proposed_times)
            .or_else(|| form.original.as_ref().map(|v| (v.starts_at, v.ends_at)))
            .map(|(from, to)| (Some(from), Some(to)))
            .unwrap_or_default();
        let start = changed_time(self.tz, form.start.read(cx).text(), old_start);
        let end = changed_time(self.tz, form.end.read(cx).text(), old_end);
        let (Some(start), Some(end)) = (start, end) else {
            form.error = Some(Key::TimeOffInvalidRange);
            cx.notify();
            return;
        };
        if start >= end {
            form.error = Some(Key::TimeOffInvalidRange);
            cx.notify();
            return;
        }
        let reason = form.reason.read(cx).text();
        if reason.trim().encode_utf16().count() > 500 {
            form.error = Some(Key::TimeOffReasonLong);
            cx.notify();
            return;
        }
        let result = match (&form.original, &form.review) {
            (Some(old), Some(review)) => ops::retry_reviewed_time_off(
                &mut self.svc.store,
                &review.mutation_id,
                old,
                Some((start, end, reason)),
            ),
            (Some(old), None) => ops::update_time_off(&mut self.svc.store, old, start, end, reason),
            (None, _) => {
                ops::create_time_off(&mut self.svc.store, &form.staff_id, start, end, reason)
                    .map(|_| ())
            }
        };
        match result {
            Ok(()) => {
                self.close_block_form(cx);
                self.edited(cx);
            }
            Err(error) => {
                form.error = Some(match error {
                    sob_core::error::CoreError::TimeOffReviewNeedsChanges => {
                        Key::TimeOffChooseProposal
                    }
                    _ => Key::TimeOffConflict,
                });
                cx.notify();
            }
        }
    }

    pub(super) fn remove_block(&mut self, cx: &mut Context<Self>) {
        let Overlay::Block(form) = &mut self.overlay else {
            return;
        };
        if self.calendar_read_failed {
            form.error = Some(Key::CalendarReadFailed);
            cx.notify();
            return;
        }
        let Some(original) = &form.original else {
            return;
        };
        if !form.confirm_remove {
            form.confirm_remove = true;
            cx.notify();
        } else {
            let result = if let Some(review) = &form.review {
                ops::retry_reviewed_time_off(
                    &mut self.svc.store,
                    &review.mutation_id,
                    original,
                    None,
                )
            } else {
                ops::delete_time_off(&mut self.svc.store, original)
            };
            if result.is_ok() {
                self.close_block_form(cx);
                self.edited(cx);
            } else {
                form.error = Some(Key::TimeOffConflict);
                cx.notify();
            }
        }
    }

    pub(super) fn render_time_off(
        &self,
        block: &calendar::CalendarBlock,
        day: NaiveDate,
        first: u32,
        last: u32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let row = &block.time_off;
        let (start, end) = wall_minutes(row, day, self.tz);
        let start = start.max(first * 60);
        let end = end.min(last * 60);
        if end <= start {
            return div().into_any_element();
        }
        let label = row
            .reason
            .as_deref()
            .unwrap_or_else(|| self.t(Key::TimeOff));
        let can_edit = self
            .staff
            .iter()
            .any(|staff| row.staff_id == staff.id && self.can_manage_block(staff));
        div()
            .id(SharedString::from(format!("block-{}-{day}", row.id)))
            .absolute()
            .top(relative(
                (start - first * 60) as f32 / ((last - first) * 60) as f32,
            ))
            .h(relative(
                (end - start) as f32 / ((last - first) * 60) as f32,
            ))
            .min_h(px(1.))
            .left_0()
            .right_0()
            .overflow_hidden()
            .border_y_1()
            .border_color(theme::line())
            .bg(theme::line_soft())
            .text_color(theme::muted())
            .text_xs()
            .px_2()
            .py_1()
            .child(
                gpui::canvas(
                    |_, _, _| (),
                    |bounds, (), window, _| {
                        let width = f32::from(bounds.size.width);
                        let height = f32::from(bounds.size.height);
                        let mut hatch = gpui::PathBuilder::stroke(px(1.));
                        let mut diagonal = 0.0_f32;
                        while diagonal < width + height {
                            let x = diagonal.min(width);
                            let y = diagonal.min(height);
                            hatch.move_to(bounds.origin + gpui::point(px(x), px(diagonal - x)));
                            hatch.line_to(bounds.origin + gpui::point(px(diagonal - y), px(y)));
                            diagonal += 9.;
                        }
                        if let Ok(path) = hatch.build() {
                            window.paint_path(path, theme::line())
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_none()
                            .px_1()
                            .rounded_sm()
                            .bg(theme::panel())
                            .child(self.t(Key::TimeOff)),
                    )
                    .when(row.reason.is_some(), |line| {
                        line.child(div().min_w_0().truncate().child(label.to_owned()))
                    }),
            )
            .when(block.pending, |d| {
                d.child(
                    div()
                        .text_color(theme::warn())
                        .child(self.t(Key::PendingBadge)),
                )
            })
            .when(can_edit, |d| {
                let row = row.clone();
                d.cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_block(Some(row.clone()), day, cx);
                    }))
            })
            .into_any_element()
    }

    pub(super) fn render_block_form(
        &self,
        form: &BlockForm,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let staff = div().flex().flex_wrap().gap_2().children(
            self.staff
                .iter()
                .filter(|member| member.active && self.can_manage_block(member))
                .map(|member| {
                    let id = member.id.clone();
                    self.chip(
                        SharedString::from(format!("block-staff-{id}")),
                        member.display_name.clone(),
                        form.staff_id == id,
                        cx.listener(move |this, _, _, cx| {
                            if let Overlay::Block(form) = &mut this.overlay {
                                form.staff_id.clone_from(&id);
                            }
                            cx.notify();
                        }),
                    )
                }),
        );
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child(self.t(
                if form.original.is_some() {
                    Key::EditTimeOff
                } else {
                    Key::BlockTime
                },
            )))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::TimeOffHint)),
            )
            .child(self.label(Key::Staff))
            .when(form.original.is_none(), |d| d.child(staff))
            .when(form.original.is_some(), |d| {
                d.child(self.staff_name(&form.staff_id))
            })
            .when_some(
                form.original.as_ref().filter(|_| form.review.is_some()),
                |d, saved| {
                    d.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .p_3()
                            .rounded_md()
                            .bg(theme::conflict_bg())
                            .child(self.label(Key::TimeOffSaved))
                            .child(div().text_sm().child(format!(
                                "{} – {}",
                                local_input(self.tz, saved.starts_at),
                                local_input(self.tz, saved.ends_at)
                            )))
                            .when_some(saved.reason.clone(), |panel, reason| {
                                panel.child(div().text_sm().child(reason))
                            }),
                    )
                },
            )
            .when_some(
                form.review
                    .as_ref()
                    .and_then(|review| review.unselected_proposal.as_ref()),
                |d, proposal| {
                    let choices = [
                        (
                            "block-use-start",
                            BlockField::Start,
                            Key::TimeOffStarts,
                            local_input(self.tz, proposal.starts_at),
                        ),
                        (
                            "block-use-end",
                            BlockField::End,
                            Key::TimeOffEnds,
                            local_input(self.tz, proposal.ends_at),
                        ),
                        (
                            "block-use-reason",
                            BlockField::Reason,
                            Key::TimeOffReason,
                            proposal
                                .reason
                                .clone()
                                .unwrap_or_else(|| self.t(Key::TimeOffNoReason).to_owned()),
                        ),
                    ];
                    d.child(self.label(Key::TimeOffChooseProposal))
                        .children(choices.map(|(id, field, label, value)| {
                            self.button(
                                id,
                                format!("{}: {value}", self.t(label)),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.use_block_proposal_field(field, cx)
                                }),
                            )
                        }))
                },
            )
            .when(form.review.is_some() && !form.reviewing_removal(), |d| {
                d.child(self.label(Key::TimeOffProposed))
            })
            .when(!form.reviewing_removal(), |d| {
                d.child(self.label(Key::TimeOffStarts))
                    .child(form.start.clone())
                    .child(self.label(Key::TimeOffEnds))
                    .child(form.end.clone())
                    .child(self.button(
                        "block-full-day",
                        self.t(Key::TimeOffWholeDay),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| {
                            if let Overlay::Block(form) = &this.overlay {
                                let day = parse_wall_time(form.start.read(cx).text())
                                    .map(|value| value.date())
                                    .unwrap_or(form.day);
                                let (start, end) = calendar::local_day_range(this.tz, day);
                                form.start.update(cx, |f, cx| {
                                    f.set_text(&local_input(this.tz, start), cx)
                                });
                                form.end
                                    .update(cx, |f, cx| f.set_text(&local_input(this.tz, end), cx));
                            }
                        }),
                    ))
                    .child(self.label(Key::TimeOffReason))
                    .child(form.reason.clone())
            })
            .when_some(form.error, |d, key| {
                d.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(key)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .justify_end()
                    .when(
                        form.original.is_some()
                            && (form.review.is_none() || form.reviewing_removal()),
                        |d| {
                            d.child(self.button(
                                "block-remove",
                                self.t(if form.confirm_remove {
                                    Key::ConfirmDeleteTimeOff
                                } else {
                                    Key::DeleteTimeOff
                                }),
                                Kind::Danger,
                                cx.listener(|this, _, _, cx| this.remove_block(cx)),
                            ))
                        },
                    )
                    .child(self.button(
                        "block-close",
                        self.t(if form.review.is_some() {
                            Key::Back
                        } else {
                            Key::Close
                        }),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.close_block_form(cx)),
                    ))
                    .when(!form.reviewing_removal(), |actions| {
                        actions.child(self.button(
                            "block-save",
                            self.t(Key::TimeOffSave),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.save_block(cx)),
                        ))
                    }),
            );
        self.modal_with_height(
            div().child(
                div()
                    .id("block-form-scroll")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            ),
            (viewport.width - px(24.)).clamp(px(240.), px(560.)),
            (viewport.height - px(24.)).clamp(px(240.), px(720.)),
            Some(cx),
        )
    }
}
