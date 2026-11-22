use super::*;
use chrono::Weekday;
use sob_core::http::{DatedShiftEdit, OPENING_EXCEPTION_LIMIT, OpeningException, OpeningSchedule};
use sob_core::model::DateShiftRange;

const DAYS: [Weekday; 7] = [
    Weekday::Mon,
    Weekday::Tue,
    Weekday::Wed,
    Weekday::Thu,
    Weekday::Fri,
    Weekday::Sat,
    Weekday::Sun,
];
type RangeFields = (Entity<TextField>, Entity<TextField>);

pub(super) struct HoursEditor {
    weekly: Option<[Vec<RangeFields>; 7]>,
    hidden_week: Option<[Vec<RangeFields>; 7]>,
    weekday: usize,
    exceptions: Vec<ExceptionEditor>,
}

struct ExceptionEditor {
    date: Entity<TextField>,
    ranges: Vec<RangeFields>,
}

#[derive(Clone, Copy)]
enum Day {
    Week(usize),
    Exception(usize),
}

impl Day {
    fn key(self) -> usize {
        match self {
            Self::Week(day) => day,
            Self::Exception(index) => index + 7,
        }
    }
}

fn field(value: &str, placeholder: &'static str, cx: &mut Context<Root>) -> Entity<TextField> {
    let input = cx.new(|cx| {
        let mut input = TextField::new(placeholder, false, cx);
        input.set_text(value, cx);
        input
    });
    cx.observe(&input, |_, _, cx| cx.notify()).detach();
    input
}

fn range_fields(range: Option<&DateShiftRange>, cx: &mut Context<Root>) -> RangeFields {
    (
        field(range.map_or("", |value| &value.start_time), "HH:MM", cx),
        field(range.map_or("", |value| &value.end_time), "HH:MM", cx),
    )
}

impl HoursEditor {
    pub(super) fn new(schedule: &OpeningSchedule, cx: &mut Context<Root>) -> Self {
        let fields = |ranges: &[DateShiftRange], cx: &mut Context<Root>| {
            ranges
                .iter()
                .map(|range| range_fields(Some(range), cx))
                .collect()
        };
        Self {
            weekly: schedule
                .weekly
                .as_ref()
                .map(|week| std::array::from_fn(|day| fields(&week[day], cx))),
            weekday: 1,
            hidden_week: None,
            exceptions: schedule
                .exceptions
                .iter()
                .map(|entry| ExceptionEditor {
                    date: field(&entry.date.to_string(), "YYYY-MM-DD", cx),
                    ranges: fields(&entry.ranges, cx),
                })
                .collect(),
        }
    }

    pub(super) fn draft(&self, cx: &App) -> Option<OpeningSchedule> {
        let parse = |ranges: &[RangeFields]| {
            if ranges.is_empty() {
                Some(Vec::new())
            } else {
                DatedShiftEdit::parse_ranges(
                    ranges
                        .iter()
                        .map(|(start, end)| (start.read(cx).text(), end.read(cx).text())),
                )
            }
        };
        let weekly = match &self.weekly {
            Some(week) => {
                let days = week
                    .iter()
                    .map(|day| parse(day))
                    .collect::<Option<Vec<_>>>()?;
                Some(days.try_into().ok()?)
            }
            None => None,
        };
        let mut exceptions: Vec<OpeningException> = self
            .exceptions
            .iter()
            .map(|entry| {
                let value = entry.date.read(cx).text().trim();
                let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
                if value.len() != 10 || date.to_string() != value {
                    return None;
                }
                Some(OpeningException {
                    date,
                    ranges: parse(&entry.ranges)?,
                })
            })
            .collect::<Option<_>>()?;
        exceptions.sort_by_key(|entry| entry.date);
        if exceptions
            .windows(2)
            .any(|pair| pair[0].date == pair[1].date)
        {
            return None;
        }
        Some(OpeningSchedule { weekly, exceptions })
    }

    fn ranges(&mut self, day: Day) -> Option<&mut Vec<RangeFields>> {
        match day {
            Day::Week(day) => self.weekly.as_mut().and_then(|week| week.get_mut(day)),
            Day::Exception(index) => self
                .exceptions
                .get_mut(index)
                .map(|entry| &mut entry.ranges),
        }
    }
}

impl Root {
    fn edit_opening_hours(
        &mut self,
        cx: &mut Context<Self>,
        edit: impl FnOnce(&mut HoursEditor, &mut Context<Self>),
    ) {
        self.edit_business_profile(cx, |profile, cx| {
            if let Some(hours) = &mut profile.hours {
                edit(hours, cx);
            }
        });
    }

    pub(super) fn render_opening_hours(
        &self,
        editor: &HoursEditor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .id("opening-hours-editor")
            .debug_selector(|| "opening-hours-editor".to_string())
            .flex()
            .flex_col()
            .gap_2()
            .border_t_1()
            .border_color(theme::line())
            .pt_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::OpeningHours)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::OpeningHoursHelp)),
            )
            .when(editor.draft(cx).is_none(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::OpeningInvalid)),
                )
            })
            .child(self.chip(
                "opening-weekly",
                self.t(Key::OpeningWeekly),
                editor.weekly.is_some(),
                cx.listener(|root, _, _, cx| {
                    root.edit_opening_hours(cx, |editor, _| {
                        if editor.weekly.is_some() {
                            editor.hidden_week = editor.weekly.take();
                        } else {
                            editor.weekly = Some(
                                editor
                                    .hidden_week
                                    .take()
                                    .unwrap_or_else(|| std::array::from_fn(|_| Vec::new())),
                            );
                        }
                    })
                }),
            ))
            .when_some(editor.weekly.as_ref(), |view, week| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .children(DAYS.map(|weekday| {
                            let day = weekday.num_days_from_sunday() as usize;
                            self.chip(
                                ("opening-weekday", day),
                                i18n::weekday_short(self.locale, weekday),
                                editor.weekday == day,
                                cx.listener(move |root, _, _, cx| {
                                    root.edit_opening_hours(cx, |editor, _| editor.weekday = day)
                                }),
                            )
                        })),
                )
                .child(self.render_opening_ranges(
                    Day::Week(editor.weekday),
                    &week[editor.weekday],
                    cx,
                ))
            })
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::OpeningExceptions)),
            )
            .children(editor.exceptions.iter().enumerate().map(|(index, entry)| {
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_1()
                    .border_color(theme::line())
                    .rounded_md()
                    .p_2()
                    .child(div().text_sm().child(self.t(Key::OpeningDate)))
                    .child(entry.date.clone())
                    .child(self.render_opening_ranges(Day::Exception(index), &entry.ranges, cx))
                    .child(self.button(
                        ("opening-remove-date", index),
                        self.t(Key::OpeningRemoveDate),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.edit_opening_hours(cx, |editor, _| {
                                if index < editor.exceptions.len() {
                                    editor.exceptions.remove(index);
                                }
                            })
                        }),
                    ))
            }))
            .when(editor.exceptions.len() < OPENING_EXCEPTION_LIMIT, |view| {
                view.child(self.button(
                    "opening-add-date",
                    self.t(Key::OpeningAddDate),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        root.edit_opening_hours(cx, |editor, cx| {
                            if editor.exceptions.len() < OPENING_EXCEPTION_LIMIT {
                                editor.exceptions.push(ExceptionEditor {
                                    date: field("", "YYYY-MM-DD", cx),
                                    ranges: Vec::new(),
                                });
                            }
                        })
                    }),
                ))
            })
    }

    fn render_opening_ranges(
        &self,
        day: Day,
        ranges: &[RangeFields],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when(ranges.is_empty(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::OpeningClosed)),
                )
            })
            .children(ranges.iter().enumerate().map(|(index, (start, end))| {
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(90.))
                            .text_sm()
                            .child(self.t(Key::OpeningStart))
                            .child(start.clone()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(90.))
                            .text_sm()
                            .child(self.t(Key::OpeningEnd))
                            .child(end.clone()),
                    )
                    .child(self.button(
                        ("opening-remove-range", day.key() * 8 + index),
                        self.t(Key::OpeningRemoveRange),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.edit_opening_hours(cx, |editor, _| {
                                if let Some(ranges) = editor.ranges(day)
                                    && index < ranges.len()
                                {
                                    ranges.remove(index);
                                }
                            })
                        }),
                    ))
            }))
            .when(ranges.len() < 8, |view| {
                view.child(self.button(
                    ("opening-add-range", day.key()),
                    self.t(Key::OpeningAddRange),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.edit_opening_hours(cx, |editor, cx| {
                            if let Some(ranges) = editor.ranges(day)
                                && ranges.len() < 8
                            {
                                ranges.push(range_fields(None, cx));
                            }
                        })
                    }),
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn an_offline_profile_can_queue_split_hours_and_an_explicit_closure(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let reviewed: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
                "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
                "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
                "reminderFirstLeadMinutes": null, "reminderSecondLeadMinutes": null,
                "businessProfile": BusinessProfile { opening_schedule: Some(OpeningSchedule::default()), ..BusinessProfile::default() },
                "revision": "2026-11-21T00:00:00Z", "generation": "initial",
            })).unwrap();
            root.svc.store.cache_salon_configuration(&reviewed).unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_salon_configuration(cx);
            root.edit_opening_hours(cx, |editor, cx| {
                editor.weekly = Some(std::array::from_fn(|_| Vec::new()));
                let monday = editor.ranges(Day::Week(1)).unwrap();
                for (start, end) in [("14:00", "18:00"), ("09:00", "12:00")] {
                    monday.push(range_fields(Some(&DateShiftRange {
                        start_time: start.into(), end_time: end.into(),
                    }), cx));
                }
                editor.exceptions.push(ExceptionEditor {
                    date: field("2026-12-25", "YYYY-MM-DD", cx),
                    ranges: Vec::new(),
                });
            });
            root.save_salon_configuration(cx);
            let SalonConfigurationWork::Pending(Some(write)) = root.svc.store.salon_configuration_work().unwrap() else {
                panic!("Opening hours did not queue")
            };
            assert_eq!(serde_json::to_value(write).unwrap()["changes"], serde_json::json!({
                "businessProfile": {"openingSchedule": {
                    "weekly": [[], [{"startTime":"09:00","endTime":"12:00"},{"startTime":"14:00","endTime":"18:00"}], [], [], [], [], []],
                    "exceptions": [{"date":"2026-12-25","ranges":[]}]
                }}
            }));
        }).unwrap();
    }
}
