use super::*;
use std::collections::HashSet;

pub(super) struct BlockForm {
    original: Option<TimeOff>,
    staff_id: String,
    day: NaiveDate,
    start: Entity<TextField>,
    end: Entity<TextField>,
    reason: Entity<TextField>,
    confirm_remove: bool,
    error: Option<Key>,
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
        self.time_off_scope == "all" || self.time_off_scope == staff.id
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
        let preferred = if self.calendar_mode == CalendarMode::Week {
            Some(self.week_staff_id.as_str())
        } else {
            None
        };
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
            confirm_remove: false,
            error: None,
        }));
        cx.notify();
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
        let (old_start, old_end) = form
            .original
            .as_ref()
            .map(|v| (Some(v.starts_at), Some(v.ends_at)))
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
        let result = match &form.original {
            Some(old) => ops::update_time_off(&mut self.svc.store, old, start, end, reason),
            None => ops::create_time_off(&mut self.svc.store, &form.staff_id, start, end, reason)
                .map(|_| ()),
        };
        if result.is_ok() {
            self.overlay = Overlay::None;
            self.edited(cx);
        } else {
            form.error = Some(Key::TimeOffConflict);
            cx.notify();
        }
    }

    pub(super) fn remove_block(&mut self, cx: &mut Context<Self>) {
        let Overlay::Block(form) = &mut self.overlay else {
            return;
        };
        let Some(original) = &form.original else {
            return;
        };
        if !form.confirm_remove {
            form.confirm_remove = true;
            cx.notify();
        } else if ops::delete_time_off(&mut self.svc.store, original).is_ok() {
            self.overlay = Overlay::None;
            self.edited(cx);
        } else {
            form.error = Some(Key::TimeOffConflict);
            cx.notify();
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

    pub(super) fn render_block_form(&self, form: &BlockForm, cx: &mut Context<Self>) -> gpui::Div {
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
        self.modal(
            div()
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
                .child(self.label(Key::TimeOffStarts))
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
                            form.start
                                .update(cx, |f, cx| f.set_text(&local_input(this.tz, start), cx));
                            form.end
                                .update(cx, |f, cx| f.set_text(&local_input(this.tz, end), cx));
                        }
                    }),
                ))
                .child(self.label(Key::TimeOffReason))
                .child(form.reason.clone())
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
                        .when(form.original.is_some(), |d| {
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
                        })
                        .child(self.button(
                            "block-close",
                            self.t(Key::Close),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.overlay = Overlay::None;
                                cx.notify();
                            }),
                        ))
                        .child(self.button(
                            "block-save",
                            self.t(Key::TimeOffSave),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.save_block(cx)),
                        )),
                ),
        )
    }
}
