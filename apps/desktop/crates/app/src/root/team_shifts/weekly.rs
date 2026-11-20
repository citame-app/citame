use super::*;
use sob_core::http::{DatedShiftConflict, WeeklyHours, WeeklyRange, parse_weekly_hours};
use sob_core::sync::TransportError;

const WEEK: [chrono::Weekday; 7] = [
    chrono::Weekday::Mon,
    chrono::Weekday::Tue,
    chrono::Weekday::Wed,
    chrono::Weekday::Thu,
    chrono::Weekday::Fri,
    chrono::Weekday::Sat,
    chrono::Weekday::Sun,
];

type RangeFields = (Entity<TextField>, Entity<TextField>);

enum Stage {
    Loading,
    Error,
    Draft,
    Saving,
    Retry(Vec<WeeklyRange>),
    Stale,
    Saved,
}

#[derive(Default)]
struct ConflictUpdates {
    appointments: std::collections::HashSet<String>,
    loading: bool,
    failed: bool,
    current: Option<Vec<DatedShiftConflict>>,
}

pub(super) struct Editor {
    staff_id: String,
    name: String,
    request: Arc<()>,
    baseline: Option<Arc<WeeklyHours>>,
    days: [Vec<RangeFields>; 7],
    day: usize,
    copy_targets: Option<[bool; 7]>,
    stage: Stage,
    error: Option<Key>,
    discard: bool,
    conflict_updates: ConflictUpdates,
}

impl Editor {
    pub(super) fn appointment_edited(&mut self, id: &str) {
        self.conflict_updates.appointments.insert(id.to_owned());
        self.conflict_updates.failed = false;
    }

    fn hours(&self, cx: &App) -> Option<Vec<WeeklyRange>> {
        parse_weekly_hours(std::array::from_fn(|day| {
            self.days[day]
                .iter()
                .map(|(start, end)| (start.read(cx).text(), end.read(cx).text()))
                .collect()
        }))
    }

    fn apply_copy(&mut self, cx: &mut Context<Root>) {
        let Some(targets) = self.copy_targets.take() else {
            return;
        };
        let source: Vec<_> = self.days[self.day]
            .iter()
            .map(|(start, end)| {
                (
                    start.read(cx).text().to_owned(),
                    end.read(cx).text().to_owned(),
                )
            })
            .collect();
        if source.is_empty() {
            return;
        }
        for (index, selected) in targets.into_iter().enumerate() {
            if selected && index != self.day {
                self.days[index] = source
                    .iter()
                    .map(|(start_text, end_text)| {
                        let (start, end) = editor::range_fields(None, cx);
                        start.update(cx, |field, cx| field.set_text(start_text, cx));
                        end.update(cx, |field, cx| field.set_text(end_text, cx));
                        (start, end)
                    })
                    .collect();
            }
        }
    }

    fn busy(&self) -> bool {
        matches!(self.stage, Stage::Loading | Stage::Saving)
    }

    pub(super) fn can_close(&mut self, cx: &App) -> bool {
        if self.busy() {
            return false;
        }
        if self.discard {
            self.discard = false;
            return false;
        }
        self.discard = matches!(self.stage, Stage::Retry(_))
            || self
                .baseline
                .as_ref()
                .is_some_and(|baseline| self.hours(cx).is_none_or(|hours| hours != baseline.hours));
        !self.discard
    }
}

impl Root {
    fn weekly_editor(&mut self) -> Option<&mut Editor> {
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return None;
        };
        desk.weekly.as_mut()
    }

    pub(super) fn open_weekly_hours(
        &mut self,
        staff_id: String,
        name: String,
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
        if desk.editor.is_some() || desk.weekly.as_ref().is_some_and(Editor::busy) {
            return;
        }
        let request = Arc::new(());
        let preserve = if let Some(editor) = desk
            .weekly
            .as_mut()
            .filter(|editor| matches!(editor.stage, Stage::Stale))
        {
            editor.stage = Stage::Loading;
            editor.error = None;
            editor.request = request.clone();
            true
        } else {
            desk.weekly = Some(Editor {
                staff_id: staff_id.clone(),
                name,
                request: request.clone(),
                baseline: None,
                days: Default::default(),
                day: 1,
                copy_targets: None,
                stage: Stage::Loading,
                error: None,
                discard: false,
                conflict_updates: ConflictUpdates::default(),
            });
            false
        };
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.weekly_hours(&staff_id) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Some(editor) = root
                    .weekly_editor()
                    .filter(|e| Arc::ptr_eq(&request, &e.request))
                else {
                    return;
                };
                editor.stage = match result {
                    Ok(hours) => {
                        editor.days = Default::default();
                        editor.conflict_updates = ConflictUpdates::default();
                        editor.copy_targets = None;
                        for range in &hours.hours {
                            editor.days[range.weekday as usize].push(editor::range_fields(
                                Some(&DateShiftRange {
                                    start_time: range.start_time.clone(),
                                    end_time: range.end_time.clone(),
                                }),
                                cx,
                            ));
                        }
                        editor.baseline = Some(Arc::new(hours));
                        Stage::Draft
                    }
                    Err(_) if preserve => {
                        editor.error = Some(Key::ShiftLoadFailed);
                        Stage::Stale
                    }
                    Err(_) => Stage::Error,
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn save_weekly_hours(&mut self, cx: &mut Context<Self>) {
        if !self.can_edit_staff_hours() {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Some(editor) = self.weekly_editor() else {
            return;
        };
        let Some(baseline) = editor.baseline.clone() else {
            return;
        };
        let hours = match &editor.stage {
            Stage::Draft => {
                let Some(hours) = editor.hours(cx) else {
                    editor.error = Some(Key::ShiftWeekInvalid);
                    cx.notify();
                    return;
                };
                if hours == baseline.hours {
                    return;
                }
                hours
            }
            Stage::Retry(sent) => sent.clone(),
            _ => return,
        };
        let request = editor.request.clone();
        let retry = matches!(editor.stage, Stage::Retry(_));
        editor.stage = Stage::Saving;
        editor.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let sent = hours.clone();
            let result = cx
                .background_executor()
                .spawn(async move { transport.save_weekly_hours(&baseline, &sent) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Some(editor) = root
                    .weekly_editor()
                    .filter(|e| Arc::ptr_eq(&request, &e.request))
                else {
                    return;
                };
                let saved = matches!(result, Ok(Some(_)));
                editor.stage = match result {
                    Ok(Some(saved)) => {
                        editor.baseline = Some(Arc::new(saved));
                        editor.conflict_updates.current = None;
                        Stage::Saved
                    }
                    Ok(None) => Stage::Stale,
                    Err(TransportError::Offline(_) | TransportError::Server(_)) => {
                        Stage::Retry(hours)
                    }
                    Err(_) if retry => {
                        editor.error = Some(Key::ShiftRetryRejected);
                        Stage::Retry(hours)
                    }
                    Err(_) => {
                        editor.error = Some(Key::ShiftSaveRejected);
                        Stage::Draft
                    }
                };
                if saved {
                    root.svc.wake(Wake::Manual);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(in crate::root) fn refresh_weekly_conflicts_if_ready(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Overlay::TeamShifts(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.weekly else {
            return;
        };
        let updates = &mut editor.conflict_updates;
        if !matches!(editor.stage, Stage::Draft | Stage::Saved)
            || updates.loading
            || updates.failed
            || updates.appointments.is_empty()
            || updates.appointments.iter().any(|id| {
                !matches!(
                    self.svc.store.appointment_edit_sync(id),
                    Ok(AppointmentEditSync::Settled | AppointmentEditSync::NeedsResolution)
                )
            })
        {
            return;
        }
        let Some(baseline) = editor.baseline.clone() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let staff_id = editor.staff_id.clone();
        let request = editor.request.clone();
        let appointments = std::mem::take(&mut updates.appointments);
        updates.loading = true;
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.weekly_hours(&staff_id) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let desk = match &mut root.overlay {
                    Overlay::TeamShifts(desk) => Some(desk.as_mut()),
                    Overlay::Details(details) => match &mut details.return_to {
                        Some(AppointmentReturn::TeamShifts(desk)) => Some(desk.as_mut()),
                        _ => None,
                    },
                    _ => None,
                };
                let Some(editor) = desk
                    .and_then(|desk| desk.weekly.as_mut())
                    .filter(|editor| Arc::ptr_eq(&request, &editor.request))
                else {
                    return;
                };
                let updates = &mut editor.conflict_updates;
                updates.loading = false;
                match result {
                    Ok(latest)
                        if editor
                            .baseline
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &baseline)) =>
                    {
                        updates.current = Some(latest.conflicts);
                    }
                    Ok(_) => {}
                    Err(_) => {
                        updates.appointments.extend(appointments);
                        updates.failed = true;
                    }
                }
                root.refresh_weekly_conflicts_if_ready(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_weekly_hours(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let body = if editor.discard {
            div()
                .child(self.t(if matches!(editor.stage, Stage::Retry(_)) {
                    Key::ShiftDiscardUncertain
                } else {
                    Key::ShiftDiscardPrompt
                }))
                .child(self.button(
                    "weekly-keep",
                    self.t(Key::Cancel),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                ))
                .child(self.button(
                    "weekly-discard",
                    self.t(Key::ShiftDiscard),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::TeamShifts(desk) = &mut root.overlay {
                            desk.weekly = None;
                        }
                        cx.notify();
                    }),
                ))
        } else {
            match editor.stage {
                Stage::Loading | Stage::Saving => div().child(self.t(Key::ShiftChecking)),
                Stage::Draft => self
                    .weekly_fields(editor, cx)
                    .when_some(editor.baseline.as_ref(), |body, baseline| {
                        self.render_weekly_conflicts(editor, baseline, body, cx)
                    }),
                Stage::Retry(_) => div().child(self.t(Key::ShiftSaveUncertain)).when(
                    self.can_edit_staff_hours(),
                    |body| {
                        body.child(self.button(
                            "weekly-retry",
                            self.t(Key::ShiftRetrySave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_weekly_hours(cx)),
                        ))
                    },
                ),
                Stage::Error | Stage::Stale => {
                    let stale = matches!(editor.stage, Stage::Stale);
                    let id = editor.staff_id.clone();
                    let name = editor.name.clone();
                    div()
                        .child(self.t(if stale {
                            Key::ShiftWeekStale
                        } else {
                            Key::ShiftLoadFailed
                        }))
                        .when(stale, |body| body.child(self.weekly_fields(editor, cx)))
                        .when(self.can_edit_staff_hours(), |body| {
                            body.child(self.button(
                                "weekly-reload",
                                self.t(if stale {
                                    Key::ShiftWeekReload
                                } else {
                                    Key::ShiftReloadDay
                                }),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_weekly_hours(id.clone(), name.clone(), cx)
                                }),
                            ))
                        })
                }
                Stage::Saved => div()
                    .child(self.t(Key::ShiftWeekSaved))
                    .when_some(editor.baseline.as_ref(), |body, saved| {
                        self.render_weekly_conflicts(editor, saved, body, cx)
                    }),
            }
        };
        div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::ShiftWeekTitle)),
                    )
                    .when(!editor.busy(), |header| {
                        header.child(self.button(
                            "weekly-close",
                            self.t(Key::Close),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                    }),
            )
            .child(editor.name.clone())
            .child(
                div()
                    .id("weekly-hours-scroll")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body)
                    .when_some(editor.error, |body, error| {
                        body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
                    }),
            )
    }

    fn weekly_fields(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let day = editor.day;
        let ranges = &editor.days[day];
        let editable = matches!(editor.stage, Stage::Draft);
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.t(Key::ShiftWeekLead))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(WEEK.map(|weekday| {
                        let index = weekday.num_days_from_sunday() as usize;
                        self.chip(
                            ("weekly-day", index),
                            i18n::weekday_short(self.locale, weekday),
                            day == index,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) = root.weekly_editor() {
                                    editor.day = index;
                                    editor.copy_targets = None;
                                    cx.notify();
                                }
                            }),
                        )
                    })),
            )
            .child(self.t(if ranges.is_empty() {
                Key::ShiftClosed
            } else {
                Key::ShiftTimeFormat
            }))
            .children(ranges.iter().enumerate().map(|(index, (start, end))| {
                let row = div().flex().items_center().gap_2();
                if !editable {
                    return row.child(format!("{}–{}", start.read(cx).text(), end.read(cx).text()));
                }
                row.child(div().flex_1().min_w_0().child(start.clone()))
                    .child(div().flex_1().min_w_0().child(end.clone()))
                    .child(self.button(
                        ("weekly-remove", index),
                        self.t(Key::ShiftRemoveRange),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Some(editor) = root.weekly_editor()
                                && index < editor.days[day].len()
                            {
                                editor.days[day].remove(index);
                                cx.notify();
                            }
                        }),
                    ))
            }))
            .when(
                editable && editor.days.iter().map(Vec::len).sum::<usize>() < 56,
                |form| {
                    form.child(
                        self.button(
                            "weekly-add",
                            self.t(Key::ShiftAddRange),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) = root.weekly_editor() {
                                    editor.days[day].push(editor::range_fields(None, cx));
                                    cx.notify();
                                }
                            }),
                        )
                        .debug_selector(|| "weekly-add-range".to_owned()),
                    )
                },
            )
            .when(editable && !ranges.is_empty(), |form| {
                form.child(self.weekly_copy_controls(editor, cx))
            })
            .when(editable && self.can_edit_staff_hours(), |form| {
                form.child(self.button(
                    "weekly-save",
                    self.t(Key::ShiftWeekSave),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| root.save_weekly_hours(cx)),
                ))
            })
    }

    fn weekly_copy_controls(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let day = editor.day;
        let mut form = div().flex().flex_wrap().gap_2().child(self.button(
            "weekly-copy-toggle",
            self.t(Key::ShiftWeekCopyTo),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| {
                if let Some(editor) = root.weekly_editor() {
                    editor.copy_targets = editor.copy_targets.is_none().then_some([false; 7]);
                    cx.notify();
                }
            }),
        ));
        if let Some(selected) = editor.copy_targets {
            form = form
                .children(
                    WEEK.into_iter()
                        .filter(|weekday| weekday.num_days_from_sunday() as usize != day)
                        .map(|weekday| {
                            let target = weekday.num_days_from_sunday() as usize;
                            self.chip(
                                ("weekly-copy-day", target),
                                i18n::weekday_short(self.locale, weekday),
                                selected[target],
                                cx.listener(move |root, _, _, cx| {
                                    if let Some(editor) = root.weekly_editor()
                                        && let Some(targets) = &mut editor.copy_targets
                                    {
                                        targets[target] = !targets[target];
                                        cx.notify();
                                    }
                                }),
                            )
                        }),
                )
                .when(selected.contains(&true), |controls| {
                    controls.child(self.button(
                        "weekly-copy-apply",
                        self.t(Key::ShiftWeekCopyApply),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            if let Some(editor) = root.weekly_editor() {
                                editor.apply_copy(cx);
                                cx.notify();
                            }
                        }),
                    ))
                });
        }
        form
    }
    fn render_weekly_conflicts(
        &self,
        editor: &Editor,
        saved: &WeeklyHours,
        body: gpui::Div,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let updates = &editor.conflict_updates;
        let conflicts = updates.current.as_deref().unwrap_or(&saved.conflicts);
        body.when(updates.failed, |body| {
            body.child(
                div()
                    .text_sm()
                    .child(self.t(Key::ShiftConflictRefreshFailed)),
            )
            .when(self.status.connectivity == Connectivity::Online, |body| {
                body.child(self.button(
                    "weekly-conflict-refresh",
                    self.t(Key::ShiftConflictRetry),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(editor) = root.weekly_editor() {
                            editor.conflict_updates.failed = false;
                        }
                        root.refresh_weekly_conflicts_if_ready(cx);
                        cx.notify();
                    }),
                ))
            })
        })
        .when(
            !updates.failed && (updates.loading || !updates.appointments.is_empty()),
            |body| body.child(div().text_sm().child(self.t(Key::ShiftConflictRefresh))),
        )
        .when(!conflicts.is_empty(), |body| {
            body.child(self.schedule_conflict_list(conflicts, self.tz, true, cx))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn appointment_from_a_schedule_conflict_returns_to_the_same_draft(
        cx: &mut TestAppContext,
    ) {
        use super::super::super::tests::{EXISTING, desk};
        const MISSING: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1080.), px(820.)));
        root.update(cx, |root, cx| {
            root.open_team_shifts(cx);
            let appointment = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            let baseline = serde_json::from_value(serde_json::json!({
                "staffId": appointment.staff_id,
                "revision": "a".repeat(64),
                "hours": [],
                "conflicts": ([EXISTING, MISSING].map(|id| serde_json::json!({
                    "appointmentId": id,
                    "clientId": appointment.client_id,
                    "startsAt": appointment.starts_at,
                    "endsAt": appointment.ends_at,
                    "reasons": ["outside_working_hours"],
                }))),
            }))
            .unwrap();
            let Overlay::TeamShifts(desk) = &mut root.overlay else {
                panic!("expected shift panel")
            };
            desk.weekly = Some(Editor {
                staff_id: appointment.staff_id,
                name: "Fixture".into(),
                request: Arc::new(()),
                baseline: Some(Arc::new(baseline)),
                days: Default::default(),
                day: 2,
                copy_targets: None,
                stage: Stage::Draft,
                error: None,
                discard: false,
                conflict_updates: ConflictUpdates::default(),
            });
            desk.weekly.as_mut().unwrap().days[2].push(editor::range_fields(
                Some(&DateShiftRange {
                    start_time: "11:00".into(),
                    end_time: "16:00".into(),
                }),
                cx,
            ));
        });
        cx.run_until_parked();

        let click_conflict = |selector: &'static str, cx: &mut gpui::VisualTestContext| {
            let button = cx.debug_bounds(selector).unwrap();
            cx.simulate_click(button.center(), Default::default());
            cx.run_until_parked();
        };
        click_conflict(
            "shift-open-appointment-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            cx,
        );
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::TeamShifts(desk)
                if desk.unavailable_appointment.as_deref() == Some(MISSING)));
        });

        click_conflict(
            "shift-open-appointment-01a1d81e-0000-7000-8000-0000000000e1",
            cx,
        );
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::Details(details)
                if details.id == EXISTING && matches!(details.return_to, Some(AppointmentReturn::TeamShifts(_)))));
        });
        let close = cx.debug_bounds("calendar-details-close").unwrap();
        cx.simulate_click(close.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let draft = root.weekly_editor().expect("return to weekly draft");
            assert_eq!(draft.day, 2);
            assert_eq!(draft.hours(cx).unwrap()[0].start_time, "11:00");
            assert_eq!(root.svc.store.outbox_len().unwrap(), 0);
        });

        click_conflict(
            "shift-open-appointment-01a1d81e-0000-7000-8000-0000000000e1",
            cx,
        );
        root.update(cx, |root, cx| {
            root.cancel_appointment(cx);
            assert_eq!(
                root.svc.store.outbox_len().unwrap(),
                0,
                "cancellation requires confirmation"
            );
            root.cancel_appointment(cx);
            let draft = root
                .weekly_editor()
                .expect("return after appointment action");
            assert_eq!(draft.hours(cx).unwrap()[0].end_time, "16:00");
            assert!(draft.conflict_updates.appointments.contains(EXISTING));
            assert_eq!(root.svc.store.outbox_len().unwrap(), 1);
        });
    }

    #[gpui::test]
    async fn weekly_draft_copies_to_selected_days_and_survives_a_stale_save(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::super::tests::open(cx);
        window
            .update(cx, |_, _, cx| {
                let baseline: WeeklyHours = serde_json::from_value(serde_json::json!({
                    "staffId": "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
                    "revision": "a".repeat(64),
                    "hours": [{"weekday":1,"startTime":"09:00","endTime":"13:00"}],
                    "conflicts": [],
                }))
                .unwrap();
                let mut editor = Editor {
                    staff_id: "fixture".to_owned(),
                    name: "Fixture".to_owned(),
                    request: Arc::new(()),
                    baseline: Some(Arc::new(baseline)),
                    days: Default::default(),
                    day: 1,
                    copy_targets: None,
                    stage: Stage::Draft,
                    error: None,
                    discard: false,
                    conflict_updates: ConflictUpdates::default(),
                };
                editor.days[1].push(editor::range_fields(
                    Some(&DateShiftRange {
                        start_time: "09:00".to_owned(),
                        end_time: "13:00".to_owned(),
                    }),
                    cx,
                ));
                assert!(editor.can_close(cx));
                editor.copy_targets = Some([false, false, true, false, true, false, false]);
                editor.apply_copy(cx);
                assert_eq!(
                    editor
                        .hours(cx)
                        .unwrap()
                        .iter()
                        .map(|range| range.weekday)
                        .collect::<Vec<_>>(),
                    [1, 2, 4]
                );
                editor.stage = Stage::Stale;
                assert!(!editor.can_close(cx));
                assert!(editor.discard);
                assert!(!editor.can_close(cx));
                assert!(!editor.discard);
                assert_eq!(editor.hours(cx).unwrap().len(), 3);
            })
            .unwrap();
    }
}
