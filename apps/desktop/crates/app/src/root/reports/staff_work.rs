use super::*;
use sob_core::reports::StaffWorkPeriod;

impl Root {
    fn save_staff_work(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &self.overlay else {
            return;
        };
        let Some(work) = &desk.staff_work else {
            return;
        };
        let detail = if desk.staff_work_upcoming {
            &work.upcoming
        } else {
            &work.selected
        };
        let name = format!("staff-work-{}-{}.csv", detail.from, detail.to);
        let csv = detail.to_csv();
        self.choose_report_export(
            name,
            move |output| {
                use std::io::Write;
                output.write_all(csv.as_bytes())
            },
            cx,
        );
    }

    pub(super) fn render_staff_work(
        &self,
        desk: &Desk,
        report: &StaffWorkReport,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let period = if desk.staff_work_upcoming {
            &report.upcoming
        } else {
            &report.selected
        };
        let pages = period.days.len().div_ceil(PAGE_SIZE).max(1);
        let page = desk.staff_work_page.min(pages - 1);
        let timezone = report.timezone.parse().unwrap_or(self.tz);
        let period_choices = [
            (false, Key::ReportStaffWorkSelected),
            (true, Key::ReportStaffWorkUpcoming),
        ];
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::ReportStaffWork))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::TeamOccupancyHelp)),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(period_choices.into_iter().map(|(upcoming, key)| {
                        self.chip(
                            ("staff-work-period", usize::from(upcoming)),
                            self.t(key),
                            desk.staff_work_upcoming == upcoming,
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::Reports(desk) = &mut root.overlay {
                                    desk.staff_work_upcoming = upcoming;
                                    desk.staff_work_page = 0;
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                    }))
                    .when(!desk.export_pending, |row| {
                        row.child(
                            self.button(
                                "staff-work-export",
                                self.t(Key::ReportStaffWorkExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.save_staff_work(cx)),
                            )
                            .tab_index(0),
                        )
                    }),
            )
            .child(self.render_staff_work_days(period, page))
            .when(pages > 1, |view| {
                view.child(self.render_report_pager(ReportPage::StaffWork, page, pages, cx))
            })
            .child(self.label(Key::ReportStaffWorkBlocks))
            .when(period.unavailable.is_empty(), |view| {
                view.child(self.t(Key::ReportStaffWorkNoBlocks))
            })
            .children(period.unavailable.iter().map(|block| {
                let stamp = |at: DateTime<Utc>| {
                    let local = at.with_timezone(&timezone);
                    format!(
                        "{} · {}",
                        i18n::date_label(self.locale, local.date_naive()),
                        local.format("%H:%M")
                    )
                };
                div().text_sm().child(format!(
                    "{} – {}",
                    stamp(block.starts_at),
                    stamp(block.ends_at)
                ))
            }))
    }

    fn render_staff_work_days(&self, period: &StaffWorkPeriod, page: usize) -> impl IntoElement {
        div()
            .id("staff-work-grid")
            .overflow_x_scroll()
            .border_1()
            .border_color(theme::line())
            .rounded_md()
            .child(
                div()
                    .min_w(px(680.))
                    .child(self.occupancy_table_head(Key::ReportDay))
                    .children(
                        period
                            .days
                            .iter()
                            .skip(page * PAGE_SIZE)
                            .take(PAGE_SIZE)
                            .map(|day| {
                                report_table_row(
                                    i18n::date_label(self.locale, day.date),
                                    day.occupancy.minutes().map(|minute| minute.to_string()),
                                    Some(occupancy_label(day.occupancy.occupancy_rate)),
                                    false,
                                )
                            }),
                    ),
            )
    }
}
