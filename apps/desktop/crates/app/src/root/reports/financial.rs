use super::*;
use sob_core::reports::financial::CURRENCY;

impl Root {
    pub(super) fn render_financial_report(
        &self,
        desk: &Desk,
        report: &FinancialReport,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let amount = |value| self.amount_label(value, CURRENCY);
        let timezone = report.timezone.parse::<Tz>().unwrap_or(self.tz);
        let date_time = |at: DateTime<Utc>| {
            let local = at.with_timezone(&timezone);
            format!(
                "{} {}",
                i18n::date_label(self.locale, local.date_naive()),
                local.format("%H:%M %:z")
            )
        };
        let lines = report.unknown_cost_lines.to_string();
        let pages = report.cash_sessions.len().div_ceil(PAGE_SIZE).max(1);
        let page = desk.page.min(pages - 1);
        div()
            .id("financial-report")
            .debug_selector(|| "financial-report".to_string())
            .flex()
            .flex_col()
            .gap_3()
            .when_some(report.client.as_ref(), |view, client| {
                view.child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(client.name.clone()),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .child(format!(
                        "{} – {}",
                        i18n::date_label(self.locale, report.from),
                        i18n::date_label(self.locale, report.to),
                    ))
                    .when(
                        !desk.export_pending && desk.request.is_none() && desk.error.is_none(),
                        |row| {
                            row.child(self.button(
                                "financial-export",
                                self.t(Key::ReportExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.save_report(cx)),
                            ))
                        },
                    ),
            )
            .when_some(desk.export_notice, |view, notice| {
                view.child(self.t(notice))
            })
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::FinancialReportBasis)),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(report.metrics().map(|(_, label, cents)| {
                        div()
                            .flex_1()
                            .min_w(px(180.))
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .p_3()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(label)),
                            )
                            .child(
                                div()
                                    .mt_1()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(amount(cents)),
                            )
                    })),
            )
            .child(div().text_sm().text_color(theme::muted()).child(i18n::fill(
                self.t(Key::FinancialUnknownCost),
                &[("n", &lines)],
            )))
            .when_some(report.settled_by_family.as_ref(), |view, rows| {
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::FinancialFamilies)),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::FinancialFamiliesBasis)),
                )
                .when(rows.is_empty(), |view| {
                    view.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::FinancialFamiliesEmpty)),
                    )
                })
                .children(rows.iter().map(|row| {
                    self.financial_row(
                        self.t(row.family.descriptor().1),
                        [
                            (Key::FinancialFamilyAmount, amount(row.amount_cents)),
                            (Key::FinancialTax, amount(row.tax_cents)),
                        ],
                    )
                }))
            })
            .when(!report.methods.is_empty(), |view| {
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::FinancialMethods)),
                )
                .children(report.methods.iter().map(|method| {
                    let label = super::super::transactions::METHODS
                        .iter()
                        .find(|(name, _)| *name == Some(method.method.as_str()))
                        .map_or(method.method.as_str(), |(_, key)| self.t(*key));
                    self.financial_row(
                        label,
                        [
                            (Key::FinancialTenderApplied, amount(method.collected_cents)),
                            (Key::FinancialTenderReturned, amount(method.refunded_cents)),
                        ],
                    )
                }))
            })
            .when(report.client.is_none(), |view| {
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::FinancialCashHistory)),
                )
            })
            .when(
                report.client.is_none() && report.cash_sessions.is_empty(),
                |view| {
                    let label = if desk
                        .submitted
                        .as_ref()
                        .is_some_and(|query| query.staff_id.is_some())
                    {
                        Key::FinancialCashUnfiltered
                    } else {
                        Key::FinancialNoSessions
                    };
                    view.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(label)),
                    )
                },
            )
            .children(
                report
                    .cash_sessions
                    .iter()
                    .skip(page * PAGE_SIZE)
                    .take(PAGE_SIZE)
                    .map(|session| {
                        let optional =
                            |value: Option<i64>| value.map(amount).unwrap_or_else(|| "—".into());
                        self.financial_row(
                            &date_time(session.opened_at),
                            [
                                (
                                    Key::CashClosed,
                                    session
                                        .closed_at
                                        .map(date_time)
                                        .unwrap_or_else(|| "—".into()),
                                ),
                                (Key::CashOpening, amount(session.opening_cents)),
                                (Key::CashExpected, optional(session.expected_cents)),
                                (Key::CashCounted, optional(session.counted_cents)),
                                (Key::CashDifference, optional(session.difference_cents)),
                            ],
                        )
                    }),
            )
            .when(pages > 1, |view| {
                view.child(self.render_report_pager(page, pages, cx))
            })
    }

    fn financial_row<const N: usize>(
        &self,
        heading: &str,
        values: [(Key, String); N],
    ) -> gpui::Div {
        div()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(heading.to_owned()),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_3()
                    .children(values.map(|(key, value)| {
                        div()
                            .text_sm()
                            .child(div().text_color(theme::muted()).child(self.t(key)))
                            .child(value)
                    })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn the_financial_report_saves_the_selected_period_and_signed_amounts(
        cx: &mut TestAppContext,
    ) {
        let (dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(650.), px(450.)));
        root.update(cx, |root, cx| {
            root.open_reports(cx);
            root.select_report_mode(ReportMode::Financial, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Overview);
            desk.can_view_financial_reports = true;
            desk.submitted.as_mut().unwrap().staff_id = Some("staff-filter".into());
            let query = desk.submitted.as_ref().unwrap().clone();
            root.select_report_mode(ReportMode::Financial, cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            assert!(desk.mode == ReportMode::Financial);
            assert!(desk.submitted.as_ref() == Some(&query));
            desk.request = None;
            desk.error = None;
            desk.financial_report = Some(serde_json::from_value(serde_json::json!({
                "from": query.from,
                "to": query.to,
                "timezone": "Europe/Madrid",
                "collectedCents": 1000,
                "refundedCents": 1300,
                "netCollectedCents": -300,
                "soldCents": 1000,
                "includedTaxCents": 173,
                "tipsCents": 0,
                "productCostCents": 500,
                "unknownCostLines": 1,
                "settledByFamily": [
                    { "family": "product", "amountCents": 900, "taxCents": 156 },
                    { "family": "unallocated", "amountCents": 100, "taxCents": 17 }
                ],
                "methods": [{ "method": "cash", "collectedCents": 1000, "refundedCents": 1300 }],
                "cashSessions": [],
            })).unwrap());
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("financial-report").is_some());
        let output = dir.path().join("financial.csv");
        root.update(cx, |root, cx| root.save_report(cx));
        cx.simulate_new_path_selection(|_| Some(output.clone()));
        cx.run_until_parked();
        let csv = std::fs::read_to_string(&output).unwrap();
        assert!(csv.contains("\"net_collections\",\"-300\",\"EUR\""));
        assert!(csv.contains("\"cash\",\"1000\",\"1300\",\"EUR\""));
        assert!(csv.contains("\"cash_session_id\""));
        assert!(csv.contains(
            "\"sale_family\",\"settled_amount_cents\",\"included_tax_cents\",\"currency\""
        ));
        assert!(csv.contains("\"product\",\"900\",\"156\",\"EUR\""));
        assert!(csv.contains("\"unallocated\",\"100\",\"17\",\"EUR\""));

        let revoked = dir.path().join("revoked.csv");
        root.update(cx, |root, cx| {
            root.save_report(cx);
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            desk.can_view_financial_reports = false;
        });
        cx.simulate_new_path_selection(|_| Some(revoked.clone()));
        cx.run_until_parked();
        assert!(!revoked.exists());
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::Reports(desk)
                if desk.export_notice == Some(Key::ReportExportChanged)));
        });

        root.update(cx, |root, cx| {
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("missing reports overlay");
            };
            desk.from.update(cx, |field, cx| field.set_text("", cx));
            root.report_staff("new-selection".into(), cx);
            let Overlay::Reports(desk) = &root.overlay else {
                panic!("missing reports overlay");
            };
            assert_eq!(desk.error, Some(Key::ReportRange));
            assert!(desk.financial_report.is_none());
            assert!(desk.request.is_none());
        });
    }
}
