use super::team_calendar::WeekLayout;
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
        week_layout: WeekLayout,
    ) -> sob_core::error::Result<Vec<DayView>> {
        match self {
            Self::Day => Ok(Vec::new()),
            Self::Week => {
                let first = week_start(date)
                    .ok_or_else(|| CoreError::Invalid("Invalid calendar week".into()))?;
                match week_layout {
                    WeekLayout::Team => calendar::team_calendar_week(store, first),
                    WeekLayout::Timeline => calendar::week_view(store, first),
                }
            }
            Self::List => calendar::overview_days(store, date, 7),
            Self::Month => {
                let (first, days) =
                    month_range(date).ok_or_else(|| CoreError::Invalid("Invalid month".into()))?;
                calendar::overview_days(store, first, days)
            }
        }
    }
}

pub(super) fn month_range(date: NaiveDate) -> Option<(NaiveDate, u32)> {
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

pub(super) struct ResourceOption {
    id: String,
    name: String,
    label: String,
}

impl Root {
    pub(super) fn includes_calendar_staff(&self, id: &str) -> bool {
        self.overview_staff.is_empty() || self.overview_staff.contains(id)
    }

    pub(super) fn includes_calendar_resource(&self, appointment: &Appointment) -> bool {
        self.calendar_resource.as_ref().is_none_or(|(id, _)| {
            appointment
                .resources
                .iter()
                .any(|resource| resource.resource_id.as_ref() == Some(id))
        })
    }

    fn calendar_resource_options(&self) -> &[ResourceOption] {
        self.calendar_resources.get_or_init(|| {
            let mut names = HashMap::new();
            if let Some((id, name)) = &self.calendar_resource {
                names.insert(id.as_str(), name.as_str());
            }
            let columns: Vec<_> = if self.calendar_mode.is_overview() {
                self.period_views
                    .iter()
                    .flat_map(|day| &day.columns)
                    .filter(|column| self.includes_calendar_staff(&column.staff.id))
                    .collect()
            } else {
                self.calendar_columns()
                    .into_iter()
                    .map(|(_, column)| column)
                    .collect()
            };
            for resource in columns
                .into_iter()
                .flat_map(|column| &column.items)
                .flat_map(|item| &item.appointment.resources)
            {
                if let Some(id) = &resource.resource_id {
                    names.insert(id.as_str(), resource.name.as_str());
                }
            }
            let mut counts = HashMap::new();
            for name in names.values() {
                *counts.entry(*name).or_insert(0) += 1;
            }
            let mut ordered: Vec<_> = names.into_iter().collect();
            ordered.sort_by_cached_key(|(id, name)| (name.to_lowercase(), *id));
            let mut ordinals = HashMap::new();
            ordered
                .into_iter()
                .map(|(id, name)| {
                    let ordinal = ordinals.entry(name).or_insert(0);
                    *ordinal += 1;
                    let label = if counts[name] > 1 {
                        format!("{name} · {ordinal}")
                    } else {
                        name.to_owned()
                    };
                    ResourceOption {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        label,
                    }
                })
                .collect()
        })
    }

    fn select_calendar_resource(
        &mut self,
        selection: Option<(String, String)>,
        cx: &mut Context<Self>,
    ) {
        self.calendar_resource = selection;
        self.calendar_resources.take();
        self.calendar_layout.take();
        cx.notify();
    }

    pub(super) fn render_calendar_resource_filter(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let options = self.calendar_resource_options();
        if options.is_empty() {
            return None;
        }
        Some(
            div()
                .id("calendar-resource-filter")
                .flex()
                .flex_none()
                .min_w_0()
                .overflow_x_scroll()
                .items_center()
                .gap_2()
                .px_4()
                .py_1()
                .border_b_1()
                .border_color(theme::line())
                .bg(theme::panel())
                .child(
                    div()
                        .flex_none()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::CalendarBookedResource)),
                )
                .child(div().flex_none().child(self.button(
                    "calendar-all-resources",
                    self.t(Key::CalendarAllResources),
                    if self.calendar_resource.is_none() {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(|root, _, _, cx| root.select_calendar_resource(None, cx)),
                )))
                .children(options.iter().map(|ResourceOption { id, name, label }| {
                    let selection = (id.clone(), name.clone());
                    div().flex_none().child(
                        self.button(
                            SharedString::from(format!("calendar-resource-{id}")),
                            label.clone(),
                            if self
                                .calendar_resource
                                .as_ref()
                                .is_some_and(|(selected, _)| selected == id)
                            {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                root.select_calendar_resource(Some(selection.clone()), cx)
                            }),
                        ),
                    )
                })),
        )
    }

    pub(super) fn preferred_calendar_staff(&self) -> Option<&str> {
        if self.calendar_mode == CalendarMode::Week && !self.team_calendar_visible() {
            return (!self.week_staff_id.is_empty()).then_some(&self.week_staff_id);
        }
        if self.team_calendar_visible() {
            return self
                .team_calendar_staff()
                .find(|member| self.includes_team_calendar_staff(&member.id))
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
                    root.calendar_resources.take();
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
                                root.calendar_resources.take();
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

    pub(super) fn overview_filter(&self, cx: &App) -> calendar::OverviewFilter {
        calendar::OverviewFilter::new(
            self.overview_search.read(cx).text(),
            self.overview_status,
            self.overview_show_cancelled,
        )
    }

    pub(super) fn render_calendar_overview(&self, cx: &mut Context<Self>) -> Stateful<gpui::Div> {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let filter = self.overview_filter(cx);
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
                        .filter(|item| {
                            filter.matches(item)
                                && self.includes_calendar_resource(&item.appointment)
                        })
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

    pub(super) fn open_overview_day(&mut self, day: NaiveDate, cx: &mut Context<Self>) {
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
    async fn matching_resource_ids_survive_calendar_view_changes(cx: &mut TestAppContext) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            let mut first = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            first.resources = vec![BookedResource {
                resource_id: Some("room-00000001".into()),
                name: "Treatment room".into(),
                quantity: 1,
            }];
            let mut second = first.clone();
            second.id = uuid::Uuid::now_v7().to_string();
            second.resources[0].resource_id = Some("room-00000002".into());
            let mut fallback = first.clone();
            fallback.id = uuid::Uuid::now_v7().to_string();
            fallback.resources[0].resource_id = None;
            let changes: Vec<_> = [&first, &second, &fallback]
                .into_iter()
                .enumerate()
                .map(|(index, appointment)| RawChange {
                    seq: 21 + index as i64,
                    entity: "appointment".into(),
                    id: appointment.id.clone(),
                    op: "upsert".into(),
                    data: Some(serde_json::to_value(appointment).unwrap()),
                })
                .collect();
            root.svc.store.apply_page(&changes, 23).unwrap();
            root.reload(cx);
            assert_eq!(root.calendar_resource_options().len(), 2);
            assert_ne!(
                root.calendar_resource_options()[0].label,
                root.calendar_resource_options()[1].label
            );
            root.select_calendar_resource(
                Some(("room-00000002".into(), "Treatment room".into())),
                cx,
            );
            assert!(!root.includes_calendar_resource(&first));
            assert!(!root.includes_calendar_resource(&fallback));
            for mode in [CalendarMode::Month, CalendarMode::List] {
                root.set_calendar_mode(mode, cx);
                let date = first.starts_at.with_timezone(&root.tz).date_naive();
                let day = root
                    .period_views
                    .iter()
                    .find(|day| day.date == date)
                    .unwrap();
                let found = root.overview_items(day, &calendar::OverviewFilter::default());
                assert_eq!(found.len(), 1);
                assert_eq!(found[0].1.appointment.id, second.id);
            }
            root.select_calendar_resource(None, cx);
            assert!(root.includes_calendar_resource(&first));
            assert!(root.includes_calendar_resource(&fallback));
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
