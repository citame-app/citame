use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum WeekLayout {
    Team,
    Timeline,
}

impl Root {
    pub(super) fn team_calendar_visible(&self) -> bool {
        self.calendar_mode == CalendarMode::Week && self.week_layout == WeekLayout::Team
    }

    pub(super) fn team_calendar_staff(&self) -> impl Iterator<Item = &Staff> {
        self.period_views
            .first()
            .into_iter()
            .flat_map(|day| &day.columns)
            .map(|column| &column.staff)
    }

    fn can_filter_weekly_roster(&self) -> bool {
        self.svc
            .current_session()
            .is_some_and(|session| session.role == "owner")
    }

    pub(super) fn includes_team_calendar_staff(&self, id: &str) -> bool {
        self.includes_calendar_staff(id)
            && (!self.week_working_only
                || !self.can_filter_weekly_roster()
                || self.period_views.iter().any(|day| {
                    day.columns
                        .iter()
                        .any(|column| column.staff.id == id && column.working == Some(true))
                }))
    }

    fn set_week_layout(&mut self, layout: WeekLayout, cx: &mut Context<Self>) {
        if self.week_layout == layout || !matches!(self.overlay, Overlay::None) {
            return;
        }
        self.week_layout = layout;
        self.slot_drag = None;
        self.team_calendar_scroll
            .set_offset(gpui::point(px(0.), px(0.)));
        self.reload(cx);
    }

    pub(super) fn render_week_controls(&self, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .px_4()
            .py_2()
            .bg(theme::panel())
            .child(
                self.button(
                    "week-team",
                    self.t(Key::CalendarWeekTeam),
                    if self.team_calendar_visible() {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(|root, _, _, cx| root.set_week_layout(WeekLayout::Team, cx)),
                )
                .debug_selector(|| "week-team".to_owned()),
            )
            .child(
                self.button(
                    "week-timeline",
                    self.t(Key::CalendarWeekTimeline),
                    if self.team_calendar_visible() {
                        Kind::Ghost
                    } else {
                        Kind::Primary
                    },
                    cx.listener(|root, _, _, cx| root.set_week_layout(WeekLayout::Timeline, cx)),
                )
                .debug_selector(|| "week-timeline".to_owned()),
            )
            .when(
                self.team_calendar_visible() && self.can_filter_weekly_roster(),
                |body| {
                    body.child(
                        self.button(
                            "team-calendar-working-only",
                            self.t(Key::CalendarWorkingOnly),
                            if self.week_working_only {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(|root, _, _, cx| {
                                root.week_working_only = !root.week_working_only;
                                cx.notify();
                            }),
                        )
                        .debug_selector(|| "team-calendar-working-only".to_owned()),
                    )
                },
            )
            .when(!self.team_calendar_visible(), |body| {
                body.child(self.staff_chips(
                    &self.staff,
                    "week-staff",
                    &self.week_staff_id,
                    cx,
                    |root, id, cx| root.set_week_staff(id, cx),
                ))
            })
    }

    pub(super) fn render_team_calendar(
        &self,
        viewport: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let filter = self.overview_filter(cx);
        let has_staff = self.team_calendar_staff().next().is_some();
        let has_visible_staff = self
            .team_calendar_staff()
            .any(|staff| self.includes_team_calendar_staff(&staff.id));
        let name_width = if viewport < px(700.) {
            px(115.)
        } else {
            px(145.)
        };
        let day_width = ((viewport - name_width) / 7.).max(px(132.));
        let columns_width = day_width * 7.;
        let day_viewport = |id: ElementId, row: gpui::Div| {
            let mut scroll = div()
                .id(id)
                .flex_1()
                .min_w_0()
                .overflow_x_scroll()
                .track_scroll(&self.team_calendar_scroll)
                .child(row.flex().w(columns_width).flex_none());
            scroll.style().restrict_scroll_to_axis = Some(true);
            scroll
        };
        let headers = div()
            .flex()
            .flex_none()
            .bg(theme::accent_soft())
            .border_y_1()
            .border_color(theme::line())
            .child(
                div()
                    .w(name_width)
                    .flex_none()
                    .px_3()
                    .py_2()
                    .font_weight(FontWeight::SEMIBOLD)
                    .debug_selector(|| "team-calendar-professional".to_owned())
                    .child(self.t(Key::ShiftProfessional)),
            )
            .child(day_viewport(
                "team-calendar-dates".into(),
                div().children(self.period_views.iter().map(|day| {
                    div()
                        .w(day_width)
                        .flex_none()
                        .px_2()
                        .py_2()
                        .border_l_1()
                        .border_color(theme::line())
                        .debug_selector(|| format!("team-calendar-date-{}", day.date))
                        .child(
                            self.overview_day_button(
                                day.date,
                                format!(
                                    "{} {}",
                                    i18n::weekday_short(self.locale, day.date.weekday()),
                                    day.date.format("%d/%m")
                                ),
                                day.date == today,
                                cx,
                            )
                            .w_full(),
                        )
                })),
            ));
        let rows = div()
            .id(SharedString::from(format!(
                "team-calendar-rows-{}",
                self.date
            )))
            .debug_selector(|| "team-calendar-rows".to_owned())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                div().flex().flex_col().children(
                    self.team_calendar_staff()
                        .enumerate()
                        .filter(|(_, staff)| self.includes_team_calendar_staff(&staff.id))
                        .map(|(index, staff)| {
                            let id = staff.id.clone();
                            let name = self
                                .button(
                                    ("team-calendar-member", index),
                                    staff.display_name.clone(),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        if matches!(root.overlay, Overlay::None) {
                                            root.set_week_staff(id.clone(), cx);
                                        }
                                    }),
                                )
                                .debug_selector(|| format!("team-calendar-member-{}", staff.id))
                                .w_full()
                                .truncate();
                            let cells = div().children(self.period_views.iter().map(|day| {
                                let column =
                                    day.columns.iter().find(|col| col.staff.id == staff.id);
                                div()
                                    .w(day_width)
                                    .flex_none()
                                    .border_l_1()
                                    .border_color(theme::line())
                                    .children(column.map(|column| {
                                        self.render_team_calendar_cell(
                                            day.date, column, &filter, cx,
                                        )
                                    }))
                            }));
                            div()
                                .flex()
                                .flex_none()
                                .min_h(px(100.))
                                .border_b_1()
                                .border_color(theme::line())
                                .child(
                                    div()
                                        .w(name_width)
                                        .flex_none()
                                        .min_w_0()
                                        .px_2()
                                        .py_2()
                                        .child(name),
                                )
                                .child(day_viewport(
                                    ("team-calendar-staff-scroll", index).into(),
                                    cells,
                                ))
                        }),
                ),
            );
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .bg(theme::panel())
            .when(self.period_views.is_empty(), |body| {
                body.child(div().p_4().child(self.t(Key::ShiftUnavailable)))
            })
            .when(!self.period_views.is_empty() && !has_staff, |body| {
                body.child(div().p_4().child(self.t(Key::NoStaff)))
            })
            .when(has_staff && !has_visible_staff, |body| {
                body.child(div().p_4().child(self.t(Key::CalendarNoMatchingStaff)))
            })
            .when(has_visible_staff, |body| body.child(headers).child(rows))
    }

    fn render_team_calendar_cell(
        &self,
        day: NaiveDate,
        column: &calendar::StaffColumn,
        filter: &calendar::OverviewFilter,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let rows: Vec<_> = column
            .items
            .iter()
            .filter(|item| filter.matches(item))
            .collect();
        let staff_id = column.staff.id.clone();
        let count = i18n::fill(
            self.t(Key::CalendarBookedCount),
            &[("n", &rows.len().to_string())],
        );
        let preview_limit = if column.blocks.is_empty() { 4 } else { 3 };
        let (from, to) = calendar::local_day_range(self.tz, day);
        div()
            .flex()
            .flex_col()
            .gap_1()
            .px_2()
            .py_2()
            .min_h_full()
            .when(column.working == Some(false), |cell| {
                cell.bg(theme::line_soft()).child(
                    div()
                        .text_xs()
                        .text_color(theme::muted())
                        .child(self.t(Key::CalendarDayOff)),
                )
            })
            .children(column.blocks.iter().filter_map(|block| {
                let record = &block.time_off;
                let (start, end) = block.interval_within(from, to)?;
                let start = self.hhmm(start);
                let end_label = if end == to {
                    "24:00".to_owned()
                } else {
                    self.hhmm(end)
                };
                let label = record
                    .reason
                    .as_deref()
                    .unwrap_or_else(|| self.t(Key::TimeOff));
                Some(
                    div()
                        .rounded_md()
                        .px_2()
                        .py_1()
                        .bg(theme::line_soft())
                        .text_sm()
                        .text_color(theme::muted())
                        .child(
                            div()
                                .truncate()
                                .child(format!("{start}–{end_label} {label}")),
                        )
                        .debug_selector(|| format!("team-calendar-block-{day}-{}", record.id))
                        .when(self.can_manage_block(&column.staff), |row| {
                            let record = record.clone();
                            row.child(
                                self.button(
                                    SharedString::from(format!(
                                        "team-calendar-edit-block-{day}-{}",
                                        record.id
                                    )),
                                    self.t(Key::EditTimeOff),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        if matches!(root.overlay, Overlay::None) {
                                            root.open_block(Some(record.clone()), day, cx);
                                        }
                                    }),
                                )
                                .px_1(),
                            )
                        })
                        .when(block.pending, |block| {
                            block.child(div().text_xs().child(self.t(Key::PendingBadge)))
                        }),
                )
            }))
            .children(
                rows.iter()
                    .take(preview_limit)
                    .map(|item| self.overview_appointment(day, item, cx).flex_none()),
            )
            .child(
                self.button(
                    SharedString::from(format!("team-calendar-open-{day}-{staff_id}")),
                    count,
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        if !matches!(root.overlay, Overlay::None) {
                            return;
                        }
                        root.overview_staff.clear();
                        root.overview_staff.insert(staff_id.clone());
                        root.open_overview_day(day, cx);
                    }),
                )
                .debug_selector(|| format!("team-calendar-open-{day}-{}", column.staff.id))
                .w_full()
                .px_1(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::tests::{EXISTING, desk};
    use gpui::TestAppContext;
    use serde_json::json;

    const ANA: &str = "01a1d81e-0000-7000-8000-000000000001";
    const BEA: &str = "01a1d81e-0000-7000-8000-000000000002";
    const BLOCK: &str = "a00bd805-72d0-43eb-9461-6fc312bab882";
    const SECOND_BLOCK: &str = "a00bd805-72d0-43eb-9461-6fc312bab883";

    #[gpui::test]
    async fn team_week_shows_the_local_roster_blocks_and_individual_drill_down(
        cx: &mut TestAppContext,
    ) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(760.)));
        root.update(cx, |root, cx| {
            let store = &mut root.svc.store;
            store.set_meta("calendar_scope", "all").unwrap();
            let change = |seq, entity: &str, id: &str, data| RawChange {
                seq, entity: entity.into(), id: id.into(), op: "upsert".into(), data: Some(data)
            };
            store.apply_page(&[
                change(20, "working_hours", "ana-mon", json!({"id":"ana-mon","staffId": ANA,"weekday":1,"startTime":"09:00","endTime":"18:00"})),
                change(21, "working_hours", "ana-tue", json!({"id":"ana-tue","staffId": ANA,"weekday":2,"startTime":"09:00","endTime":"18:00"})),
                change(22, "date_shift", "ana-closed", json!({"id":"ana-closed","staffId": ANA,"date":"2026-03-10","ranges":[],"version":1,"updatedAt":"2026-03-09T12:00:00Z"})),
                change(23, "time_off", BLOCK, json!({"id":BLOCK,"staffId":BEA,"startsAt":"2026-03-09T14:00:00Z","endsAt":"2026-03-09T15:00:00Z","reason":"Training","updatedAt":"2026-03-09T12:00:00Z"})),
                change(24, "time_off", SECOND_BLOCK, json!({"id":SECOND_BLOCK,"staffId":BEA,"startsAt":"2026-03-09T16:00:00Z","endsAt":"2026-03-09T17:00:00Z","reason":"Practice","updatedAt":"2026-03-09T12:00:00Z"})),
            ], 24).unwrap();
            root.set_calendar_mode(CalendarMode::Week, cx);
        });
        cx.run_until_parked();
        let team = cx.debug_bounds("week-team").unwrap();
        cx.simulate_click(team.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(root.team_calendar_visible());
            assert_eq!(root.calendar_columns().len(), 14);
            let monday = &root.period_views[0];
            assert!(
                monday.columns[0]
                    .items
                    .iter()
                    .any(|item| item.appointment.id == EXISTING)
            );
            assert_eq!(monday.columns[0].working, Some(true));
            assert_eq!(root.period_views[1].columns[0].working, Some(false));
            assert_eq!(monday.columns[1].blocks[0].time_off.id, BLOCK);
            assert!(
                !root
                    .cloud_calendar_url()
                    .unwrap()
                    .query_pairs()
                    .any(|(name, _)| name == "staff")
            );
        });
        let name_before = cx.debug_bounds("team-calendar-professional").unwrap();
        let title_before = cx.debug_bounds("team-calendar-date-2026-03-10").unwrap();
        let cell = cx
            .debug_bounds("team-calendar-open-2026-03-09-01a1d81e-0000-7000-8000-000000000001")
            .unwrap();
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: cell.center(),
            delta: gpui::ScrollDelta::Lines(gpui::point(-4., 0.)),
            ..Default::default()
        });
        cx.run_until_parked();
        assert_eq!(
            cx.debug_bounds("team-calendar-professional").unwrap(),
            name_before
        );
        assert!(
            cx.debug_bounds("team-calendar-date-2026-03-10")
                .unwrap()
                .left()
                < title_before.left()
        );

        let working = cx.debug_bounds("team-calendar-working-only").unwrap();
        cx.simulate_click(working.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert_eq!(root.calendar_columns().len(), 7);
            assert!(
                root.calendar_columns()
                    .iter()
                    .all(|(_, column)| column.staff.id == ANA)
            );
        });
        cx.simulate_click(working.center(), Default::default());
        cx.run_until_parked();
        let staff = cx
            .debug_bounds("team-calendar-member-01a1d81e-0000-7000-8000-000000000002")
            .unwrap();
        cx.simulate_click(staff.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert!(!root.team_calendar_visible());
            assert_eq!(root.week_staff_id, BEA);
            assert_eq!(root.calendar_columns().len(), 7);
            root.set_week_layout(WeekLayout::Team, cx);
        });
        cx.run_until_parked();
        assert!(
            cx.debug_bounds("team-calendar-block-2026-03-09-a00bd805-72d0-43eb-9461-6fc312bab883")
                .is_some()
        );
        let cell = cx
            .debug_bounds("team-calendar-open-2026-03-09-01a1d81e-0000-7000-8000-000000000002")
            .unwrap();
        cx.simulate_click(cell.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert_eq!(root.calendar_mode, CalendarMode::Day);
            assert_eq!(root.date.to_string(), "2026-03-09");
            assert_eq!(root.calendar_columns().len(), 1);
            assert_eq!(root.calendar_columns()[0].1.staff.id, BEA);
            assert_eq!(root.calendar_columns()[0].1.blocks.len(), 2);
            root.svc.store.set_meta("calendar_scope", ANA).unwrap();
            root.set_calendar_mode(CalendarMode::Week, cx);
            root.set_week_layout(WeekLayout::Team, cx);
            assert_eq!(
                root.team_calendar_staff()
                    .map(|staff| staff.id.as_str())
                    .collect::<Vec<_>>(),
                [ANA]
            );
            assert_eq!(root.preferred_calendar_staff(), Some(ANA));
        });
    }
}
