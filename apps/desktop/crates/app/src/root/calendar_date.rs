use super::calendar_overview::month_range;
use super::*;
use sob_core::team_shifts::week_start;

pub(super) fn parse_calendar_date(input: &str) -> Option<NaiveDate> {
    let input = input.trim();
    let date = NaiveDate::parse_from_str(input, "%Y-%m-%d").ok()?;
    (date.year() > 0 && input.len() == 10 && date.to_string() == input).then_some(date)
}

pub(super) struct DatePicker {
    month: NaiveDate,
    input: Entity<TextField>,
    invalid: bool,
    _subscription: Subscription,
}

impl Root {
    pub(super) fn calendar_date_button(&self, cx: &mut Context<Self>) -> Stateful<gpui::Div> {
        let label = if self.calendar_mode == CalendarMode::Month {
            format!(
                "{} {}",
                i18n::month_short(self.locale, self.date.month()),
                self.date.year()
            )
        } else {
            i18n::date_label(self.locale, self.date)
        };
        self.button(
            "calendar-date",
            label,
            Kind::Ghost,
            cx.listener(|root, _, window, cx| root.open_calendar_date(window, cx)),
        )
        .debug_selector(|| "calendar-date".to_owned())
        .px_2()
    }

    fn open_calendar_date(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Overlay::None) {
            return;
        }
        let input = cx.new(|cx| {
            let mut field = TextField::new(self.t(Key::ShiftDatePlaceholder), false, cx);
            field.set_text(&self.date.to_string(), cx);
            field
        });
        let subscription = cx.subscribe(&input, |root: &mut Root, _, event, cx| match event {
            FieldEvent::Submit => root.apply_calendar_date(cx),
            FieldEvent::Changed => {
                if let Overlay::CalendarDate(picker) = &mut root.overlay
                    && picker.invalid
                {
                    picker.invalid = false;
                    cx.notify();
                }
            }
            _ => {}
        });
        input.read(cx).focus(window);
        self.overlay = Overlay::CalendarDate(DatePicker {
            month: self.date.with_day(1).unwrap_or(self.date),
            input,
            invalid: false,
            _subscription: subscription,
        });
        cx.notify();
    }

    fn shift_picker_month(&mut self, direction: i64, cx: &mut Context<Self>) {
        if let Overlay::CalendarDate(picker) = &mut self.overlay {
            let month = CalendarMode::Month.shift(picker.month, direction);
            if (1..=9999).contains(&month.year()) {
                picker.month = month;
                cx.notify();
            }
        }
    }

    fn apply_calendar_date(&mut self, cx: &mut Context<Self>) {
        let Overlay::CalendarDate(picker) = &mut self.overlay else {
            return;
        };
        if let Some(date) = parse_calendar_date(picker.input.read(cx).text()) {
            self.select_calendar_date(date, cx);
        } else {
            picker.invalid = true;
            cx.notify();
        }
    }

    fn select_calendar_date(&mut self, date: NaiveDate, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Overlay::CalendarDate(_)) {
            return;
        }
        if self.calendar_mode == CalendarMode::Week && week_start(date).is_none() {
            if let Overlay::CalendarDate(picker) = &mut self.overlay {
                picker.invalid = true;
                cx.notify();
            }
            return;
        }
        self.overlay = Overlay::None;
        self.slot_drag = None;
        self.pending_local_today = false;
        self.date = date;
        self.reload(cx);
    }

    pub(super) fn render_calendar_date(
        &self,
        picker: &DatePicker,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let dates: Vec<_> = month_range(picker.month)
            .map(|(first, days)| first.iter_days().take(days as usize).collect())
            .unwrap_or_default();
        let month = format!(
            "{} {}",
            i18n::month_short(self.locale, picker.month.month()),
            picker.month.year()
        );
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::CalendarJumpDate)),
                    )
                    .child(self.button(
                        "close-calendar-date",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(self.button(
                        "calendar-date-prev",
                        "<",
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.shift_picker_month(-1, cx)),
                    ))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(month))
                    .child(self.button(
                        "calendar-date-next",
                        ">",
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.shift_picker_month(1, cx)),
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .children(dates.iter().take(7).map(|day| {
                                div()
                                    .flex_1()
                                    .text_sm()
                                    .text_center()
                                    .text_color(theme::muted())
                                    .child(i18n::weekday_short(self.locale, day.weekday()))
                            })),
                    )
                    .children(dates.chunks(7).map(|week| {
                        div().flex().gap_1().children(week.iter().map(|date| {
                            let date = *date;
                            if date.year() <= 0 || date.year() > 9999 {
                                return div().flex_1().into_any_element();
                            }
                            self.button(
                                SharedString::from(format!("calendar-date-pick-{date}")),
                                date.day().to_string(),
                                if date == self.date {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    root.select_calendar_date(date, cx)
                                }),
                            )
                            .debug_selector(|| format!("calendar-date-pick-{date}"))
                            .flex_1()
                            .px_1()
                            .py_1()
                            .when(date == today && date != self.date, |day| {
                                day.text_color(theme::accent())
                            })
                            .when(date.month() != picker.month.month(), |day| {
                                day.opacity(0.65)
                            })
                            .into_any_element()
                        }))
                    })),
            )
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::ShiftDate)),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "calendar-date-input".to_owned())
                                    .child(picker.input.clone()),
                            ),
                    )
                    .child(self.button(
                        "calendar-date-submit",
                        self.t(Key::CalendarJumpDate),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.apply_calendar_date(cx)),
                    )),
            )
            .when(picker.invalid, |body| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::ShiftInvalidDate)),
                )
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).clamp(px(280.), px(390.)),
            (viewport.height - px(32.)).clamp(px(220.), px(540.)),
            Some(cx),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::team_calendar::WeekLayout;
    use super::*;
    use crate::root::tests::desk;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn date_picker_can_jump_by_text_or_day_and_preserves_the_active_calendar(
        cx: &mut TestAppContext,
    ) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1100.), px(780.)));
        cx.run_until_parked();
        let date_button = cx.debug_bounds("calendar-date").unwrap();
        cx.simulate_click(date_button.center(), Default::default());
        cx.run_until_parked();
        let march = cx
            .debug_bounds("calendar-date-pick-2026-03-18")
            .expect("month grid");
        cx.simulate_click(march.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert_eq!(root.date.to_string(), "2026-03-18");
            assert!(matches!(root.overlay, Overlay::None));
            root.set_calendar_mode(CalendarMode::Week, cx);
            root.week_layout = WeekLayout::Team;
            root.reload(cx);
        });
        cx.run_until_parked();
        let date_button = cx.debug_bounds("calendar-date").unwrap();
        cx.simulate_click(date_button.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let Overlay::CalendarDate(picker) = &root.overlay else {
                panic!("expected date picker")
            };
            picker
                .input
                .update(cx, |field, cx| field.set_text("2026-02-30", cx));
            root.apply_calendar_date(cx);
            let Overlay::CalendarDate(picker) = &root.overlay else {
                panic!("invalid date closed the picker")
            };
            assert!(picker.invalid);
            let input = picker.input.clone();
            input.update(cx, |field, cx| field.set_text("2026-11-19", cx));
        });
        cx.simulate_keystrokes("enter");
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::None));
            assert_eq!(root.date.to_string(), "2026-11-19");
            assert_eq!(root.calendar_columns()[0].0.to_string(), "2026-11-16");
            let url = root.cloud_calendar_url().unwrap();
            assert!(
                url.query_pairs()
                    .any(|(key, value)| key == "date" && value == "2026-11-19")
            );
            assert!(root.team_calendar_visible());
            assert!(!root.pending_local_today);
        });
    }
}
