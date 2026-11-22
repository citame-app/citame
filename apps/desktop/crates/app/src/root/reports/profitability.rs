use super::*;
use sob_core::billing::parse_reviewed_amount;
use sob_core::reports::financial::{
    AppointmentMargin, CURRENCY, MarginReview, ReviewAppointmentCosts,
};
use uuid::Uuid;

pub(super) struct CostDraft {
    appointment_id: Uuid,
    version: Option<u32>,
    generation: String,
    labour: Entity<TextField>,
    materials: Entity<TextField>,
    pending: bool,
    error: Option<Key>,
}

fn optional_amount(value: &str) -> Option<Option<u32>> {
    if value.trim().is_empty() {
        Some(None)
    } else {
        parse_reviewed_amount(value).map(Some)
    }
}

impl Root {
    fn profitability_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &mut self.overlay
            && desk.mode == ReportMode::Profitability
            && desk.profitability_draft.is_none()
        {
            desk.page = page;
            self.load_report(self.status.cursor, cx);
        }
    }

    fn open_cost_draft(&mut self, appointment_id: Uuid, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        let Some(report) = &desk.profitability_report else {
            return;
        };
        let Some(row) = report
            .rows
            .iter()
            .find(|row| row.appointment_id == appointment_id)
        else {
            return;
        };
        if desk.profitability_draft.is_some() {
            return;
        }
        let field = |value: Option<u32>, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut input = TextField::new("0.00", false, cx);
                if let Some(value) = value {
                    input.set_text(&decimal_amount(u64::from(value)), cx);
                }
                input
            })
        };
        let costs = row.direct_costs.as_ref();
        desk.profitability_draft = Some(CostDraft {
            appointment_id,
            version: costs.map(|cost| cost.version),
            generation: report.generation.clone(),
            labour: field(costs.and_then(|cost| cost.labour_cents), cx),
            materials: field(costs.and_then(|cost| cost.materials_cents), cx),
            pending: false,
            error: None,
        });
        cx.notify();
    }

    fn save_cost_draft(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        if desk.mode != ReportMode::Profitability || desk.request.is_some() || desk.error.is_some()
        {
            return;
        }
        let Some(draft) = &mut desk.profitability_draft else {
            return;
        };
        if draft.pending {
            return;
        }
        let Some(report) = desk.profitability_report.as_ref() else {
            return;
        };
        let Some(row) = report
            .rows
            .iter()
            .find(|row| row.appointment_id == draft.appointment_id)
        else {
            return;
        };
        if row.direct_costs.as_ref().map(|cost| cost.version) != draft.version
            || report.generation != draft.generation
        {
            return;
        }
        let Some((labour_cents, materials_cents)) = optional_amount(draft.labour.read(cx).text())
            .zip(optional_amount(draft.materials.read(cx).text()))
        else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            draft.error = Some(Key::ReportOffline);
            cx.notify();
            return;
        };
        let review = ReviewAppointmentCosts {
            labour_cents,
            materials_cents,
            version: draft.version,
            generation: draft.generation.clone(),
        };
        let session = self.svc.session.clone();
        let instance = desk.instance.clone();
        let appointment_id = draft.appointment_id;
        draft.pending = true;
        draft.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.save_appointment_costs(appointment_id, &review) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Reports(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&instance, &desk.instance) || desk.mode != ReportMode::Profitability
                {
                    return;
                }
                let Some(draft) = &mut desk.profitability_draft else {
                    return;
                };
                if draft.appointment_id != appointment_id || !draft.pending {
                    return;
                }
                draft.pending = false;
                match result {
                    Ok(_) => desk.profitability_draft = None,
                    Err(TransportError::Offline(_)) => draft.error = Some(Key::ReportOffline),
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        desk.profitability_draft = None;
                        desk.profitability_report = None;
                        desk.can_view_profitability = false;
                    }
                    Err(_) => draft.error = Some(Key::ProfitabilityReloadCosts),
                }
                root.load_report(root.status.cursor, cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn export_appointment_profitability(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &self.overlay else {
            return;
        };
        let Some(query) = desk.submitted.clone() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let client = desk
            .client_sales
            .as_ref()
            .map(|scope| scope.client_id.clone());
        self.choose_report_export(
            format!("appointment-profitability-{}-{}.csv", query.from, query.to),
            move |output| {
                transport
                    .write_appointment_profitability_csv(&query, client.as_deref(), output)
                    .map_err(std::io::Error::other)
            },
            cx,
        );
    }

    pub(super) fn render_appointment_profitability(
        &self,
        desk: &Desk,
        report: &AppointmentProfitability,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let pages = report
            .pagination
            .total
            .div_ceil(report.pagination.page_size.max(1)) as usize;
        let page = report.pagination.page.saturating_sub(1) as usize;
        let zone = report.timezone.parse::<Tz>().unwrap_or(self.tz);
        div()
            .debug_selector(|| "appointment-profitability".to_owned())
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(self.button(
                        "profitability-back",
                        self.t(Key::FinancialReport),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.select_report_mode(ReportMode::Financial, cx)
                        }),
                    ))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::FinancialProfitability)),
                    )
                    .when(
                        report.pagination.total > 0
                            && desk.error.is_none()
                            && desk.request.is_none()
                            && !desk.export_pending,
                        |view| {
                            view.child(self.button(
                                "profitability-export",
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
                    .child(self.t(Key::ProfitabilityBasis)),
            )
            .when(report.rows.is_empty(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::ProfitabilityEmpty)),
                )
            })
            .when_some(desk.profitability_draft.as_ref(), |view, draft| {
                let row = report
                    .rows
                    .iter()
                    .find(|row| row.appointment_id == draft.appointment_id);
                view.child(self.render_cost_draft(
                    draft,
                    row,
                    &report.generation,
                    desk.request.is_none() && desk.error.is_none(),
                    zone,
                    cx,
                ))
            })
            .children(report.rows.iter().enumerate().map(|(index, row)| {
                let direct = row.direct_costs.as_ref();
                let amount = |cents: Option<i64>| {
                    cents.map_or_else(
                        || "—".to_owned(),
                        |value| self.amount_label(value, CURRENCY),
                    )
                };
                let product_cost = self.amount_label(row.product_cost_cents, CURRENCY);
                let products = if row.unknown_product_lines > 0 {
                    i18n::fill(
                        self.t(Key::ProfitabilityProductCostPending),
                        &[
                            ("amount", &product_cost),
                            ("count", &row.unknown_product_lines.to_string()),
                        ],
                    )
                } else {
                    product_cost
                };
                let margin = match row.review_reason {
                    Some(MarginReview::MissingCosts) => {
                        self.t(Key::ProfitabilityMissingCosts).to_owned()
                    }
                    Some(MarginReview::RefundReview) => {
                        self.t(Key::ProfitabilityRefundReview).to_owned()
                    }
                    Some(MarginReview::UnallocatedReceipt) => {
                        self.t(Key::ProfitabilityAllocationReview).to_owned()
                    }
                    None => amount(row.margin_cents),
                };
                self.financial_row(
                    &self.appointment_margin_title(row, zone),
                    [
                        (Key::ProfitabilityNetSales, amount(row.net_sales_cents)),
                        (Key::FinancialCost, products),
                        (
                            Key::ProfitabilityCommission,
                            amount(Some(row.commission_cents)),
                        ),
                        (
                            Key::ProfitabilityLabour,
                            amount(direct.and_then(|cost| cost.labour_cents).map(i64::from)),
                        ),
                        (
                            Key::ProfitabilityMaterials,
                            amount(direct.and_then(|cost| cost.materials_cents).map(i64::from)),
                        ),
                        (Key::ProfitabilityMargin, margin),
                    ],
                )
                .when(
                    desk.profitability_draft.is_none()
                        && desk.error.is_none()
                        && desk.request.is_none(),
                    |view| {
                        let id = row.appointment_id;
                        view.child(div().mt_2().child(self.button(
                            ("review-appointment-costs", index),
                            self.t(Key::ProfitabilityEdit),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.open_cost_draft(id, cx)),
                        )))
                    },
                )
            }))
            .when(
                (pages > 1 || page > 0) && desk.profitability_draft.is_none(),
                |view| {
                    view.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap_2()
                            .when(page > 0, |pager| {
                                pager.child(self.button(
                                    "profitability-previous",
                                    self.t(Key::InboxPrevious),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.profitability_page(page - 1, cx)
                                    }),
                                ))
                            })
                            .child(format!("{} / {}", page + 1, pages.max(1)))
                            .when(page + 1 < pages, |pager| {
                                pager.child(self.button(
                                    "profitability-next",
                                    self.t(Key::InboxNext),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.profitability_page(page + 1, cx)
                                    }),
                                ))
                            }),
                    )
                },
            )
    }

    fn appointment_margin_title(&self, row: &AppointmentMargin, zone: Tz) -> String {
        let local = row.starts_at.with_timezone(&zone);
        let date = i18n::date_label(self.locale, local.date_naive());
        let time = local.format("%H:%M");
        row.staff_name.as_ref().map_or_else(
            || format!("{date} {time}"),
            |name| format!("{date} {time} · {name}"),
        )
    }

    fn render_cost_draft(
        &self,
        draft: &CostDraft,
        row: Option<&AppointmentMargin>,
        latest_generation: &str,
        ready: bool,
        zone: Tz,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let latest = row.and_then(|row| row.direct_costs.as_ref());
        let version = latest.map(|cost| cost.version);
        let stale =
            row.is_some() && (version != draft.version || latest_generation != draft.generation);
        let latest_generation = latest_generation.to_owned();
        let valid = optional_amount(draft.labour.read(cx).text()).is_some()
            && optional_amount(draft.materials.read(cx).text()).is_some();
        let amount = |cents: Option<u32>| {
            cents.map_or_else(
                || "—".to_owned(),
                |value| self.amount_label(i64::from(value), CURRENCY),
            )
        };
        div()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(row, |view, row| {
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.appointment_margin_title(row, zone)),
                )
            })
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::ProfitabilityHelp)),
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (Key::ProfitabilityLabour, &draft.labour),
                        (Key::ProfitabilityMaterials, &draft.materials),
                    ]
                    .map(|(label, input)| {
                        div().w(px(165.)).child(self.t(label)).child(input.clone())
                    }),
                ),
            )
            .when(stale, |view| {
                view.child(i18n::fill(
                    self.t(Key::ProfitabilityChanged),
                    &[
                        ("labour", &amount(latest.and_then(|cost| cost.labour_cents))),
                        (
                            "materials",
                            &amount(latest.and_then(|cost| cost.materials_cents)),
                        ),
                    ],
                ))
                .when(!draft.pending, |view| {
                    view.child(self.button(
                        "profitability-review-revision",
                        self.t(Key::ProfitabilityUseRevision),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::Reports(desk) = &mut root.overlay
                                && let Some(draft) = &mut desk.profitability_draft
                            {
                                draft.version = version;
                                draft.generation = latest_generation.clone();
                                draft.error = None;
                                cx.notify();
                            }
                        }),
                    ))
                })
            })
            .when_some(draft.error, |view, key| {
                view.child(div().text_sm().child(self.t(key)))
            })
            .when(!draft.pending, |view| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(valid && !stale && ready && row.is_some(), |view| {
                            view.child(self.button(
                                "profitability-save-cost",
                                self.t(Key::ProfitabilitySave),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_cost_draft(cx)),
                            ))
                        })
                        .child(self.button(
                            "profitability-cancel-cost",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Reports(desk) = &mut root.overlay {
                                    desk.profitability_draft = None;
                                    cx.notify();
                                }
                            }),
                        )),
                )
            })
    }
}
