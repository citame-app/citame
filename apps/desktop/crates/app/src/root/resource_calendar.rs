use super::*;
use sob_core::resource_calendar::{self as occupancy_model, CachedResourceDay, OccupancyRow};

#[derive(Default)]
pub(super) struct Desk {
    range: Option<(NaiveDate, Tz)>,
    day: Option<ConfirmedDay>,
    request: Option<Arc<()>>,
    observed_cursor: Option<i64>,
    retry_at: Option<Instant>,
    error: bool,
    pending_open: Option<String>,
    horizontal_scroll: gpui::ScrollHandle,
}

struct ConfirmedDay {
    snapshot: CachedResourceDay,
    observed: Instant,
    age: Span,
    next_expiry: Option<Span>,
    rows: Vec<OccupancyRow>,
}

impl ConfirmedDay {
    fn new(snapshot: CachedResourceDay) -> Self {
        let age = snapshot.elapsed_at(Utc::now());
        Self {
            next_expiry: snapshot.next_expiry(age),
            rows: snapshot.rows(age),
            snapshot,
            observed: Instant::now(),
            age,
        }
    }

    fn expire_holds(&mut self) -> bool {
        let elapsed = self.age + Span::from_std(self.observed.elapsed()).unwrap_or_default();
        if !self.next_expiry.is_some_and(|expiry| expiry <= elapsed) {
            return false;
        }
        self.rows = self.snapshot.rows(elapsed);
        self.next_expiry = self.snapshot.next_expiry(elapsed);
        true
    }
}

impl Root {
    pub(super) fn can_view_resource_calendar(&self) -> bool {
        self.calendar_scope.as_deref() == Some("all") && !self.resource_access_denied
    }

    pub(super) fn reset_resource_calendar(&mut self) {
        self.resource_calendar = Desk::default();
    }

    pub(super) fn force_resource_calendar_refresh(&mut self, cx: &mut Context<Self>) {
        if self.calendar_mode == CalendarMode::Resources {
            self.resource_calendar.observed_cursor = None;
            self.refresh_resource_calendar(self.status.connectivity, false, cx);
        }
    }

    pub(super) fn refresh_resource_calendar(
        &mut self,
        connectivity: Connectivity,
        force: bool,
        cx: &mut Context<Self>,
    ) {
        if self.calendar_mode != CalendarMode::Resources || !self.can_view_resource_calendar() {
            return;
        }
        let date = self.date;
        let tz = self.tz;
        if self.resource_calendar.range != Some((date, tz)) {
            let day = self
                .svc
                .store
                .resource_day(date)
                .ok()
                .flatten()
                .filter(|snapshot| snapshot.matches(date, tz))
                .map(ConfirmedDay::new);
            self.resource_calendar = Desk {
                range: Some((date, tz)),
                day,
                ..Desk::default()
            };
            cx.notify();
        }
        if matches!(self.overlay, Overlay::None)
            && let Some(id) = self.resource_calendar.pending_open.as_deref()
            && let Ok(Some(appointment)) = calendar::effective_appointment(&self.svc.store, id)
        {
            self.resource_calendar.pending_open = None;
            self.show_appointment_details(appointment, None, cx);
        }
        let desk = &mut self.resource_calendar;
        if force {
            desk.observed_cursor = None;
        }
        if desk.day.as_mut().is_some_and(ConfirmedDay::expire_holds) {
            cx.notify();
        }
        if connectivity != Connectivity::Online || desk.request.is_some() {
            return;
        }
        let cursor = self.svc.store.cursor().unwrap_or_default();
        if let Some(retry) = desk.retry_at {
            if Instant::now() < retry {
                return;
            }
        } else if desk.observed_cursor == Some(cursor) {
            return;
        }
        let (Some(transport), Ok(generation)) = (
            self.svc.transport(),
            self.svc.store.verified_reviewed_generation(),
        ) else {
            return;
        };
        let Some(current) = self.svc.current_session() else {
            return;
        };
        let replica = self.svc.config.db_path(&current);
        let session = self.svc.session.clone();
        let request_session = session.clone();
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.observed_cursor = Some(cursor);
        desk.retry_at = None;
        desk.error = false;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    occupancy_model::refresh(
                        &transport,
                        &replica,
                        &request_session,
                        date,
                        tz,
                        &generation,
                    )
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if matches!(result, occupancy_model::Refresh::Denied) {
                    root.resource_access_denied = true;
                    root.reset_resource_calendar();
                    if root.calendar_mode == CalendarMode::Resources {
                        root.set_calendar_mode(CalendarMode::Day, cx);
                    }
                    cx.notify();
                    return;
                }
                if root.calendar_mode != CalendarMode::Resources
                    || !root.can_view_resource_calendar()
                    || root.date != date
                    || root.tz != tz
                    || !root
                        .resource_calendar
                        .request
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    return;
                }
                root.resource_calendar.request = None;
                match result {
                    occupancy_model::Refresh::Loaded(day) => {
                        root.resource_calendar.day = Some(ConfirmedDay::new(day))
                    }
                    occupancy_model::Refresh::Unavailable => {
                        root.resource_calendar.day = None;
                        root.resource_calendar.error = true;
                    }
                    occupancy_model::Refresh::RetryAfter(delay) => {
                        root.resource_calendar.error = true;
                        root.resource_calendar.retry_at = Instant::now().checked_add(delay);
                    }
                    occupancy_model::Refresh::Denied => {
                        unreachable!("handled for the entire session")
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_resource_calendar(
        &self,
        viewport: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let desk = &self.resource_calendar;
        let base = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .bg(theme::panel());
        let Some(day) = &desk.day else {
            let message = if desk.request.is_some() || desk.range.is_none() {
                Key::ResourceCalendarLoading
            } else {
                Key::ResourceCalendarUnavailable
            };
            return base.child(
                div()
                    .p_4()
                    .text_color(theme::muted())
                    .child(self.t(message)),
            );
        };
        let Some(occupancy) = day.snapshot.occupancy() else {
            return base;
        };
        let stale = self.status.connectivity != Connectivity::Online
            || !self.status.stream_live
            || desk.error
            || desk.request.is_some()
            || self.summary.pending > 0;
        let captured = occupancy
            .captured_at
            .with_timezone(&self.tz)
            .format("%d/%m %H:%M")
            .to_string();
        let base = base.when(stale, |body| {
            body.child(
                div()
                    .px_3()
                    .py_2()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(i18n::fill(
                        self.t(Key::ResourceCalendarCached),
                        &[("time", &captured)],
                    )),
            )
        });
        if occupancy.pools.is_empty() {
            return base.child(
                div()
                    .p_4()
                    .text_color(theme::muted())
                    .child(self.t(Key::ResourceCalendarEmpty)),
            );
        }

        let time_width = px(158.);
        let column_width = ((viewport - time_width) / occupancy.pools.len() as f32).max(px(164.));
        let columns_width = column_width * occupancy.pools.len() as f32;
        let scroll_row = |id: ElementId, row: gpui::Div| {
            let mut scroll = div()
                .id(id)
                .flex_1()
                .min_w_0()
                .overflow_x_scroll()
                .track_scroll(&desk.horizontal_scroll)
                .child(row.flex().w(columns_width).flex_none());
            scroll.style().restrict_scroll_to_axis = Some(true);
            scroll
        };
        let heading = div()
            .flex()
            .flex_none()
            .bg(theme::accent_soft())
            .border_b_1()
            .border_color(theme::line())
            .child(
                div()
                    .flex_none()
                    .w(time_width)
                    .p_3()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::ResourceTimeRange)),
            )
            .child(scroll_row(
                "resource-calendar-header".into(),
                div().children(occupancy.pools.iter().map(|pool| {
                    div()
                        .flex()
                        .flex_col()
                        .flex_none()
                        .w(column_width)
                        .p_3()
                        .min_w_0()
                        .border_l_1()
                        .border_color(theme::line())
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(pool.name.clone()),
                        )
                        .child(div().text_sm().text_color(theme::muted()).child(i18n::fill(
                            self.t(Key::ResourceCapacity),
                            &[("n", &pool.capacity.to_string())],
                        )))
                        .when(!pool.active, |cell| {
                            cell.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::ResourceInactive)),
                            )
                        })
                })),
            ));
        let names: HashMap<_, _> = day
            .snapshot
            .appointment_labels()
            .iter()
            .map(|label| (label.id.as_str(), label.client_name.as_str()))
            .collect();
        let local_names: HashMap<_, _> = self
            .view
            .iter()
            .flat_map(|view| &view.columns)
            .flat_map(|column| &column.items)
            .map(|item| (item.appointment.id.as_str(), item.client_name.as_str()))
            .collect();
        let repeated_hour = day
            .rows
            .first()
            .zip(day.rows.last())
            .is_some_and(|(first, last)| last.end - first.start > Span::days(1));
        let time = |instant: DateTime<Utc>| {
            let local = instant.with_timezone(&self.tz);
            local
                .format(if repeated_hour { "%H:%M %:z" } else { "%H:%M" })
                .to_string()
        };
        let rows = div()
            .id("resource-calendar-rows")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .children(day.rows.iter().enumerate().map(|(index, row)| {
                        let cells = div().children(occupancy.pools.iter().zip(&row.cells).map(
                            |(pool, cell)| {
                                div()
                                    .flex()
                                    .flex_col()
                                    .flex_none()
                                    .w(column_width)
                                    .p_3()
                                    .min_w_0()
                                    .border_l_1()
                                    .border_color(theme::line())
                                    .when(cell.units > 0, |cell| cell.bg(theme::accent_soft()))
                                    .child(div().font_weight(FontWeight::SEMIBOLD).child(
                                        i18n::fill(
                                            self.t(Key::ResourceReserved),
                                            &[
                                                ("n", &cell.units.to_string()),
                                                ("capacity", &pool.capacity.to_string()),
                                            ],
                                        ),
                                    ))
                                    .when(cell.held > 0, |region| {
                                        region.child(
                                            div().text_sm().text_color(theme::muted()).child(
                                                i18n::fill(
                                                    self.t(Key::ResourceWaitlistHeld),
                                                    &[("n", &cell.held.to_string())],
                                                ),
                                            ),
                                        )
                                    })
                                    .children(cell.appointment_ids.iter().filter_map(|id| {
                                        let name = names
                                            .get(id.as_str())
                                            .or_else(|| local_names.get(id.as_str()))?
                                            .to_string();
                                        let appointment_id = id.clone();
                                        Some(
                                            self.button(
                                                SharedString::from(format!(
                                                    "resource-{index}-{}-{id}",
                                                    pool.id
                                                )),
                                                name,
                                                Kind::Ghost,
                                                cx.listener(move |root, _, _, cx| {
                                                    if matches!(root.overlay, Overlay::None) {
                                                        if let Ok(Some(appointment)) =
                                                            calendar::effective_appointment(
                                                                &root.svc.store,
                                                                &appointment_id,
                                                            )
                                                        {
                                                            root.show_appointment_details(
                                                                appointment,
                                                                None,
                                                                cx,
                                                            );
                                                        } else {
                                                            root.resource_calendar.pending_open =
                                                                Some(appointment_id.clone());
                                                            root.svc.wake(Wake::Manual);
                                                            cx.notify();
                                                        }
                                                    }
                                                }),
                                            )
                                            .mt_1(),
                                        )
                                    }))
                            },
                        ));
                        div()
                            .flex()
                            .flex_none()
                            .min_h(px(42.))
                            .border_b_1()
                            .border_color(theme::line())
                            .child(
                                div()
                                    .w(time_width)
                                    .flex_none()
                                    .p_3()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("{}–{}", time(row.start), time(row.end))),
                            )
                            .child(scroll_row(("resource-calendar-row", index).into(), cells))
                    })),
            );
        base.when(desk.pending_open.is_some(), |body| {
            body.child(
                div()
                    .px_3()
                    .py_2()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::ResourceAppointmentPending)),
            )
        })
        .child(heading)
        .child(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::tests::{EXISTING, desk};
    use gpui::TestAppContext;
    use sob_core::resource_calendar::{
        ReservedWindow, ResourceColumn, ResourceDay, ResourceOccupancy,
    };

    #[gpui::test]
    async fn resource_view_displays_the_right_cached_day_and_respects_access_changes(
        cx: &mut TestAppContext,
    ) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1024.), px(880.)));
        root.update(cx, |root, cx| {
            let date = root.date;
            let (from, to) = calendar::local_day_range(root.tz, date);
            root.svc.store.set_meta("calendar_scope", "all").unwrap();
            root.reload(cx);
            let now = Utc::now();
            let snapshot = CachedResourceDay::new(
                ResourceDay {
                    from,
                    to,
                    appointments: Vec::new(),
                    resource_occupancy: Some(ResourceOccupancy {
                        captured_at: now,
                        pools: vec![ResourceColumn {
                            id: "room".into(),
                            name: "Treatment room".into(),
                            capacity: 2,
                            active: true,
                            windows: vec![ReservedWindow {
                                starts_at: from + Span::hours(10),
                                ends_at: from + Span::hours(12),
                                quantity: 1,
                                appointment_id: Some(EXISTING.into()),
                                hold_expires_at: None,
                            }],
                        }],
                    }),
                },
                now,
            );
            let generation = root.svc.store.verified_reviewed_generation().unwrap();
            assert!(
                root.svc
                    .store
                    .cache_resource_day(date, &generation, &snapshot, || true)
                    .unwrap()
            );
            root.set_calendar_mode(CalendarMode::Resources, cx);
            assert_eq!(
                root.resource_calendar.day.as_ref().unwrap().rows[1].cells[0].units,
                1
            );
            assert!(
                root.cloud_calendar_url()
                    .unwrap()
                    .query_pairs()
                    .any(|(key, value)| key == "view" && value == "resources")
            );
            root.shift_day(1, cx);
            assert!(root.resource_calendar.day.is_none());
            root.shift_day(-1, cx);
            assert!(root.resource_calendar.day.is_some());
            root.svc.store.set_meta("calendar_scope", "none").unwrap();
            root.reload(cx);
            assert_eq!(root.calendar_mode, CalendarMode::Day);
            assert!(root.resource_calendar.day.is_none());
            assert!(root.svc.store.resource_day(date).unwrap().is_none());
        });
        cx.run_until_parked();
    }
}
