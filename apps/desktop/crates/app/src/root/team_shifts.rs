use super::*;
use chrono::Offset;
use sob_core::team_shifts::{Absence, ShiftDay, TeamWeek, team_week, week_start};

mod editor;
mod weekly;

pub(super) struct Desk {
    anchor: NaiveDate,
    data: Option<TeamWeek>,
    date: Entity<TextField>,
    _date_subscription: Subscription,
    invalid_date: bool,
    horizontal: scrollbar::Scrollbar,
    vertical: gpui::ScrollHandle,
    scroll_focus: gpui::FocusHandle,
    editor: Option<editor::Editor>,
    weekly: Option<weekly::Editor>,
    unavailable_appointment: Option<String>,
}

fn parse_team_date(input: &str) -> Option<NaiveDate> {
    calendar_date::parse_calendar_date(input).and_then(week_start)
}

fn absence_label(locale: Locale, timezone: Tz, absence: &Absence) -> String {
    if absence.full_day {
        return i18n::t(locale, Key::ShiftAbsentAllDay).to_owned();
    }
    let start = absence.start.with_timezone(&timezone);
    let end = absence.end.with_timezone(&timezone);
    let format = if start.offset().fix() == end.offset().fix() {
        "%H:%M"
    } else {
        "%H:%M %:z"
    };
    i18n::fill(
        i18n::t(locale, Key::ShiftAbsenceHours),
        &[
            ("start", &start.format(format).to_string()),
            ("end", &end.format(format).to_string()),
        ],
    )
}

impl Root {
    pub(super) fn open_team_shifts(&mut self, cx: &mut Context<Self>) {
        let anchor = week_start(self.date).unwrap_or(self.date);
        let date = cx.new(|cx| {
            let mut field = TextField::new(self.t(Key::ShiftDate), false, cx);
            field.set_text(&anchor.to_string(), cx);
            field
        });
        let subscription = cx.subscribe(&date, |this: &mut Root, _, event, cx| match event {
            FieldEvent::Submit => this.apply_team_date(cx),
            FieldEvent::Changed => {
                if let Overlay::TeamShifts(desk) = &mut this.overlay
                    && desk.invalid_date
                {
                    desk.invalid_date = false;
                    cx.notify();
                }
            }
            _ => {}
        });
        self.overlay = Overlay::TeamShifts(Box::new(Desk {
            anchor,
            data: None,
            date,
            _date_subscription: subscription,
            invalid_date: false,
            horizontal: scrollbar::Scrollbar::default(),
            vertical: gpui::ScrollHandle::new(),
            scroll_focus: cx.focus_handle().tab_stop(true),
            editor: None,
            weekly: None,
            unavailable_appointment: None,
        }));
        self.reload_team_shifts();
        cx.notify();
    }

    pub(super) fn reload_team_shifts(&mut self) {
        if let Overlay::TeamShifts(desk) = &mut self.overlay {
            desk.data = self
                .svc
                .current_session()
                .and_then(|_| team_week(&self.svc.store, desk.anchor).ok());
        }
    }

    fn select_team_week(&mut self, anchor: NaiveDate, cx: &mut Context<Self>) {
        if let Overlay::TeamShifts(desk) = &mut self.overlay
            && let Some(week) = week_start(anchor)
        {
            desk.anchor = week;
            desk.invalid_date = false;
            desk.date
                .update(cx, |field, cx| field.set_text(&week.to_string(), cx));
            self.reload_team_shifts();
            cx.notify();
        }
    }

    fn apply_team_date(&mut self, cx: &mut Context<Self>) {
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return;
        };
        if let Some(week) = parse_team_date(desk.date.read(cx).text()) {
            self.select_team_week(week, cx);
        } else {
            desk.invalid_date = true;
            cx.notify();
        }
    }

    fn scroll_team_shifts(&self, event: &gpui::KeyDownEvent, cx: &mut Context<Self>) {
        let Overlay::TeamShifts(desk) = &self.overlay else {
            return;
        };
        if event.keystroke.modifiers.modified() {
            return;
        }
        let horizontal = &desk.horizontal.handle;
        let vertical = &desk.vertical;
        let (handle, delta) = match event.keystroke.key.as_str() {
            "left" => (horizontal, gpui::point(px(110.), px(0.))),
            "right" => (horizontal, gpui::point(px(-110.), px(0.))),
            "up" => (vertical, gpui::point(px(0.), px(48.))),
            "down" => (vertical, gpui::point(px(0.), px(-48.))),
            _ => return,
        };
        handle.set_offset(handle.offset() + delta);
        cx.stop_propagation();
        cx.notify();
    }

    fn open_professional_week(&mut self, week: NaiveDate, staff_id: &str, cx: &mut Context<Self>) {
        self.reload_team_shifts();
        cx.notify();
        let Overlay::TeamShifts(desk) = &self.overlay else {
            return;
        };
        if !desk.data.as_ref().is_some_and(|data| {
            data.week == week && data.members.iter().any(|member| member.id == staff_id)
        }) {
            return;
        }
        self.overlay = Overlay::None;
        self.calendar_mode = CalendarMode::Week;
        self.week_layout = team_calendar::WeekLayout::Timeline;
        self.date = week;
        self.week_staff_id = staff_id.to_owned();
        self.pending_local_today = false;
        self.reload(cx);
    }

    pub(super) fn render_team_shifts(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let width = (viewport.width - px(32.)).clamp(px(280.), px(1250.));
        let height = (viewport.height - px(32.)).clamp(px(220.), px(850.));
        if let Some(editor) = &desk.weekly {
            return self.modal_with_height(
                self.render_weekly_hours(editor, cx),
                width.min(px(680.)),
                height,
                Some(cx),
            );
        }
        if let Some(editor) = &desk.editor {
            return self.modal_with_height(
                self.render_shift_editor(editor, cx),
                width.min(px(640.)),
                height,
                Some(cx),
            );
        }
        let week = desk.data.as_ref().map_or(desk.anchor, |data| data.week);
        let previous = week.checked_sub_signed(Span::days(7)).and_then(week_start);
        let next = week.checked_add_signed(Span::days(7)).and_then(week_start);
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::TeamShifts)),
            )
            .child(self.button(
                "team-shifts-close",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
            ));
        let navigation = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(
                self.button(
                    "team-shifts-previous",
                    self.t(Key::ShiftPreviousWeek),
                    Kind::Ghost,
                    cx.listener(move |this, _, _, cx| {
                        if let Some(anchor) = previous {
                            this.select_team_week(anchor, cx);
                        }
                    }),
                )
                .when(previous.is_none(), |button| {
                    button.opacity(0.5).cursor_default()
                }),
            )
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(i18n::date_label(self.locale, week)),
            )
            .child(
                self.button(
                    "team-shifts-next",
                    self.t(Key::ShiftNextWeek),
                    Kind::Ghost,
                    cx.listener(move |this, _, _, cx| {
                        if let Some(anchor) = next {
                            this.select_team_week(anchor, cx);
                        }
                    }),
                )
                .when(next.is_none(), |button| {
                    button.opacity(0.5).cursor_default()
                }),
            )
            .child(self.button(
                "team-shifts-current",
                self.t(Key::ShiftThisWeek),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| {
                    this.select_team_week(Utc::now().with_timezone(&this.tz).date_naive(), cx)
                }),
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .w(px(156.))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::ShiftDate)),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "team-shifts-date-input".to_owned())
                                    .child(desk.date.clone()),
                            ),
                    )
                    .child(
                        self.button(
                            "team-shifts-go",
                            self.t(Key::ShiftJump),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.apply_team_date(cx)),
                        )
                        .debug_selector(|| "team-shifts-go".to_owned()),
                    ),
            );
        let content = match &desk.data {
            None => div()
                .text_color(theme::muted())
                .child(self.t(Key::ShiftUnavailable)),
            Some(data) if data.members.is_empty() => div()
                .text_color(theme::muted())
                .child(self.t(Key::ShiftEmpty)),
            Some(data) => self.shift_table(data, desk, width - px(42.), cx),
        };
        self.modal_with_height(
            div()
                .child(header)
                .child(navigation)
                .when(desk.invalid_date, |d| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(Key::ShiftInvalidDate)),
                    )
                })
                .child(content),
            width,
            height,
            Some(cx),
        )
    }

    fn open_schedule_appointment(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return;
        };
        let Ok(Some(appointment)) = calendar::effective_appointment(&self.svc.store, id) else {
            desk.unavailable_appointment = Some(id.to_owned());
            self.svc.wake(Wake::Manual);
            cx.notify();
            return;
        };
        let Overlay::TeamShifts(mut desk) = std::mem::replace(&mut self.overlay, Overlay::None)
        else {
            unreachable!()
        };
        desk.unavailable_appointment = None;
        self.show_appointment_details(appointment, Some(AppointmentReturn::TeamShifts(desk)), cx);
    }

    fn schedule_conflict_list(
        &self,
        conflicts: &[sob_core::http::DatedShiftConflict],
        timezone: Tz,
        can_open: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        use sob_core::http::DatedShiftConflictReason;
        let unavailable = match &self.overlay {
            Overlay::TeamShifts(desk) => desk.unavailable_appointment.as_deref(),
            _ => None,
        };
        let clients: std::collections::HashMap<_, _> = self
            .clients
            .iter()
            .map(|(id, name)| (id.as_str(), name.as_str()))
            .collect();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .text_color(theme::conflict_fg())
            .child(self.t(Key::ShiftConflictsRemain))
            .children(conflicts.iter().map(|conflict| {
                let client = conflict.client_id.to_string();
                let name = clients
                    .get(client.as_str())
                    .copied()
                    .unwrap_or_else(|| self.t(Key::UnknownClient));
                let id = conflict.appointment_id.to_string();
                let selector = format!("shift-open-appointment-{id}");
                let unavailable = unavailable == Some(id.as_str());
                let title = format!(
                    "{} · {}–{}",
                    name,
                    conflict
                        .starts_at
                        .with_timezone(&timezone)
                        .format("%d/%m %H:%M %:z"),
                    conflict
                        .ends_at
                        .with_timezone(&timezone)
                        .format("%d/%m %H:%M %:z")
                );
                div()
                    .id(SharedString::from(id.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .child(title)
                            .when(can_open, |row| {
                                row.child(
                                    self.button(
                                        "shift-open-appointment",
                                        self.t(Key::ShiftOpenAppointment),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.open_schedule_appointment(&id, cx)
                                        }),
                                    )
                                    .debug_selector(move || selector.clone()),
                                )
                            }),
                    )
                    .when(unavailable && can_open, |row| {
                        row.child(
                            div()
                                .text_sm()
                                .child(self.t(Key::ShiftAppointmentUnavailable)),
                        )
                    })
                    .children(conflict.reasons.iter().map(|reason| {
                        div().text_sm().child(self.t(match reason {
                            DatedShiftConflictReason::OutsideWorkingHours => {
                                Key::ShiftConflictHours
                            }
                            DatedShiftConflictReason::TimeOff => Key::TimeOff,
                        }))
                    }))
            }))
    }

    fn shift_table(
        &self,
        data: &TeamWeek,
        desk: &Desk,
        width: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let width = width - px(2.);
        let name_width = if width < px(640.) { px(112.) } else { px(144.) };
        let day_width = ((width - name_width) / 7.).max(px(110.));
        let days_width = day_width * 7.;
        let today = self.calendar_now.with_timezone(&data.timezone).date_naive();
        let last_editable = today.checked_add_signed(Span::days(730)).unwrap_or(today);
        let can_edit = self.can_edit_staff_hours();
        let row = || {
            div()
                .flex()
                .flex_none()
                .w_full()
                .border_b_1()
                .border_color(theme::line())
        };
        let cell = |width| div().w(width).flex_none().px_3().py_2();
        let scroll_days = |id: ElementId, contents: gpui::Div| {
            let mut viewport = div()
                .id(id)
                .flex_1()
                .min_w_0()
                .overflow_x_scroll()
                .track_scroll(&desk.horizontal.handle)
                .child(contents.w(days_width).flex_none().flex());
            viewport.style().restrict_scroll_to_axis = Some(true);
            viewport
        };

        let titles = row()
            .bg(theme::accent_soft())
            .child(
                cell(name_width)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::ShiftProfessional)),
            )
            .child(scroll_days(
                "team-shifts-dates".into(),
                div().children(data.days.iter().enumerate().map(|(index, date)| {
                    cell(day_width)
                        .debug_selector(move || format!("team-shifts-date-{index}"))
                        .font_weight(FontWeight::SEMIBOLD)
                        .when(*date == today, |d| d.text_color(theme::accent()))
                        .child(format!(
                            "{} {}",
                            i18n::weekday_short(self.locale, date.weekday()),
                            date.format("%d/%m")
                        ))
                })),
            ));

        let mut body = div()
            .id("team-shifts-scroll")
            .debug_selector(|| "team-shifts-scroll".to_owned())
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&desk.vertical)
            .track_focus(&desk.scroll_focus)
            .focus(|d| d.bg(theme::accent_soft()))
            .on_key_down(cx.listener(|this, event, _, cx| this.scroll_team_shifts(event, cx)))
            .child(div().w_full().flex().flex_col().text_sm().children(
                data.members.iter().enumerate().map(|(index, member)| {
                    let id = member.id.clone();
                    let week = data.week;
                    let name = self
                        .button(
                            SharedString::from(format!("team-shifts-member-{id}")),
                            member.name.clone(),
                            Kind::Ghost,
                            cx.listener(move |this, _, _, cx| {
                                this.open_professional_week(week, &id, cx)
                            }),
                        )
                        .debug_selector(move || format!("team-shifts-row-{index}"))
                        .w_full()
                        .truncate();
                    let days =
                        div().children(member.days.iter().enumerate().map(|(column, day)| {
                            let date = data.days[column];
                            self.shift_cell(
                                cell(day_width)
                                    .border_l_1()
                                    .border_color(theme::line())
                                    .debug_selector(move || {
                                        format!("team-shifts-cell-{index}-{column}")
                                    }),
                                day,
                                data.timezone,
                            )
                            .when(
                                can_edit && (today..=last_editable).contains(&date),
                                |cell| {
                                    let staff_id = member.id.clone();
                                    let staff_name = member.name.clone();
                                    cell.child(self.button(
                                        ("edit-dated-shift", index * 7 + column),
                                        self.t(Key::ShiftEditDay),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.open_dated_shift(
                                                staff_id.clone(),
                                                staff_name.clone(),
                                                date,
                                                cx,
                                            );
                                        }),
                                    ))
                                },
                            )
                        }));
                    row()
                        .child(cell(name_width).child(name).when(can_edit, |column| {
                            let staff_id = member.id.clone();
                            let staff_name = member.name.clone();
                            let weekly_id = staff_id.clone();
                            let weekly_name = staff_name.clone();
                            column
                                .child(
                                    self.button(
                                        ("edit-weekly-hours", index),
                                        self.t(Key::ShiftWeekAction),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.open_weekly_hours(
                                                weekly_id.clone(),
                                                weekly_name.clone(),
                                                cx,
                                            );
                                        }),
                                    )
                                    .w_full()
                                    .debug_selector(move || format!("team-weekly-hours-{index}")),
                                )
                                .child(
                                    self.button(
                                        ("copy-dated-shifts", index),
                                        self.t(Key::ShiftCopyAction),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.open_shift_copy(
                                                staff_id.clone(),
                                                staff_name.clone(),
                                                week,
                                                cx,
                                            );
                                        }),
                                    )
                                    .w_full()
                                    .debug_selector(move || format!("team-copy-shift-{index}")),
                                )
                        }))
                        .child(scroll_days(("team-shifts-row-days", index).into(), days))
                }),
            ));
        body.style().restrict_scroll_to_axis = Some(true);
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .min_w_0()
            .rounded_lg()
            .border_1()
            .border_color(theme::line())
            .child(titles)
            .child(body)
            .when(name_width + days_width > width, |d| {
                d.child(
                    div()
                        .flex()
                        .flex_none()
                        .child(div().w(name_width).flex_none())
                        .child(div().flex_1().min_w_0().child(desk.horizontal.render_named(
                            scrollbar::Axis::Horizontal,
                            "team-shifts-horizontal-scrollbar",
                            cx,
                        ))),
                )
            })
    }

    fn shift_cell(&self, cell: gpui::Div, day: &ShiftDay, timezone: Tz) -> gpui::Div {
        let all_day = day.absences.iter().any(|absence| absence.full_day);
        cell.flex()
            .flex_col()
            .gap_1()
            .when(day.ranges.is_empty(), |d| {
                d.child(
                    div()
                        .text_color(theme::muted())
                        .child(self.t(Key::ShiftClosed)),
                )
            })
            .children(day.ranges.iter().map(|range| {
                let from = range.start_time.get(..5).unwrap_or(&range.start_time);
                let to = range.end_time.get(..5).unwrap_or(&range.end_time);
                div()
                    .when(all_day, |d| d.text_color(theme::muted()))
                    .child(format!("{from}–{to}"))
            }))
            .when(day.custom, |d| {
                d.child(
                    div()
                        .text_xs()
                        .text_color(theme::muted())
                        .child(self.t(Key::ShiftCustom)),
                )
            })
            .children(day.absences.iter().map(|absence| {
                div()
                    .rounded_md()
                    .px_2()
                    .py_1()
                    .text_xs()
                    .bg(theme::accent_soft())
                    .child(absence_label(self.locale, timezone, absence))
                    .when(absence.pending, |d| {
                        d.child(
                            div()
                                .text_color(theme::muted())
                                .child(self.t(Key::PendingBadge)),
                        )
                    })
            }))
    }
}

impl Desk {
    pub(super) fn appointment_edited(&mut self, id: &str) {
        if let Some(editor) = &mut self.editor {
            editor.appointment_edited(id);
        }
        if let Some(editor) = &mut self.weekly {
            editor.appointment_edited(id);
        }
    }

    pub(super) fn dismiss_editor(&mut self, cx: &Context<Root>) -> bool {
        if let Some(editor) = &mut self.weekly {
            if editor.can_close(cx) {
                self.weekly = None;
            }
            return true;
        }

        let Some(editor) = &mut self.editor else {
            return false;
        };
        if editor.can_close(cx) {
            self.editor = None;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use serde_json::json;
    use sob_core::store::Store;

    #[test]
    fn absence_labels_distinguish_repeated_wall_times() {
        let absence = Absence {
            start: "2026-10-25T00:30:00Z".parse().unwrap(),
            end: "2026-10-25T01:30:00Z".parse().unwrap(),
            full_day: false,
            pending: false,
        };
        assert_eq!(
            absence_label(Locale::EsAr, chrono_tz::Europe::Madrid, &absence),
            "Ausencia 02:30 +02:00–02:30 +01:00"
        );
    }

    #[test]
    fn team_week_navigation_rejects_invalid_dates_and_partial_weeks() {
        assert_eq!(
            parse_team_date("2026-03-12").unwrap().to_string(),
            "2026-03-09"
        );
        for input in [
            "2026-02-29",
            "2026-3-12",
            "0000-01-01",
            "9999-12-31",
            "next week",
        ] {
            assert!(parse_team_date(input).is_none(), "{input}");
        }
    }

    #[gpui::test]
    async fn team_shifts_keeps_names_and_dates_in_view_and_can_jump_weeks(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(700.), px(480.)));
        entity.update(cx, |root, cx| {
            let session = root.svc.current_session().unwrap();
            let mut writer = Store::open(&root.svc.config.db_path(&session)).unwrap();
            writer.set_meta("calendar_scope", "all").unwrap();
            writer.set_meta("time_off_scope", "all").unwrap();
            let shifts: Vec<_> = (0..22).map(|index| {
                let id = format!("demo-staff-{index:02}");
                RawChange {
                    seq: 100 + index, entity: "staff".into(), id: id.clone(), op: "upsert".into(),
                    data: Some(json!({"id":id, "displayName":format!("Team member {index:02}"), "active":true, "userId":null, "updatedAt":"2026-03-09T12:00:00Z"})),
                }
            }).collect();
            writer.apply_page(&shifts, 121).unwrap();
            root.reload(cx);
            root.open_team_shifts(cx);
        });
        cx.run_until_parked();
        let header = cx.debug_bounds("team-shifts-date-1").expect("day heading");
        let name = cx
            .debug_bounds("team-shifts-row-0")
            .expect("professional name");
        let cell = cx.debug_bounds("team-shifts-cell-0-1").expect("shift cell");
        let scroll = |cx: &mut gpui::VisualTestContext, delta| {
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: cell.center(),
                delta: gpui::ScrollDelta::Lines(delta),
                ..Default::default()
            });
            cx.run_until_parked();
        };
        scroll(cx, gpui::point(-5., 0.));
        let shifted_header = cx.debug_bounds("team-shifts-date-1").unwrap();
        let shifted_cell = cx.debug_bounds("team-shifts-cell-0-1").unwrap();
        assert!(shifted_header.left() < header.left());
        assert_eq!(
            shifted_cell.left() - cell.left(),
            shifted_header.left() - header.left()
        );
        assert_eq!(cx.debug_bounds("team-shifts-row-0").unwrap(), name);

        scroll(cx, gpui::point(0., -9.));
        assert_eq!(
            cx.debug_bounds("team-shifts-date-1").unwrap(),
            shifted_header
        );
        assert!(cx.debug_bounds("team-shifts-row-0").unwrap().top() < name.top());

        for (input, expected, invalid) in [
            ("2026-02-29", "2026-03-09", true),
            ("2026-10-28", "2026-10-26", false),
        ] {
            entity.update(cx, |root, cx| {
                let Overlay::TeamShifts(desk) = &root.overlay else {
                    panic!("team shifts closed")
                };
                desk.date.update(cx, |field, cx| field.set_text(input, cx));
            });
            let selector = if invalid {
                "team-shifts-go"
            } else {
                "team-shifts-date-input"
            };
            let control = cx.debug_bounds(selector).expect("week navigation control");
            cx.simulate_click(control.center(), Default::default());
            if !invalid {
                cx.simulate_keystrokes("enter");
            }
            cx.run_until_parked();
            entity.update(cx, |root, _| {
                let Overlay::TeamShifts(desk) = &root.overlay else {
                    panic!("team shifts closed")
                };
                assert_eq!(desk.anchor.to_string(), expected);
                assert_eq!(desk.invalid_date, invalid);
            });
        }

        entity.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Online;
            root.calendar_now = "2026-11-19T10:00:00Z".parse().unwrap();
            if let Overlay::TeamShifts(desk) = &root.overlay {
                desk.vertical.set_offset(gpui::point(px(0.), px(0.)));
            }
            cx.notify();
        });
        cx.run_until_parked();
        let copy = cx
            .debug_bounds("team-copy-shift-0")
            .expect("copy action on a past week");
        cx.simulate_click(copy.center(), Default::default());
        cx.run_until_parked();
        entity.update(cx, |root, cx| {
            let Overlay::TeamShifts(desk) = &mut root.overlay else {
                panic!("team shifts closed");
            };
            assert!(desk.editor.is_some(), "copy opened without loading a day");
            assert!(desk.dismiss_editor(cx), "an untouched draft can close");
            assert!(desk.editor.is_none());
        });
    }

    #[gpui::test]
    async fn team_shifts_refresh_from_sqlite_and_open_the_selected_professionals_calendar(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(500.)));
        entity.update(cx, |root, cx| {
            let session = root.svc.current_session().unwrap();
            let writer = Store::open(&root.svc.config.db_path(&session)).unwrap();
            writer.set_meta("calendar_scope", "all").unwrap();
            writer.set_meta("time_off_scope", "all").unwrap();
            root.reload(cx);
        });
        cx.run_until_parked();
        let toolbar = cx
            .debug_bounds("team-shifts")
            .expect("team shifts toolbar control");
        cx.simulate_click(toolbar.center(), Default::default());
        cx.run_until_parked();
        let (writer, first_id) = entity.update(cx, |root, cx| {
            let session = root.svc.current_session().unwrap();
            let mut writer = Store::open(&root.svc.config.db_path(&session)).unwrap();
            let Overlay::TeamShifts(desk) = &root.overlay else { panic!("no shifts panel") };
            let week = desk.data.as_ref().unwrap();
            assert_eq!(week.members.len(), 2);
            let id = week.members[0].id.clone();
            assert!(!week.members[0].days[0].custom);
            writer.apply_page(&[RawChange {
                seq: 12, entity: "date_shift".into(), id: "synthetic-shift".into(), op: "upsert".into(),
                data: Some(json!({"id":"synthetic-shift", "staffId":id, "date":"2026-03-09", "ranges":[], "version":1, "updatedAt":"2026-03-01T10:00:00Z"})),
            }], 12).unwrap();
            root.tick(cx);
            let Overlay::TeamShifts(desk) = &root.overlay else { panic!("shifts panel closed on update") };
            assert!(desk.data.as_ref().unwrap().members[0].days[0].custom);
            (writer, id)
        });
        cx.run_until_parked();
        let bounds = cx
            .debug_bounds("team-shifts-scroll")
            .expect("scroll viewport");
        assert!(bounds.size.width < px(800.));
        let control = cx.debug_bounds("team-shifts-row-1").unwrap();
        writer.set_meta("time_off_scope", &first_id).unwrap();
        cx.simulate_click(control.center(), Default::default());
        cx.run_until_parked();
        entity.update(cx, |root, _| {
            assert_eq!(root.calendar_mode, CalendarMode::Day);
            assert!(matches!(root.overlay, Overlay::TeamShifts(_)));
        });
        let own = cx.debug_bounds("team-shifts-row-0").unwrap();
        cx.simulate_click(own.center(), Default::default());
        cx.run_until_parked();
        entity.update(cx, |root, _| {
            assert_eq!(root.calendar_mode, CalendarMode::Week);
            assert_eq!(root.week_staff_id, first_id);
            assert!(matches!(root.overlay, Overlay::None));
        });
    }
}
