use super::*;
use sob_core::reports::{
    commissions::{CommissionPage, CommissionStatement},
    financial::CURRENCY,
};
use sob_core::sync::TransportError;

const REFRESH: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct Desk {
    instance: Arc<()>,
    selected: Option<String>,
    page: u32,
    payout_page: u32,
    can_choose_staff: bool,
    viewer_known: bool,
    statement: Option<CommissionStatement>,
    request: Option<Arc<()>>,
    cursor: i64,
    refresh_at: Option<Instant>,
    error: Option<Key>,
    exporting: bool,
    export_notice: Option<Key>,
}

#[derive(Clone, Copy)]
enum Section {
    Accruals,
    Payouts,
}

impl Root {
    pub(super) fn open_commissions(&mut self, cx: &mut Context<Self>) {
        self.overlay = Overlay::Commissions(Box::new(Desk {
            page: 1,
            payout_page: 1,
            ..Desk::default()
        }));
        self.load_commissions(self.status.cursor, cx);
    }

    pub(super) fn refresh_commissions(&mut self, status: &SyncStatus, cx: &mut Context<Self>) {
        if status.connectivity == Connectivity::Online
            && matches!(&self.overlay, Overlay::Commissions(desk)
            if desk.request.is_none() && (
                self.status.connectivity != Connectivity::Online
                || (desk.error.is_none() && desk.cursor != status.cursor)
                || desk.refresh_at.is_some_and(|at| Instant::now() >= at)
            ))
        {
            self.load_commissions(status.cursor, cx);
        }
    }

    fn load_commissions(&mut self, cursor: i64, cx: &mut Context<Self>) {
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            desk.error = Some(Key::ReportOffline);
            cx.notify();
            return;
        };
        let session = self.svc.session.clone();
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.error = None;
        desk.cursor = cursor;
        let selected = desk.selected.clone();
        let (page, payout_page) = (desk.page, desk.payout_page);
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let scope = transport.commission_scope()?;
                    let can_choose = scope.can_choose_staff;
                    let target = if can_choose {
                        selected.clone().or(scope.staff_id)
                    } else {
                        scope.staff_id
                    };
                    let (page, payout_page) = if target == selected {
                        (page, payout_page)
                    } else {
                        (1, 1)
                    };
                    let statement = target
                        .as_deref()
                        .map(|staff_id| transport.commission_statement(staff_id, page, payout_page))
                        .transpose()?;
                    Ok((can_choose, target, statement))
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Commissions(desk) = &mut root.overlay else {
                    return;
                };
                if !desk
                    .request
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &request))
                {
                    return;
                }
                desk.request = None;
                match result {
                    Ok((can_choose, target, statement)) => {
                        desk.can_choose_staff = can_choose;
                        desk.viewer_known = true;
                        desk.selected = target;
                        desk.page = statement.as_ref().map_or(1, |data| data.pagination.page);
                        desk.payout_page = statement
                            .as_ref()
                            .map_or(1, |data| data.payout_pagination.page);
                        desk.statement = statement;
                        desk.refresh_at = Some(Instant::now() + REFRESH);
                    }
                    Err(error) => {
                        desk.statement = None;
                        let (label, delay) = match error {
                            TransportError::Forbidden(_) | TransportError::Unauthorized => {
                                desk.can_choose_staff = false;
                                (Key::ReportRestricted, REFRESH)
                            }
                            TransportError::Offline(_) => (Key::ReportOffline, RETRY),
                            TransportError::RateLimited(delay) => {
                                (Key::ReportFailed, delay.unwrap_or(RETRY).max(RETRY))
                            }
                            _ => (Key::ReportFailed, RETRY),
                        };
                        desk.error = Some(label);
                        desk.refresh_at = Instant::now().checked_add(delay);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn select_commission_professional(&mut self, id: String, cx: &mut Context<Self>) {
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        if !desk.can_choose_staff || desk.selected.as_ref() == Some(&id) {
            return;
        }
        desk.selected = Some(id);
        desk.page = 1;
        desk.payout_page = 1;
        desk.statement = None;
        desk.export_notice = None;
        self.load_commissions(self.status.cursor, cx);
    }

    fn commission_page(&mut self, section: Section, page: u32, cx: &mut Context<Self>) {
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        match section {
            Section::Accruals => desk.page = page,
            Section::Payouts => desk.payout_page = page,
        }
        desk.statement = None;
        desk.export_notice = None;
        self.load_commissions(self.status.cursor, cx);
    }

    fn export_commissions(&mut self, cx: &mut Context<Self>) {
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        let Some(statement) = desk.statement.as_ref().filter(|s| !s.accruals.is_empty()) else {
            return;
        };
        if desk.exporting || desk.request.is_some() || desk.error.is_some() {
            return;
        }
        let staff_id = statement.staff_id.clone();
        let page = statement.pagination.page;
        let filename = format!("commissions-{staff_id}-page-{page}.csv");
        let csv = Arc::<str>::from(statement.accrual_csv());
        let expected_rows = csv.clone();
        let session = self.svc.session.clone();
        let instance = desk.instance.clone();
        let expected = instance.clone();
        desk.exporting = true;
        desk.export_notice = None;
        cx.notify();
        prompt_csv_export(
            &filename,
            move |root| {
                Arc::ptr_eq(&session, &root.svc.session)
                    && root.svc.status().connectivity != Connectivity::AuthRequired
                    && matches!(&root.overlay, Overlay::Commissions(current)
                        if Arc::ptr_eq(&expected, &current.instance)
                            && current.request.is_none() && current.error.is_none()
                            && current.statement.as_ref().is_some_and(|data|
                                data.staff_id == staff_id && data.pagination.page == page
                                    && data.accrual_csv() == expected_rows.as_ref()))
            },
            move |output| {
                use std::io::Write;
                output.write_all(csv.as_bytes())
            },
            move |root, notice, cx| {
                if let Overlay::Commissions(desk) = &mut root.overlay
                    && Arc::ptr_eq(&instance, &desk.instance)
                {
                    desk.exporting = false;
                    desk.export_notice = notice;
                    cx.notify();
                }
            },
            cx,
        );
    }

    pub(super) fn render_commissions(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::Commissions)),
                    )
                    .child(self.button(
                        "commissions-close",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            )
            .child(
                div()
                    .id("commissions-content")
                    .overflow_y_scroll()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .when(desk.can_choose_staff, |view| {
                        view.child(self.staff_chips(
                            &self.report_staff_options,
                            "commission-staff",
                            desk.selected.as_deref().unwrap_or_default(),
                            cx,
                            Self::select_commission_professional,
                        ))
                    })
                    .when(desk.request.is_none(), |view| {
                        view.child(self.button(
                            "commissions-refresh",
                            self.t(Key::CashRefresh),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                root.load_commissions(root.status.cursor, cx)
                            }),
                        ))
                    })
                    .when(desk.request.is_some(), |view| {
                        view.child(self.t(Key::ReportLoading))
                    })
                    .when_some(
                        desk.error
                            .or((self.status.connectivity != Connectivity::Online
                                && desk.request.is_none())
                            .then_some(Key::ReportOffline)),
                        |view, error| {
                            view.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
                        },
                    )
                    .when(
                        desk.viewer_known
                            && desk.statement.is_none()
                            && desk.request.is_none()
                            && desk.error.is_none(),
                        |view| {
                            view.child(self.t(if desk.can_choose_staff {
                                Key::CommissionChooseStaff
                            } else {
                                Key::CommissionNoProfile
                            }))
                        },
                    )
                    .when_some(desk.statement.as_ref(), |view, statement| {
                        view.child(self.render_commission_statement(desk, statement, cx))
                    }),
            );
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).clamp(px(280.), px(820.)),
            (viewport.height - px(32.)).clamp(px(200.), px(760.)),
            Some(cx),
        )
    }

    fn render_commission_statement(
        &self,
        desk: &Desk,
        statement: &CommissionStatement,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let money = |amount| self.amount_label(amount, CURRENCY);
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (Key::CommissionEarned, statement.earned_cents),
                        (Key::CommissionPaid, statement.paid_cents),
                        (Key::CommissionBalance, statement.outstanding_cents),
                    ]
                    .map(|(label, amount)| {
                        div()
                            .flex_1()
                            .min_w(px(145.))
                            .p_3()
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(label)),
                            )
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(money(amount)))
                    }),
                ),
            )
            .when(statement.outstanding_cents < 0, |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::CommissionNegative)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::CommissionAccruals)),
                    )
                    .when(
                        !statement.accruals.is_empty() && !desk.exporting && desk.request.is_none(),
                        |view| {
                            view.child(self.button(
                                "commissions-export",
                                self.t(Key::CommissionExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.export_commissions(cx)),
                            ))
                        },
                    ),
            )
            .when_some(desk.export_notice, |view, notice| {
                view.child(self.t(notice))
            })
            .when(statement.accruals.is_empty(), |view| {
                view.child(self.t(Key::CommissionEmpty))
            })
            .children(statement.accruals.iter().map(|row| {
                let rate = format!(
                    "{}.{:02}%",
                    row.rate_basis_points / 100,
                    row.rate_basis_points % 100
                );
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::line())
                    .p_3()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(row.description.clone()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(format!("{} · {rate}", self.date_time_label(row.created_at))),
                    )
                    .child(div().text_sm().child(format!(
                        "{} {}",
                        self.t(Key::CommissionOriginal),
                        money(row.original_cents)
                    )))
                    .child(div().text_sm().child(format!(
                        "{} {}",
                        self.t(Key::CommissionAdjusted),
                        money(row.adjusted_cents)
                    )))
            }))
            .child(self.commission_pager(
                Section::Accruals,
                &statement.pagination,
                desk.request.is_some(),
                cx,
            ))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::CommissionPayouts)),
            )
            .when(statement.payouts.is_empty(), |view| {
                view.child(self.t(Key::CommissionNoPayouts))
            })
            .children(statement.payouts.iter().map(|row| {
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::line())
                    .p_3()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(row.reference.clone()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.date_time_label(row.created_at)),
                    )
                    .child(div().text_sm().child(money(row.amount_cents)))
            }))
            .child(self.commission_pager(
                Section::Payouts,
                &statement.payout_pagination,
                desk.request.is_some(),
                cx,
            ))
    }

    fn commission_pager(
        &self,
        section: Section,
        pagination: &CommissionPage,
        loading: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let page = pagination.page;
        let prefix = match section {
            Section::Accruals => "commission-accruals",
            Section::Payouts => "commission-payouts",
        };
        div().flex().items_center().justify_end().gap_2().when(
            page > 1 || pagination.has_next(),
            |view| {
                view.when(page > 1 && !loading, |view| {
                    view.child(self.button(
                        (prefix, 0_usize),
                        self.t(Key::InboxPrevious),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.commission_page(section, page - 1, cx)
                        }),
                    ))
                })
                .child(div().text_sm().child(i18n::fill(
                    self.t(Key::CommissionPage),
                    &[("n", &page.to_string())],
                )))
                .when(pagination.has_next() && !loading, |view| {
                    view.child(self.button(
                        (prefix, 1_usize),
                        self.t(Key::InboxNext),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.commission_page(section, page + 1, cx)
                        }),
                    ))
                })
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn exports_only_the_current_commission_page_and_cancels_after_switching_professional(
        cx: &mut TestAppContext,
    ) {
        let (dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.open_commissions(cx);
            let Overlay::Commissions(desk) = &mut root.overlay else {
                panic!("missing commissions");
            };
            desk.request = None;
            desk.error = None;
            desk.can_choose_staff = true;
            desk.selected = Some("first".into());
            desk.statement = Some(
                serde_json::from_value(serde_json::json!({
                    "staffId": "first",
                    "earnedCents": 100,
                    "paidCents": 200,
                    "outstandingCents": -100,
                    "pagination": { "page": 2, "pageSize": 20, "total": 50 },
                    "payoutPagination": { "page": 1, "pageSize": 20, "total": 1 },
                    "accruals": [{
                        "checkoutId": "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
                        "description": "  =service, \"name\"",
                        "kind": "service",
                        "basisCents": 2000,
                        "rateBasisPoints": 1500,
                        "originalCents": 300,
                        "adjustedCents": 100,
                        "createdAt": "2026-11-21T08:00:00.000Z"
                    }],
                    "payouts": [{
                        "amountCents": 200,
                        "reference": "External payout #1",
                        "createdAt": "2026-11-21T09:00:00.000Z"
                    }]
                }))
                .unwrap(),
            );
            cx.notify();
        });
        cx.run_until_parked();
        let output = dir.path().join("commissions.csv");
        root.update(cx, |root, cx| root.export_commissions(cx));
        cx.simulate_new_path_selection(|_| Some(output.clone()));
        cx.run_until_parked();
        let csv = std::fs::read_to_string(output).unwrap();
        assert!(csv.contains("\"'  =service, \"\"name\"\"\""));
        assert!(csv.contains("\"2000\",\"1500\",\"300\",\"100\",\"EUR\""));
        assert!(!csv.contains("External payout"));

        let refreshed = dir.path().join("refunded.csv");
        root.update(cx, |root, cx| {
            root.export_commissions(cx);
            let Overlay::Commissions(desk) = &mut root.overlay else {
                panic!("missing commissions");
            };
            desk.statement.as_mut().unwrap().accruals[0].adjusted_cents = 50;
        });
        cx.simulate_new_path_selection(|_| Some(refreshed.clone()));
        cx.run_until_parked();
        assert!(!refreshed.exists());

        let changed = dir.path().join("stale.csv");
        root.update(cx, |root, cx| {
            root.export_commissions(cx);
            root.select_commission_professional("second".into(), cx);
            let Overlay::Commissions(desk) = &root.overlay else {
                panic!("missing commissions");
            };
            assert_eq!((desk.page, desk.payout_page), (1, 1));
            assert!(desk.statement.is_none());
        });
        cx.simulate_new_path_selection(|_| Some(changed.clone()));
        cx.run_until_parked();
        assert!(!changed.exists());
    }
}
