use super::*;
use chrono::{Days, Months};
use sob_core::team_shifts::week_start;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CalendarMode {
    Day,
    Week,
    Month,
    List,
}

impl CalendarMode {
    pub(super) const ALL: [Self; 4] = [Self::Day, Self::Week, Self::Month, Self::List];

    pub(super) fn is_overview(self) -> bool {
        matches!(self, Self::Month | Self::List)
    }

    pub(super) fn route_name(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::List => "list",
        }
    }

    pub(super) fn button_id(self) -> &'static str {
        match self {
            Self::Day => "view-day",
            Self::Week => "view-week",
            Self::Month => "view-month",
            Self::List => "view-list",
        }
    }

    pub(super) fn label(self) -> Key {
        match self {
            Self::Day => Key::ViewDay,
            Self::Week => Key::ViewWeek,
            Self::Month => Key::ViewMonth,
            Self::List => Key::ViewList,
        }
    }

    pub(super) fn shift(self, date: NaiveDate, direction: i64) -> NaiveDate {
        match self {
            Self::Month if direction < 0 => date.checked_sub_months(Months::new(1)),
            Self::Month => date.checked_add_months(Months::new(1)),
            Self::Week | Self::List => date.checked_add_signed(Span::days(7 * direction)),
            Self::Day => date.checked_add_signed(Span::days(direction)),
        }
        .unwrap_or(date)
    }

    pub(super) fn period(
        self,
        store: &sob_core::store::Store,
        date: NaiveDate,
        entire_team: bool,
    ) -> sob_core::error::Result<Vec<DayView>> {
        match self {
            Self::Day => Ok(Vec::new()),
            Self::Week if entire_team => calendar::team_calendar_week(store, date),
            Self::Week => calendar::week_view(store, date),
            Self::List => calendar::overview_days(store, date, 7),
            Self::Month => {
                let (first, days) =
                    month_range(date).ok_or_else(|| CoreError::Invalid("Invalid month".into()))?;
                calendar::overview_days(store, first, days)
            }
        }
    }
}

pub(super) fn parse_calendar_date(input: &str) -> Option<NaiveDate> {
    let input = input.trim();
    let date = NaiveDate::parse_from_str(input, "%Y-%m-%d").ok()?;
    (date.year() > 0 && input.len() == 10 && date.to_string() == input).then_some(date)
}

fn month_range(date: NaiveDate) -> Option<(NaiveDate, u32)> {
    let first = date.with_day(1)?;
    let last = first.checked_add_months(Months::new(1))?.pred_opt()?;
    let start = first.checked_sub_days(Days::new(first.weekday().num_days_from_monday().into()))?;
    let end = last.checked_add_days(Days::new(
        7 - u64::from(last.weekday().num_days_from_monday()),
    ))?;
    Some((
        start,
        end.signed_duration_since(start)
            .num_days()
            .try_into()
            .ok()?,
    ))
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
        let anchor = if self.calendar_mode == CalendarMode::Week {
            week_start(date)
        } else {
            Some(date)
        };
        let Some(anchor) = anchor else {
            if let Overlay::CalendarDate(picker) = &mut self.overlay {
                picker.invalid = true;
                cx.notify();
            }
            return;
        };
        self.overlay = Overlay::None;
        self.slot_drag = None;
        self.pending_local_today = false;
        self.date = anchor;
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

    pub(super) fn includes_calendar_staff(&self, id: &str) -> bool {
        self.overview_staff.is_empty() || self.overview_staff.contains(id)
    }

    pub(super) fn preferred_calendar_staff(&self) -> Option<&str> {
        if self.calendar_mode == CalendarMode::Week && !self.week_team {
            return (!self.week_staff_id.is_empty()).then_some(&self.week_staff_id);
        }
        if self.team_calendar_visible() {
            return self
                .team_calendar_staff()
                .find(|member| self.includes_calendar_staff(&member.id))
                .map(|member| member.id.as_str());
        }
        self.staff
            .iter()
            .find(|member| self.overview_staff.contains(&member.id))
            .map(|m| m.id.as_str())
    }

    pub(super) fn render_overview_staff_filter(&self, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .px_4()
            .py_2()
            .bg(theme::panel())
            .child(self.button(
                "overview-all-staff",
                self.t(Key::CalendarAllStaff),
                if self.overview_staff.is_empty() {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| {
                    root.overview_staff.clear();
                    root.calendar_layout.take();
                    cx.notify();
                }),
            ))
            .children(
                self.staff
                    .iter()
                    .filter(|staff| {
                        !self.team_calendar_visible()
                            || self
                                .team_calendar_staff()
                                .any(|member| member.id == staff.id)
                    })
                    .map(|member| {
                        let id = member.id.clone();
                        self.button(
                            SharedString::from(format!("overview-staff-{id}")),
                            member.display_name.clone(),
                            if self.overview_staff.contains(&id) {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if !root.overview_staff.remove(&id) {
                                    root.overview_staff.insert(id.clone());
                                }
                                root.calendar_layout.take();
                                cx.notify();
                            }),
                        )
                    }),
            )
    }

    pub(super) fn render_overview_filter(&self, cx: &mut Context<Self>) -> gpui::Div {
        let statuses = [
            (None, Key::SalesAllStatuses),
            (Some(AppointmentStatus::Booked), Key::ReportBooked),
            (Some(AppointmentStatus::Completed), Key::Completed),
            (Some(AppointmentStatus::NoShow), Key::NoShow),
            (Some(AppointmentStatus::Cancelled), Key::CalendarCancelled),
        ];
        div()
            .flex()
            .flex_col()
            .child(self.render_overview_staff_filter(cx))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .px_4()
                    .pb_2()
                    .child(div().w(px(225.)).child(self.overview_search.clone()))
                    .children(
                        statuses
                            .into_iter()
                            .enumerate()
                            .filter(|(_, (status, _))| {
                                self.overview_show_cancelled
                                    || *status != Some(AppointmentStatus::Cancelled)
                            })
                            .map(|(index, (status, label))| {
                                self.button(
                                    ("overview-status", index),
                                    self.t(label),
                                    if self.overview_status == status {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        root.overview_status = status;
                                        cx.notify();
                                    }),
                                )
                            }),
                    )
                    .child(self.button(
                        "overview-show-cancelled",
                        self.t(if self.overview_show_cancelled {
                            Key::CalendarHideCancelled
                        } else {
                            Key::CalendarShowCancelled
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.overview_show_cancelled = !root.overview_show_cancelled;
                            if !root.overview_show_cancelled
                                && root.overview_status == Some(AppointmentStatus::Cancelled)
                            {
                                root.overview_status = None;
                            }
                            cx.notify();
                        }),
                    )),
            )
    }

    pub(super) fn render_calendar_overview(&self, cx: &mut Context<Self>) -> Stateful<gpui::Div> {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let filter = calendar::OverviewFilter::new(
            self.overview_search.read(cx).text(),
            self.overview_status,
            self.overview_show_cancelled,
        );
        let content = if self.calendar_mode == CalendarMode::Month {
            self.render_month_overview(today, &filter, cx)
        } else {
            self.render_list_overview(today, &filter, cx)
        };
        div()
            .id(SharedString::from(format!(
                "calendar-overview-{}-{}",
                self.calendar_mode.route_name(),
                self.date
            )))
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_scroll()
            .bg(theme::panel())
            .child(content)
    }

    fn overview_items<'a>(
        &self,
        day: &'a DayView,
        filter: &calendar::OverviewFilter,
    ) -> Vec<(&'a Staff, &'a CalendarItem)> {
        let mut rows = Vec::new();
        for column in &day.columns {
            if self.includes_calendar_staff(&column.staff.id) {
                rows.extend(
                    column
                        .items
                        .iter()
                        .filter(|item| filter.matches(item))
                        .map(|item| (&column.staff, item)),
                );
            }
        }
        rows.sort_by(|(_, a), (_, b)| {
            a.appointment
                .starts_at
                .cmp(&b.appointment.starts_at)
                .then(a.appointment.id.cmp(&b.appointment.id))
        });
        rows
    }

    pub(super) fn overview_day_button(
        &self,
        day: NaiveDate,
        label: String,
        emphasis: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        self.button(
            SharedString::from(format!("overview-day-{day}")),
            label,
            if emphasis { Kind::Primary } else { Kind::Ghost },
            cx.listener(move |root, _, _, cx| {
                if matches!(root.overlay, Overlay::None) {
                    root.open_overview_day(day, cx);
                }
            }),
        )
    }

    fn open_overview_day(&mut self, day: NaiveDate, cx: &mut Context<Self>) {
        self.pending_local_today = false;
        self.date = day;
        self.set_calendar_mode(CalendarMode::Day, cx);
    }

    fn render_month_overview(
        &self,
        today: NaiveDate,
        filter: &calendar::OverviewFilter,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .min_w(px(875.))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .border_b_1()
                    .border_color(theme::line())
                    .children(self.period_views.iter().take(7).map(|day| {
                        div()
                            .flex_1()
                            .min_w_0()
                            .px_3()
                            .py_2()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(i18n::weekday_short(self.locale, day.date.weekday()))
                    })),
            )
            .children(self.period_views.chunks(7).map(|week| {
                div()
                    .flex()
                    .border_b_1()
                    .border_color(theme::line())
                    .children(week.iter().map(|day| {
                        let date = day.date;
                        let rows = self.overview_items(day, filter);
                        let day_label = if date == today {
                            self.t(Key::Today).to_owned()
                        } else {
                            date.day().to_string()
                        };
                        let count = i18n::fill(
                            self.t(Key::CalendarBookedCount),
                            &[("n", &rows.len().to_string())],
                        );
                        let count_label = if rows.len() > 3 {
                            i18n::fill(
                                self.t(Key::CalendarShowDay),
                                &[("n", &rows.len().to_string())],
                            )
                        } else {
                            count
                        };
                        div()
                            .flex_1()
                            .min_w_0()
                            .min_h(px(187.))
                            .flex()
                            .flex_col()
                            .border_r_1()
                            .border_color(theme::line())
                            .px_2()
                            .py_2()
                            .gap_1()
                            .when(date.month() != self.date.month(), |cell| {
                                cell.bg(theme::line_soft())
                            })
                            .child(self.overview_day_button(date, day_label, date == today, cx))
                            .children(
                                rows.iter()
                                    .take(3)
                                    .map(|(_, item)| self.overview_appointment(date, item, cx)),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("overview-count-{date}")))
                                    .debug_selector(|| format!("overview-count-{date}"))
                                    .text_xs()
                                    .text_color(theme::muted())
                                    .cursor_pointer()
                                    .hover(|style| style.text_color(theme::accent()))
                                    .on_click(cx.listener(move |root, _, _, cx| {
                                        if matches!(root.overlay, Overlay::None) {
                                            root.date = date;
                                            root.pending_local_today = false;
                                            root.set_calendar_mode(CalendarMode::List, cx);
                                        }
                                    }))
                                    .child(count_label),
                            )
                    }))
            }))
    }

    fn render_list_overview(
        &self,
        today: NaiveDate,
        filter: &calendar::OverviewFilter,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .children(self.period_views.iter().map(|day| {
                let rows = self.overview_items(day, filter);
                let totals = calendar::scheduled_value(rows.iter().map(|(_, item)| *item));
                let scheduled = totals
                    .iter()
                    .map(|(currency, amount)| i18n::amount_label(self.locale, *amount, currency))
                    .collect::<Vec<_>>()
                    .join(" · ");
                let date = day.date;
                let count = i18n::fill(
                    self.t(Key::CalendarBookedCount),
                    &[("n", &rows.len().to_string())],
                );
                div()
                    .flex()
                    .flex_col()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::line())
                    .p_3()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(self.overview_day_button(
                                date,
                                i18n::date_label(self.locale, date),
                                date == today,
                                cx,
                            ))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap_3()
                                    .text_sm()
                                    .child(count)
                                    .when(!scheduled.is_empty(), |summary| {
                                        summary.child(format!(
                                            "{} · {scheduled}",
                                            self.t(Key::CalendarScheduledValue)
                                        ))
                                    }),
                            ),
                    )
                    .when(rows.is_empty(), |body| {
                        body.child(
                            div()
                                .px_2()
                                .py_3()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::CalendarEmptyDay)),
                        )
                    })
                    .children(rows.into_iter().map(|(staff, item)| {
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(self.overview_appointment(date, item, cx))
                            .child(
                                div()
                                    .w(px(128.))
                                    .flex_none()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .truncate()
                                    .child(staff.display_name.clone()),
                            )
                    }))
            }))
    }

    pub(super) fn overview_appointment(
        &self,
        day: NaiveDate,
        item: &CalendarItem,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let appointment = &item.appointment;
        let id = appointment.id.clone();
        let status = match appointment.status {
            AppointmentStatus::Booked => None,
            AppointmentStatus::Cancelled => Some(Key::CalendarCancelled),
            AppointmentStatus::Completed => Some(Key::Completed),
            AppointmentStatus::NoShow => Some(Key::NoShow),
        };
        let (background, border) = self.calendar_item_colors(item);
        let services = appointment
            .services
            .iter()
            .map(|service| service.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let title = format!("{} · {services}", item.client_name);
        let times = format!(
            "{}–{}",
            self.hhmm(appointment.starts_at),
            self.hhmm(appointment.ends_at)
        );
        div()
            .id(SharedString::from(format!("overview-{day}-{id}")))
            .debug_selector(|| format!("overview-appointment-{day}-{id}"))
            .flex_1()
            .min_w_0()
            .w_full()
            .rounded_md()
            .border_l_4()
            .border_color(border)
            .bg(background)
            .px_2()
            .py_1()
            .text_xs()
            .cursor_pointer()
            .hover(|style| style.opacity(0.85))
            .on_click(cx.listener(move |root, _, _, cx| {
                if matches!(root.overlay, Overlay::None) {
                    root.open_details(&id, cx);
                }
            }))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_1()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(times))
                    .when_some(status, |row, status| row.child(self.t(status)))
                    .children(
                        appointment_badges::calendar(item)
                            .into_iter()
                            .flatten()
                            .map(|badge| badge.chip(self.t(badge.1), true)),
                    ),
            )
            .child(div().truncate().text_color(theme::text()).child(title))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::tests::{EXISTING, desk, open};
    use gpui::TestAppContext;

    #[test]
    fn months_follow_complete_local_weeks_and_clamp_month_end_navigation() {
        let march = "2026-03-09".parse().unwrap();
        assert_eq!(
            month_range(march),
            Some(("2026-02-23".parse().unwrap(), 42))
        );
        let february = "2027-02-01".parse().unwrap();
        assert_eq!(month_range(february), Some((february, 28)));
        assert_eq!(
            CalendarMode::Month.shift("2026-01-31".parse().unwrap(), 1),
            "2026-02-28".parse().unwrap()
        );
        assert_eq!(
            CalendarMode::List.shift(march, 1),
            "2026-03-16".parse().unwrap()
        );
    }

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
            root.week_team = true;
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
            assert_eq!(root.date.to_string(), "2026-11-16");
            assert!(root.team_calendar_visible());
            assert!(!root.pending_local_today);
        });
    }

    #[gpui::test]
    async fn overview_modes_open_local_appointments_and_preserve_the_cloud_route(
        cx: &mut TestAppContext,
    ) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1100.), px(880.)));
        let date: NaiveDate = "2026-03-09".parse().unwrap();
        let selector = "overview-appointment-2026-03-09-01a1d81e-0000-7000-8000-0000000000e1";
        for mode in [CalendarMode::Month, CalendarMode::List] {
            root.update(cx, |root, cx| root.set_calendar_mode(mode, cx));
            cx.run_until_parked();
            let card = cx
                .debug_bounds(selector)
                .expect("the local booking is visible");
            cx.simulate_click(card.center(), Default::default());
            cx.run_until_parked();
            root.update(cx, |root, _| {
                assert!(
                    matches!(&root.overlay, Overlay::Details(details) if details.id == EXISTING)
                );
                root.close_appointment_details(false);
                let search: HashMap<_, _> = root
                    .cloud_calendar_url()
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
                assert_eq!(search["view"], mode.route_name());
                assert_eq!(search["date"], date.to_string());
            });
        }
        root.update(cx, |root, cx| {
            let other = root
                .staff
                .iter()
                .find(|member| member.display_name == "Bea")
                .unwrap()
                .id
                .clone();
            root.overview_staff.insert(other.clone());
            let day = root
                .period_views
                .iter()
                .find(|day| day.date == date)
                .unwrap();
            assert!(
                root.overview_items(day, &calendar::OverviewFilter::default())
                    .is_empty()
            );
            assert!(
                root.cloud_calendar_url()
                    .unwrap()
                    .query_pairs()
                    .any(|(key, value)| key == "staff" && value == other)
            );
            root.open_overview_day(date, cx);
            assert_eq!(root.calendar_mode, CalendarMode::Day);
            assert_eq!(root.calendar_columns().len(), 1);
            assert_eq!(root.calendar_columns()[0].1.staff.id, other);
        });
    }

    #[gpui::test]
    async fn month_overflow_keeps_the_selected_staff_and_included_cancellations(
        cx: &mut TestAppContext,
    ) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1100.), px(950.)));
        root.update(cx, |root, cx| {
            let store = &mut root.svc.store;
            let appointment = store.appointment(EXISTING).unwrap().unwrap();
            let mut changes = Vec::new();
            for position in 1..=3 {
                let sequence = 20 + position;
                let mut row = appointment.clone();
                row.id = uuid::Uuid::now_v7().to_string();
                row.starts_at += Span::hours(position);
                row.ends_at += Span::hours(position);
                if position == 1 {
                    row.services[0].currency = "EUR".to_owned();
                    row.services[0].price_cents = 2_540;
                }
                if position == 3 {
                    row.status = AppointmentStatus::Cancelled;
                }
                changes.push(RawChange {
                    seq: sequence,
                    entity: "appointment".into(),
                    id: row.id.clone(),
                    op: "upsert".into(),
                    data: Some(serde_json::to_value(row).unwrap()),
                });
            }
            store.apply_page(&changes, 23).unwrap();
            root.overview_staff.insert(appointment.staff_id);
            root.overview_show_cancelled = true;
            root.set_calendar_mode(CalendarMode::Month, cx);
        });
        cx.run_until_parked();
        let count = cx.debug_bounds("overview-count-2026-03-09").unwrap();
        cx.simulate_click(count.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert_eq!(root.calendar_mode, CalendarMode::List);
            assert_eq!(root.overview_staff.len(), 1);
            let query =
                calendar::OverviewFilter::new("haircut", None, root.overview_show_cancelled);
            let items = root.overview_items(&root.period_views[0], &query);
            assert_eq!(items.len(), 4);
            assert_eq!(
                items.last().unwrap().1.appointment.status,
                AppointmentStatus::Cancelled
            );
            let totals = calendar::scheduled_value(items.iter().map(|(_, item)| *item));
            assert_eq!(totals["ARS"], 2);
            assert_eq!(totals["EUR"], 2_540);
        });
    }

    #[gpui::test]
    async fn overview_preserves_local_midnight_overlap_and_day_mode_rules(cx: &mut TestAppContext) {
        let (_directory, window) = open(cx);
        window
            .update(cx, |root, _, cx| {
                let before: NaiveDate = "2026-03-08".parse().unwrap();
                let after = before.succ_opt().unwrap();
                let store = &mut root.svc.store;
                let mut appointment = store.appointment(EXISTING).unwrap().unwrap();
                appointment.starts_at = "2026-03-09T02:00:00Z".parse().unwrap();
                appointment.ends_at = "2026-03-09T04:00:00Z".parse().unwrap();
                appointment.status = AppointmentStatus::Cancelled;
                store
                    .apply_page(
                        &[RawChange {
                            seq: 20,
                            entity: "appointment".into(),
                            id: EXISTING.into(),
                            op: "upsert".into(),
                            data: Some(serde_json::to_value(appointment).unwrap()),
                        }],
                        20,
                    )
                    .unwrap();
                let overview = calendar::overview_days(store, before, 2).unwrap();
                for day in overview {
                    assert_eq!(
                        day.columns
                            .iter()
                            .map(|column| column.items.len())
                            .sum::<usize>(),
                        1
                    );
                }
                assert!(
                    calendar::day_view(store, before)
                        .unwrap()
                        .columns
                        .iter()
                        .all(|column| column.items.is_empty())
                );
                root.date = after;
                root.set_calendar_mode(CalendarMode::List, cx);
                assert_eq!(
                    root.overview_items(
                        &root.period_views[0],
                        &calendar::OverviewFilter::new("", None, true)
                    )
                    .len(),
                    1
                );
            })
            .unwrap();
    }
}
