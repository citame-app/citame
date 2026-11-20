use super::*;

impl Root {
    pub(super) fn render_client_report(
        &self,
        desk: &Desk,
        report: &ClientReport,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let columns = [
            self.t(Key::ReportNewClients),
            self.t(Key::ReportReturningClients),
        ];
        let pages = report.rows.len().div_ceil(PAGE_SIZE).max(1);
        let page = desk.page.min(pages - 1);
        let row = |day: SharedString, new: SharedString, returning: SharedString, header| {
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .py_2()
                .text_sm()
                .border_b_1()
                .border_color(theme::line())
                .when(header, |row| {
                    row.bg(theme::bg()).font_weight(FontWeight::SEMIBOLD)
                })
                .child(div().flex_1().min_w_0().child(day))
                .child(div().w(px(74.)).text_right().child(new))
                .child(div().w(px(96.)).text_right().child(returning))
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(div().text_sm().text_color(theme::muted()).child(format!(
                        "{} – {}",
                        i18n::date_label(self.locale, report.from),
                        i18n::date_label(self.locale, report.to)
                    )))
                    .when(
                        !desk.export_pending
                            && desk.request.is_none()
                            && desk.error.is_none()
                            && !report.rows.is_empty(),
                        |view| {
                            view.child(self.button(
                                "client-report-export",
                                self.t(Key::ReportExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.save_report(cx)),
                            ))
                        },
                    ),
            )
            .when_some(desk.export_notice, |view, notice| {
                view.child(div().text_sm().child(self.t(notice)))
            })
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::ReportClientBasis)),
            )
            .child(
                div().flex().gap_2().children(
                    columns
                        .into_iter()
                        .zip([report.totals.new_clients, report.totals.returning_clients])
                        .map(|(label, count)| {
                            div()
                                .flex_1()
                                .min_w_0()
                                .rounded_md()
                                .border_1()
                                .border_color(theme::line())
                                .p_3()
                                .child(div().text_sm().text_color(theme::muted()).child(label))
                                .child(
                                    div()
                                        .text_lg()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(count.to_string()),
                                )
                        }),
                ),
            )
            .when(report.rows.is_empty(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::ReportNoClients)),
                )
            })
            .when(!report.rows.is_empty(), |view| {
                view.child(
                    div()
                        .id("client-report-table")
                        .debug_selector(|| "client-report-table".to_string())
                        .rounded_md()
                        .border_1()
                        .border_color(theme::line())
                        .child(row(
                            self.t(Key::ReportDay).into(),
                            columns[0].into(),
                            columns[1].into(),
                            true,
                        ))
                        .children(
                            report
                                .rows
                                .iter()
                                .skip(page * PAGE_SIZE)
                                .take(PAGE_SIZE)
                                .map(|entry| {
                                    row(
                                        i18n::date_label(self.locale, entry.date).into(),
                                        entry.counts.new_clients.to_string().into(),
                                        entry.counts.returning_clients.to_string().into(),
                                        false,
                                    )
                                }),
                        ),
                )
            })
            .when(pages > 1, |view| {
                view.child(self.render_report_pager(page, pages, cx))
            })
            .when_some(report.groups.as_ref(), |view, groups| {
                view.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .justify_between()
                                .items_center()
                                .gap_2()
                                .child(
                                    div()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(self.t(Key::ReportClientGroups)),
                                )
                                .when(
                                    !groups.is_empty()
                                        && !desk.export_pending
                                        && desk.request.is_none()
                                        && desk.error.is_none(),
                                    |row| {
                                        row.child(self.button(
                                            "client-group-report-export",
                                            self.t(Key::ReportExportClientGroups),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                root.save_client_groups(cx)
                                            }),
                                        ))
                                    },
                                ),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::ReportClientGroupsBasis)),
                        )
                        .when(groups.is_empty(), |view| {
                            view.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::ReportClientGroupsEmpty)),
                            )
                        })
                        .when(!groups.is_empty(), |view| {
                            view.child(
                                div()
                                    .id("client-group-report-table")
                                    .debug_selector(|| "client-group-report-table".to_string())
                                    .rounded_md()
                                    .border_1()
                                    .border_color(theme::line())
                                    .child(self.render_client_group_row(
                                        self.t(Key::ReportClientGroup).into(),
                                        self.t(Key::ReportClients).into(),
                                        true,
                                    ))
                                    .children(groups.iter().map(|entry| {
                                        self.render_client_group_row(
                                            entry.name.clone().into(),
                                            entry.clients.to_string().into(),
                                            false,
                                        )
                                    })),
                            )
                        }),
                )
            })
    }

    fn render_client_group_row(
        &self,
        label: SharedString,
        count: SharedString,
        header: bool,
    ) -> gpui::Div {
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap_3()
            .px_3()
            .py_2()
            .text_sm()
            .border_b_1()
            .border_color(theme::line())
            .when(header, |row| {
                row.bg(theme::bg()).font_weight(FontWeight::SEMIBOLD)
            })
            .child(div().flex_1().min_w_0().child(label))
            .child(div().flex_shrink_0().child(count))
    }

    fn save_client_groups(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &self.overlay else {
            return;
        };
        if desk.mode != ReportMode::Clients
            || desk.request.is_some()
            || desk.error.is_some()
            || desk.export_pending
        {
            return;
        }
        let Some(report) = desk.client_report.as_ref() else {
            return;
        };
        let Some(csv) = report.groups_csv() else {
            return;
        };
        self.choose_report_export(
            format!("client-groups-{}-{}.csv", report.from, report.to),
            move |output| {
                use std::io::Write;
                output.write_all(csv.as_bytes())
            },
            cx,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn client_report_preserves_filters_and_renders_the_daily_table(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(650.), px(450.)));
        root.update(cx, |root, cx| {
            root.open_reports(cx);
            root.select_report_mode(ReportMode::Clients, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Overview);
            desk.can_report_clients = true;
            desk.submitted.as_mut().unwrap().staff_id = Some("staff-filter".into());
            let expected_query = desk.submitted.clone().unwrap();

            root.select_report_mode(ReportMode::Clients, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Clients);
            assert!(desk.submitted.as_ref() == Some(&expected_query));
            desk.client_report = Some(
                serde_json::from_value(serde_json::json!({
                    "from": expected_query.from,
                    "to": expected_query.to,
                    "totals": { "newClients": 2, "returningClients": 3 },
                    "rows": [{ "date": expected_query.to, "newClients": 2, "returningClients": 3 }],
                    "groups": [{ "name": "vip", "clients": 2 }, { "name": "=group", "clients": 1 }],
                }))
                .unwrap(),
            );
            assert_eq!(
                desk.client_report.as_ref().unwrap().groups_csv().as_deref(),
                Some("group,clients\r\nvip,2\r\n'=group,1\r\n")
            );
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("client-report-table").is_some());
        assert!(cx.debug_bounds("client-group-report-table").is_some());
        root.update(cx, |root, cx| {
            root.select_report_mode(ReportMode::Overview, cx);
            let Overlay::Reports(desk) = &root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Overview);
            assert!(desk.client_report.is_none());
            assert_eq!(
                desk.submitted.as_ref().unwrap().staff_id.as_deref(),
                Some("staff-filter")
            );
        });
    }

    #[gpui::test]
    async fn a_failed_client_report_retries_without_another_sync_event(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.open_reports(cx);
            let status = SyncStatus {
                connectivity: Connectivity::Online,
                cursor: 42,
                ..Default::default()
            };
            root.status = status.clone();
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            desk.mode = ReportMode::Clients;
            desk.request = None;
            desk.observed_cursor = status.cursor;
            desk.error = Some(Key::ReportFailed);
            desk.retry_at = Some(Instant::now() + RETRY_DELAY);
            root.refresh_open_report(&status, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.request.is_none());
            desk.retry_at = Some(Instant::now());
            root.refresh_open_report(&status, cx);
            let Overlay::Reports(desk) = &root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.request.is_some());
            assert!(desk.retry_at.is_none());
        });
    }
}
