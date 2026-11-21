use super::*;

#[derive(Clone, Copy)]
enum ClientReportBreakdown {
    Groups,
    Frequency,
    NetCollections,
}

struct ClientBreakdownTable {
    title: Key,
    basis: Key,
    row_heading: Key,
    value_heading: Key,
    empty: Key,
    export: Key,
    table_id: &'static str,
    export_id: &'static str,
    rows: Vec<(SharedString, SharedString)>,
}

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
            .children(self.render_client_breakdown(ClientReportBreakdown::Groups, desk, report, cx))
            .children(self.render_client_breakdown(
                ClientReportBreakdown::Frequency,
                desk,
                report,
                cx,
            ))
            .children(self.render_client_breakdown(
                ClientReportBreakdown::NetCollections,
                desk,
                report,
                cx,
            ))
    }

    fn render_client_breakdown(
        &self,
        kind: ClientReportBreakdown,
        desk: &Desk,
        report: &ClientReport,
        cx: &mut Context<Self>,
    ) -> Option<gpui::Div> {
        let ClientBreakdownTable {
            title,
            basis,
            row_heading,
            value_heading,
            empty,
            export,
            table_id,
            export_id,
            rows,
        } = match kind {
            ClientReportBreakdown::Groups => ClientBreakdownTable {
                title: Key::ReportClientGroups,
                basis: Key::ReportClientGroupsBasis,
                row_heading: Key::ReportClientGroup,
                value_heading: Key::ReportClients,
                empty: Key::ReportClientGroupsEmpty,
                export: Key::ReportExportClientGroups,
                table_id: "client-group-report-table",
                export_id: "client-group-report-export",
                rows: report
                    .groups
                    .as_ref()?
                    .iter()
                    .map(|entry| (entry.name.clone().into(), entry.clients.to_string().into()))
                    .collect(),
            },
            ClientReportBreakdown::Frequency => {
                let frequency = report.frequency.as_ref()?;
                ClientBreakdownTable {
                    title: Key::ReportClientFrequency,
                    basis: Key::ReportClientFrequencyBasis,
                    row_heading: Key::ReportClientFrequencyVisits,
                    value_heading: Key::ReportClients,
                    empty: Key::ReportNoClients,
                    export: Key::ReportExportClientFrequency,
                    table_id: "client-frequency-report-table",
                    export_id: "client-frequency-report-export",
                    rows: [
                        (Key::ReportClientFrequencyOne, frequency.one),
                        (Key::ReportClientFrequencyTwo, frequency.two),
                        (Key::ReportClientFrequencyThree, frequency.three_or_more),
                    ]
                    .into_iter()
                    .map(|(label, count)| (self.t(label).into(), count.to_string().into()))
                    .collect(),
                }
            }
            ClientReportBreakdown::NetCollections => ClientBreakdownTable {
                title: Key::ReportClientCollections,
                basis: Key::ReportClientCollectionsBasis,
                row_heading: Key::ReportOutcomeClient,
                value_heading: Key::ReportClientCollectionsNet,
                empty: Key::ReportClientCollectionsEmpty,
                export: Key::ReportExportClientCollections,
                table_id: "client-collections-report-table",
                export_id: "client-collections-report-export",
                rows: report
                    .top_collections
                    .as_ref()?
                    .iter()
                    .map(|entry| {
                        (
                            entry.name.clone().into(),
                            self.amount_label(
                                entry.net_cents,
                                sob_core::reports::financial::CURRENCY,
                            )
                            .into(),
                        )
                    })
                    .collect(),
            },
        };
        let has_rows = !rows.is_empty();
        Some(
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
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(self.t(title)))
                        .when(
                            has_rows
                                && !desk.export_pending
                                && desk.request.is_none()
                                && desk.error.is_none(),
                            |row| {
                                row.child(self.button(
                                    export_id,
                                    self.t(export),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.save_client_breakdown(kind, cx)
                                    }),
                                ))
                            },
                        ),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(basis)),
                )
                .when(!has_rows, |view| {
                    view.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(empty)),
                    )
                })
                .when(has_rows, |view| {
                    view.child(
                        div()
                            .id(table_id)
                            .debug_selector(move || table_id.to_string())
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .child(self.render_client_breakdown_row(
                                self.t(row_heading).into(),
                                self.t(value_heading).into(),
                                true,
                            ))
                            .children(rows.into_iter().map(|(label, value)| {
                                self.render_client_breakdown_row(label, value, false)
                            })),
                    )
                }),
        )
    }

    fn render_client_breakdown_row(
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

    fn save_client_breakdown(&mut self, kind: ClientReportBreakdown, cx: &mut Context<Self>) {
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
        let (name, csv) = match kind {
            ClientReportBreakdown::Groups => ("client-groups", report.groups_csv()),
            ClientReportBreakdown::Frequency => (
                "client-frequency",
                report.frequency.as_ref().map(|band| band.to_csv()),
            ),
            ClientReportBreakdown::NetCollections => {
                ("client-net-collections", report.collections_csv())
            }
        };
        let Some(csv) = csv else {
            return;
        };
        self.choose_report_export(
            format!("{name}-{}-{}.csv", report.from, report.to),
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
        let (dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(650.), px(450.)));
        root.update(cx, |root, cx| {
            root.open_reports(cx);
            root.select_report_mode(ReportMode::Clients, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Overview);
            desk.can_view_financial_reports = true;
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
                    "frequency": { "one": 2, "two": 0, "threeOrMore": 3 },
                    "topCollections": [{ "name": "=Example, customer", "netCents": 9500 }],
                }))
                .unwrap(),
            );
            assert_eq!(
                desk.client_report.as_ref().unwrap().groups_csv().as_deref(),
                Some("group,clients\r\nvip,2\r\n'=group,1\r\n")
            );
            desk.request = None;
            desk.error = None;
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("client-report-table").is_some());
        assert!(cx.debug_bounds("client-group-report-table").is_some());
        assert!(cx.debug_bounds("client-frequency-report-table").is_some());
        assert!(cx.debug_bounds("client-collections-report-table").is_some());
        let export = dir.path().join("frequency.csv");
        root.update(cx, |root, cx| {
            root.save_client_breakdown(ClientReportBreakdown::Frequency, cx)
        });
        cx.simulate_new_path_selection(|_| Some(export.clone()));
        cx.run_until_parked();
        assert_eq!(
            std::fs::read_to_string(&export).unwrap(),
            "visit_frequency,clients\r\none,2\r\ntwo,0\r\nthreeOrMore,3\r\n"
        );
        let export = dir.path().join("collections.csv");
        root.update(cx, |root, cx| {
            root.save_client_breakdown(ClientReportBreakdown::NetCollections, cx)
        });
        cx.simulate_new_path_selection(|_| Some(export.clone()));
        cx.run_until_parked();
        assert_eq!(
            std::fs::read_to_string(&export).unwrap(),
            "client,net_cents,currency\r\n\"'=Example, customer\",9500,EUR\r\n"
        );
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
