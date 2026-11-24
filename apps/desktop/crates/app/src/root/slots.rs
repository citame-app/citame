use super::*;

#[derive(Clone)]
pub(super) struct SelectedSlot {
    pub date: NaiveDate,
    pub staff_id: String,
    pub start: i64,
    pub end: i64,
}

impl SelectedSlot {
    pub fn time_label(&self) -> String {
        format!(
            "{:02}:{:02}–{:02}:{:02}",
            self.start / 60,
            self.start % 60,
            self.end / 60,
            self.end % 60
        )
    }

    pub fn times(&self, tz: Tz) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        slot_times(tz, self.date, self.start, self.end)
    }
}

pub(super) fn slot_times(
    tz: Tz,
    date: NaiveDate,
    start: i64,
    end: i64,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let start = salon_local_instant(tz, date, start)?;
    let end = salon_local_instant(tz, date, end)?;
    (start < end).then_some((start, end))
}

pub(super) struct SlotDrag {
    date: NaiveDate,
    staff_id: String,
    first: i64,
    last: i64,
    step: i64,
    minutes_per_pixel: f32,
    origin_y: gpui::Pixels,
    original_scroll_y: gpui::Pixels,
    anchor_y: gpui::Pixels,
    pointer: gpui::Point<gpui::Pixels>,
}

impl SlotDrag {
    pub fn selection(&self, scroll_y: gpui::Pixels) -> Option<SelectedSlot> {
        if (self.pointer.y - self.anchor_y).abs() < px(5.) {
            return None;
        }
        let minute = |y| f32::from(y - self.origin_y) * self.minutes_per_pixel + self.first as f32;
        let anchor = minute(self.anchor_y);
        let current = minute(self.pointer.y - scroll_y + self.original_scroll_y);
        let step = self.step as f32;
        let start = ((anchor.min(current) / step).floor() as i64 * self.step)
            .clamp(self.first, self.last - 1);
        let end = ((anchor.max(current) / step).ceil() as i64 * self.step)
            .max(start + 1)
            .min(self.last);
        Some(SelectedSlot {
            date: self.date,
            staff_id: self.staff_id.clone(),
            start,
            end,
        })
    }
}

impl Root {
    pub(super) fn calendar_slot_step(&self) -> i64 {
        self.svc
            .store
            .salon_settings()
            .ok()
            .flatten()
            .map_or(15, |settings| {
                settings.slot_granularity_minutes.clamp(1, 60)
            })
    }

    pub(super) fn start_slot_drag(
        &mut self,
        column: usize,
        bounds: gpui::Bounds<gpui::Pixels>,
        first: u32,
        last: u32,
        event: &gpui::MouseDownEvent,
    ) {
        if !matches!(self.overlay, Overlay::None) || event.button != gpui::MouseButton::Left {
            return;
        }
        self.slot_drag = None;
        let columns = self.calendar_columns();
        let Some((date, staff_column)) = columns.get(column) else {
            return;
        };
        let staff_id = staff_column.staff.id.clone();
        let height = f32::from(bounds.size.height);
        if height <= 0. {
            return;
        }
        let minutes_per_pixel = ((last - first) * 60) as f32 / height;
        let minute =
            f32::from(event.position.y - bounds.top()) * minutes_per_pixel + (first * 60) as f32;
        let y = minute * HOUR_PX / 60.;
        let blocked = staff_column.blocks.iter().any(|block| {
            let (start, end) = blocks::wall_minutes(&block.time_off, *date, self.tz);
            (start..end).contains(&(minute as u32))
        });
        let on_card = self.calendar_layout.get().is_some_and(|layout| {
            let column = &layout.columns[column];
            let x = f32::from(event.position.x - bounds.left()) / f32::from(bounds.size.width);
            column
                .bounds
                .iter()
                .zip(&column.lanes)
                .any(|(&(start, end), &(lane, count))| {
                    (start..end).contains(&y)
                        && ((lane as f32 / count as f32)..((lane + 1) as f32 / count as f32))
                            .contains(&x)
                })
        });
        if blocked || on_card {
            return;
        }
        self.slot_drag = Some(SlotDrag {
            date: *date,
            staff_id,
            first: i64::from(first) * 60,
            last: i64::from(last) * 60,
            minutes_per_pixel,
            step: self.calendar_slot_step(),
            origin_y: bounds.top(),
            original_scroll_y: self.vertical_scroll.handle.offset().y,
            anchor_y: event.position.y,
            pointer: event.position,
        });
    }

    pub(super) fn drag_slot(&mut self, event: &gpui::MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some(drag) = &mut self.slot_drag {
            if event.dragging() {
                drag.pointer = event.position;
            } else {
                self.slot_drag = None;
            }
            cx.notify();
        }
    }

    pub(super) fn finish_slot_drag(&mut self, event: &gpui::MouseUpEvent, cx: &mut Context<Self>) {
        if event.button != gpui::MouseButton::Left {
            return;
        }
        if let Some(mut drag) = self.slot_drag.take() {
            drag.pointer = event.position;
            if matches!(self.overlay, Overlay::None)
                && let Some(slot) = drag.selection(self.vertical_scroll.handle.offset().y)
            {
                self.overlay = Overlay::Slot(slot);
            }
            cx.notify();
        }
    }

    pub(super) fn render_slot_tooltip(
        &self,
        viewport: gpui::Size<gpui::Pixels>,
        title_height: gpui::Pixels,
    ) -> Option<gpui::Div> {
        let drag = self.slot_drag.as_ref()?;
        let handle = &self.vertical_scroll.handle;
        let slot = drag.selection(handle.offset().y)?;
        let width = px(116.).min(viewport.width);
        let height = px(28.);
        let inset = px(6.);
        let body = handle.bounds();
        let min_top = (body.top() + inset).min((viewport.height - height).max(px(0.)));
        let max_top = (body.bottom().min(viewport.height) - height - inset).max(min_top);
        let above = drag.pointer.y - height - inset;
        let top = if above >= min_top {
            above
        } else {
            drag.pointer.y + inset
        };
        let max_left = (viewport.width - width - inset).max(px(0.));
        let right_of_pointer = drag.pointer.x + px(12.);
        let left = if right_of_pointer <= max_left {
            right_of_pointer
        } else {
            drag.pointer.x - width - px(12.)
        };
        Some(
            div()
                .absolute()
                .debug_selector(|| "calendar-slot-tooltip".to_string())
                .left(left.clamp(px(0.), max_left))
                .top((top.clamp(min_top, max_top) - title_height).max(px(0.)))
                .w(width)
                .h(height)
                .flex()
                .items_center()
                .justify_center()
                .rounded_md()
                .bg(theme::panel())
                .border_1()
                .border_color(theme::accent())
                .shadow_md()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .child(slot.time_label()),
        )
    }

    pub(super) fn render_slot_actions(
        &self,
        slot: &SelectedSlot,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let booking = slot.clone();
        let block = slot.clone();
        let valid = slot.times(self.tz).is_some();
        let accessible = self
            .staff
            .iter()
            .any(|staff| staff.id == slot.staff_id && self.can_manage_block(staff));
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::SelectedSlot)),
                )
                .child(format!(
                    "{} · {} · {}",
                    self.staff_name(&slot.staff_id),
                    i18n::date_label(self.locale, slot.date),
                    slot.time_label()
                ))
                .when(!valid, |body| {
                    body.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(Key::SelectedSlotInvalid)),
                    )
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .justify_end()
                        .child(self.button(
                            "slot-cancel",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.overlay = Overlay::None;
                                cx.notify();
                            }),
                        ))
                        .when(valid && accessible, |row| {
                            row.child(
                                self.button(
                                    "slot-block",
                                    self.t(Key::BlockTime),
                                    Kind::Ghost,
                                    cx.listener(move |this, _, _, cx| {
                                        this.open_selected_block(&block, cx)
                                    }),
                                )
                                .debug_selector(|| "calendar-slot-block".to_string()),
                            )
                        })
                        .when(valid, |row| {
                            row.child(
                                self.button(
                                    "slot-book",
                                    self.t(Key::NewAppointment),
                                    Kind::Primary,
                                    cx.listener(move |this, _, window, cx| {
                                        this.open_new(window, cx);
                                        if let Overlay::New(form) = &mut this.overlay {
                                            form.date = booking.date;
                                            form.staff_id = Some(booking.staff_id.clone());
                                            form.minutes = booking.start;
                                            form.selected_end = Some(booking.end);
                                        }
                                    }),
                                )
                                .debug_selector(|| "calendar-slot-book".to_string()),
                            )
                        }),
                ),
        )
    }
}
