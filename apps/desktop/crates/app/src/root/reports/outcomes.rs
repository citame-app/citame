use super::{Desk as ReportDesk, *};
use sob_core::reports::OutcomePage;

#[derive(Default)]
pub(super) struct Desk {
    request: Option<Arc<()>>,
    result: Option<OutcomePage>,
    error: Option<Key>,
}

impl Desk {
    pub(super) fn reset_page(&mut self) {
        self.request = None;
        self.result = None;
        self.error = None;
    }
}

fn outcome_label(status: Outcome) -> Key {
    match status {
        Outcome::Cancelled => Key::ReportCancellations,
        Outcome::NoShow => Key::ReportNoShow,
    }
}

fn outcome_export_label(status: Outcome) -> Key {
    match status {
        Outcome::Cancelled => Key::ReportOutcomeExportCancellations,
        Outcome::NoShow => Key::ReportOutcomeExportNoShows,
    }
}

impl ReportDesk {
    fn outcome_query(&self) -> Option<(ReportQuery, Outcome)> {
        if self.request.is_some() {
            return None;
        }
        let report = self.summary.as_ref()?;
        let mut query = self.submitted.clone()?;
        if (query.from, query.to) != (report.from, report.to) {
            return None;
        }
        query.currency = report.currency.clone();
        Some((query, self.mode.outcome()?))
    }
}

impl Root {
    pub(super) fn select_report_mode(&mut self, mode: ReportMode, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        if desk.mode == mode || (!mode.uses_summary() && !desk.can_view_financial_reports) {
            return;
        }
        let reload = !desk.mode.uses_summary() || !mode.uses_summary();
        desk.mode = mode;
        desk.client_report = None;
        desk.financial_report = None;
        desk.outcomes.reset_page();
        desk.export_notice = None;
        if desk.error == Some(Key::ReportRange) {
            cx.notify();
            return;
        }
        if reload {
            desk.request = None;
            desk.page = 0;
            self.load_report(self.status.cursor, cx);
        } else {
            self.load_outcome_page(1, cx);
        }
        cx.notify();
    }

    pub(super) fn refresh_outcome_page(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &self.overlay {
            let page = desk
                .outcomes
                .result
                .as_ref()
                .map_or(1, |result| result.page);
            self.load_outcome_page(page, cx);
        }
    }

    fn load_outcome_page(&mut self, page: u32, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        let Some((query, status)) = desk.outcome_query() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            desk.outcomes.error = Some(Key::ReportOffline);
            cx.notify();
            return;
        };
        let session = self.svc.session.clone();
        let token = Arc::new(());
        desk.outcomes.request = Some(token.clone());
        desk.outcomes.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.report_outcomes(&query, status, page) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Reports(desk) = &mut root.overlay else {
                    return;
                };
                let outcomes = &mut desk.outcomes;
                if !outcomes
                    .request
                    .as_ref()
                    .is_some_and(|request| Arc::ptr_eq(request, &token))
                {
                    return;
                }
                outcomes.request = None;
                match result {
                    Ok(page) => outcomes.result = Some(page),
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_)) => {
                        outcomes.result = None;
                        outcomes.error = Some(Key::ReportRestricted);
                    }
                    Err(TransportError::Offline(_)) => outcomes.error = Some(Key::ReportOffline),
                    Err(_) => outcomes.error = Some(Key::ReportFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_outcomes(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &self.overlay else {
            return;
        };
        let Some((query, status)) = desk.outcome_query() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let name = format!(
            "appointments-{}-{}-{}.csv",
            status.value(),
            query.from,
            query.to
        );
        self.choose_report_export(
            name,
            move |output| {
                transport
                    .write_report_outcomes_csv(&query, status, output)
                    .map_err(std::io::Error::other)
            },
            cx,
        );
    }

    pub(super) fn render_report_mode(
        &self,
        desk: &ReportDesk,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .children(
                [
                    ReportMode::Overview,
                    ReportMode::Outcome(Outcome::Cancelled),
                    ReportMode::Outcome(Outcome::NoShow),
                ]
                .into_iter()
                .enumerate()
                .map(|(index, mode)| {
                    self.chip(
                        ("report-mode", index),
                        self.t(mode.outcome().map_or(Key::ReportOverview, outcome_label)),
                        desk.mode == mode,
                        cx.listener(move |root, _, _, cx| root.select_report_mode(mode, cx)),
                    )
                }),
            )
            .when(
                desk.can_view_financial_reports || desk.mode == ReportMode::Clients,
                |view| {
                    view.child(self.chip(
                        "report-mode-clients",
                        self.t(Key::ReportClients),
                        desk.mode == ReportMode::Clients,
                        cx.listener(|root, _, _, cx| {
                            root.select_report_mode(ReportMode::Clients, cx)
                        }),
                    ))
                },
            )
            .when(
                desk.can_view_financial_reports || desk.mode == ReportMode::Financial,
                |view| {
                    view.child(self.chip(
                        "report-mode-financial",
                        self.t(Key::FinancialReport),
                        desk.mode == ReportMode::Financial,
                        cx.listener(|root, _, _, cx| {
                            root.select_report_mode(ReportMode::Financial, cx)
                        }),
                    ))
                },
            )
    }

    pub(super) fn render_outcomes(
        &self,
        desk: &ReportDesk,
        status: Outcome,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let outcomes = &desk.outcomes;
        let mut body = div().flex().flex_col().gap_3();
        if let Some(error) = outcomes.error {
            body = body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                    .child(self.button(
                        "outcomes-retry",
                        self.t(Key::ReportApply),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.refresh_outcome_page(cx)),
                    )),
            );
        }
        let loading = outcomes.request.is_some() || desk.request.is_some();
        if loading {
            body = body.child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::ReportLoading)),
            );
        }
        let Some(page) = outcomes.result.as_ref() else {
            return body;
        };
        if page.total == 0 {
            return body.child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::ReportNoRows)),
            );
        }
        let pages = page.total.div_ceil(u64::from(page.page_size.max(1)));
        let page_number = page.page;
        let timezone = page.timezone.parse::<Tz>().unwrap_or(self.tz);
        let can_export = self.status.connectivity == Connectivity::Online
            && !loading
            && !desk.export_pending
            && outcomes.error.is_none();
        let total = &page.total.to_string();
        let header = outcome_row(
            [
                Key::ReportDay,
                Key::ReportOutcomeClient,
                Key::ReportStaff,
                Key::ReportOutcomeServices,
            ]
            .map(|key| self.t(key).to_owned()),
            true,
        );

        body.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(i18n::fill(self.t(Key::ReportOutcomeTotal), &[("n", total)])),
                )
                .when(can_export, |view| {
                    view.child(self.button(
                        "outcomes-export",
                        self.t(outcome_export_label(status)),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.save_outcomes(cx)),
                    ))
                }),
        )
        .child(
            div()
                .id("outcomes-table")
                .debug_selector(|| "outcomes-table".to_string())
                .overflow_x_scroll()
                .rounded_md()
                .border_1()
                .border_color(theme::line())
                .child(
                    div()
                        .min_w(px(600.))
                        .child(header)
                        .children(page.rows.iter().map(|row| {
                            let start = row.starts_at.with_timezone(&timezone);
                            outcome_row(
                                [
                                    format!(
                                        "{} {:02}:{:02}",
                                        i18n::date_label(self.locale, start.date_naive()),
                                        start.hour(),
                                        start.minute()
                                    ),
                                    row.client.clone().unwrap_or_else(|| {
                                        self.t(Key::ReportOutcomeUnknownClient).to_owned()
                                    }),
                                    row.staff.clone(),
                                    row.services.join(" · "),
                                ],
                                false,
                            )
                        })),
                ),
        )
        .when(pages > 1, |view| {
            view.child(
                div()
                    .flex()
                    .justify_end()
                    .items_center()
                    .gap_2()
                    .when(page_number > 1 && !loading, |view| {
                        view.child(self.button(
                            "outcomes-prev",
                            self.t(Key::InboxPrevious),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.load_outcome_page(page_number - 1, cx)
                            }),
                        ))
                    })
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(format!("{page_number} / {pages}")),
                    )
                    .when(u64::from(page_number) < pages && !loading, |view| {
                        view.child(self.button(
                            "outcomes-next",
                            self.t(Key::InboxNext),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.load_outcome_page(page_number + 1, cx)
                            }),
                        ))
                    }),
            )
        })
    }
}

fn outcome_row([date, client, staff, services]: [String; 4], header: bool) -> gpui::Div {
    div()
        .flex()
        .items_start()
        .gap_3()
        .px_3()
        .py_2()
        .text_sm()
        .border_b_1()
        .border_color(theme::line())
        .when(header, |row| {
            row.bg(theme::bg()).font_weight(FontWeight::SEMIBOLD)
        })
        .child(div().w(px(160.)).flex_shrink_0().child(date))
        .child(div().w(px(145.)).flex_shrink_0().child(client))
        .child(div().w(px(120.)).flex_shrink_0().child(staff))
        .child(div().flex_1().min_w_0().child(services))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn switching_outcome_keeps_the_filters_and_clears_the_previous_cases(
        cx: &mut TestAppContext,
    ) {
        let (_dir, mut config) = super::super::super::tests::desk();
        config.start_view = Some("reports-cancelled".into());
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(650.), px(450.)));
        root.update(cx, |root, cx| {
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert_eq!(desk.mode.outcome(), Some(Outcome::Cancelled));
            let submitted = desk.submitted.as_ref().unwrap();
            desk.request = None;
            desk.summary = Some(
                serde_json::from_value(serde_json::json!({
                    "from": submitted.from, "to": submitted.to, "currency": "EUR",
                    "totals": {
                        "appointments": 1, "revenueCents": 0,
                        "byStatus": {"booked": 0, "completed": 0, "cancelled": 1, "no_show": 0}
                    },
                    "series": [], "perStaff": [], "topServices": [],
                }))
                .unwrap(),
            );
            desk.outcomes.result = Some(
                serde_json::from_value(serde_json::json!({
                    "total": 1, "page": 1, "pageSize": 25, "timezone": "Europe/Madrid",
                    "rows": [{
                        "startsAt": "2026-11-18T15:00:00.000000Z",
                        "client": "Fixture client", "staff": "Ada", "services": ["Cut"]
                    }],
                }))
                .unwrap(),
            );
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("outcomes-table").is_some());
        root.update(cx, |root, cx| {
            root.select_report_mode(ReportMode::Outcome(Outcome::NoShow), cx);
            let Overlay::Reports(desk) = &root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.outcomes.result.is_none());
            let (query, status) = desk.outcome_query().unwrap();
            assert_eq!(query.currency.as_deref(), Some("EUR"));
            assert_eq!(status, Outcome::NoShow);
        });
    }
}
