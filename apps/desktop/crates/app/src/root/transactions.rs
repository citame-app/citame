use super::*;
use checkout::CheckoutReview;
use sob_core::billing::{
    CheckoutGroupTotal, CheckoutHistoryFilters, CheckoutHistoryGroup, CheckoutPage,
};
use uuid::Uuid;

pub(super) struct History {
    search: Entity<TextField>,
    from: Entity<TextField>,
    to: Entity<TextField>,
    _search_events: Vec<Subscription>,
    submitted: HistorySubmission,
    status: Option<&'static str>,
    method: Option<&'static str>,
    filters_open: bool,
    invalid_dates: bool,
    group: CheckoutHistoryGroup,
    loaded_group: Option<CheckoutHistoryGroup>,
    pub(super) page: u32,
    results: Result<Option<CheckoutPage>, ()>,
    request: Option<Arc<()>>,
    observation: Option<HistoryObservation>,
    needs_refresh: bool,
    refresh_failed: bool,
    pub(super) receipt: Option<CheckoutReview>,
}

#[derive(Default)]
struct HistorySubmission {
    search: String,
    status: Option<&'static str>,
    method: Option<&'static str>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

#[derive(Clone, Copy, PartialEq)]
struct HistoryObservation {
    timezone: Tz,
    revision: Option<i64>,
}

pub(super) enum HistoryLoad {
    ApplyFilters,
    Page(u32),
    Refresh,
}

const STATUSES: [(Option<&str>, Key); 6] = [
    (None, Key::SalesAllStatuses),
    (Some("open"), Key::SalesStatusOpen),
    (Some("paid"), Key::SalesStatusPaid),
    (Some("void"), Key::SalesStatusVoid),
    (Some("refunded"), Key::SalesStatusRefunded),
    (
        Some("partially_refunded"),
        Key::SalesStatusPartiallyRefunded,
    ),
];
pub(super) const METHODS: [(Option<&str>, Key); 8] = [
    (None, Key::SalesAllMethods),
    (Some("cash"), Key::CheckoutCash),
    (Some("external_card"), Key::CheckoutExternalCard),
    (Some("redsys_card"), Key::SalesBankCard),
    (Some("redsys_bizum"), Key::SalesBizum),
    (Some("gift_card"), Key::SalesGiftCard),
    (Some("package"), Key::SalesPackage),
    (Some("membership"), Key::SalesMembership),
];

fn read_date(field: &Entity<TextField>, cx: &App) -> Option<Option<NaiveDate>> {
    let text = field.read(cx).text().trim();
    if text.is_empty() {
        return Some(None);
    }
    reports::parse_report_date(text).map(Some)
}

impl Root {
    pub(super) fn open_sales_history(&mut self, cx: &mut Context<Self>) {
        let search = cx.new(|cx| TextField::new(self.t(Key::SalesSearch), false, cx));
        let from = cx.new(|cx| TextField::new("AAAA-MM-DD", false, cx));
        let to = cx.new(|cx| TextField::new("AAAA-MM-DD", false, cx));
        let events = [&search, &from, &to]
            .into_iter()
            .map(|field| {
                cx.subscribe(field, |root, _, event, cx| match event {
                    FieldEvent::Submit => root.load_sales_history(HistoryLoad::ApplyFilters, cx),
                    FieldEvent::Changed => cx.notify(),
                    _ => {}
                })
            })
            .collect();
        self.overlay = Overlay::SalesHistory(Box::new(History {
            search,
            from,
            to,
            _search_events: events,
            submitted: HistorySubmission::default(),
            status: None,
            method: None,
            filters_open: false,
            invalid_dates: false,
            group: CheckoutHistoryGroup::Day,
            loaded_group: None,
            page: 1,
            results: Ok(None),
            request: None,
            observation: None,
            needs_refresh: false,
            refresh_failed: false,
            receipt: None,
        }));
        self.load_sales_history(HistoryLoad::ApplyFilters, cx);
    }

    pub(super) fn refresh_sales_history(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::SalesHistory(history) = &mut self.overlay else {
            return;
        };
        history.needs_refresh |= reconnected;
        if self.status.connectivity != Connectivity::Online
            || history.receipt.is_some()
            || history.request.is_some()
            || history.invalid_dates
        {
            return;
        }
        let observation = HistoryObservation {
            timezone: self.tz,
            revision: self.svc.store.live_view_revision("commerce").ok(),
        };
        if history.needs_refresh
            || history
                .observation
                .is_some_and(|before| before != observation)
        {
            self.load_sales_history(HistoryLoad::Refresh, cx);
        }
    }

    pub(super) fn load_sales_history(&mut self, load: HistoryLoad, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::SalesHistory(history) = &mut self.overlay else {
            return;
        };
        if matches!(load, HistoryLoad::ApplyFilters) {
            let dates = read_date(&history.from, cx).zip(read_date(&history.to, cx));
            let Some((from, to)) = dates.filter(|(from, to)| {
                !from.zip(*to).is_some_and(|(from, to)| {
                    from > to
                        || calendar::local_day_range(self.tz, from).0
                            >= calendar::local_day_range(self.tz, to).1
                })
            }) else {
                history.invalid_dates = true;
                history.request = None;
                cx.notify();
                return;
            };
            history.invalid_dates = false;
            history.submitted = HistorySubmission {
                search: history.search.read(cx).text().trim().into(),
                status: history.status,
                method: history.method,
                from,
                to,
            };
        }
        let group = history.group;
        let filters = CheckoutHistoryFilters {
            search: history.submitted.search.clone(),
            status: history.submitted.status,
            method: history.submitted.method,
            from: history
                .submitted
                .from
                .map(|date| calendar::local_day_range(self.tz, date).0),
            to: history
                .submitted
                .to
                .map(|date| calendar::local_day_range(self.tz, date).1),
            group_by: Some(group),
        };
        if filters
            .from
            .zip(filters.to)
            .is_some_and(|(from, to)| from >= to)
        {
            history.invalid_dates = true;
            cx.notify();
            return;
        }
        let page = match load {
            HistoryLoad::ApplyFilters => 1,
            HistoryLoad::Page(page) => page,
            HistoryLoad::Refresh => history.page,
        };
        if !matches!(load, HistoryLoad::Refresh) {
            history.results = Ok(None);
            history.refresh_failed = false;
        }
        history.needs_refresh = false;
        let request = Arc::new(());
        history.request = Some(request.clone());
        history.observation = Some(HistoryObservation {
            timezone: self.tz,
            revision: self.svc.store.live_view_revision("commerce").ok(),
        });
        history.page = page;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.checkout_history(&filters, page) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::SalesHistory(history) = &mut root.overlay else {
                    return;
                };
                if !history
                    .request
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    return;
                }
                history.request = None;
                match result {
                    Ok(receipts) => {
                        history.results = Ok(Some(receipts));
                        history.loaded_group = Some(group);
                        history.refresh_failed = false;
                    }
                    Err(_)
                        if matches!(load, HistoryLoad::Refresh)
                            && matches!(history.results, Ok(Some(_))) =>
                    {
                        history.refresh_failed = true;
                    }
                    Err(_) => history.results = Err(()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_history_receipt(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::SalesHistory(history) = &mut self.overlay else {
            return;
        };
        let token = Arc::new(());
        history.receipt = Some(CheckoutReview::Loading(token.clone()));
        let revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx.background_executor().spawn(async move { transport.open_saved_checkout(id) }).await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) { return; }
                let Overlay::SalesHistory(history) = &mut root.overlay else { return };
                if !matches!(&history.receipt, Some(CheckoutReview::Loading(current)) if Arc::ptr_eq(current, &token)) { return; }
                history.receipt = Some(match result {
                    Ok(receipt) => CheckoutReview::from_receipt(receipt, revision, cx),
                    Err(_) => CheckoutReview::Failed,
                });
                cx.notify();
            });
        }).detach();
    }

    fn render_sales_filters(&self, history: &History, cx: &mut Context<Self>) -> gpui::Div {
        let options =
            |items: &[(Option<&'static str>, Key)], status: bool, cx: &mut Context<Self>| {
                let selected = if status {
                    history.status
                } else {
                    history.method
                };
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(items.iter().enumerate().map(|(i, &(value, label))| {
                        self.button(
                            (
                                if status {
                                    "sales-status"
                                } else {
                                    "sales-method"
                                },
                                i,
                            ),
                            self.t(label),
                            if selected == value {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::SalesHistory(history) = &mut root.overlay {
                                    if status {
                                        history.status = value;
                                    } else {
                                        history.method = value;
                                    }
                                    cx.notify();
                                }
                            }),
                        )
                    }))
            };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .child(self.label(Key::SalesFrom))
                            .child(history.from.clone()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .child(self.label(Key::SalesTo))
                            .child(history.to.clone()),
                    ),
            )
            .child(options(&STATUSES, true, cx))
            .child(options(&METHODS, false, cx))
    }

    fn render_sales_grouping(&self, history: &History, cx: &mut Context<Self>) -> gpui::Div {
        div().flex().gap_2().children(
            [
                (CheckoutHistoryGroup::Day, Key::SalesByDay),
                (CheckoutHistoryGroup::Month, Key::SalesByMonth),
            ]
            .into_iter()
            .map(|(group, key)| {
                let id = match group {
                    CheckoutHistoryGroup::Day => "sales-days",
                    CheckoutHistoryGroup::Month => "sales-months",
                };
                self.button(
                    id,
                    self.t(key),
                    if history.group == group {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(move |root, _, _, cx| {
                        let Overlay::SalesHistory(history) = &mut root.overlay else {
                            return;
                        };
                        if history.group != group {
                            history.group = group;
                            if root.status.connectivity == Connectivity::Online {
                                root.load_sales_history(HistoryLoad::Refresh, cx);
                            } else {
                                history.needs_refresh = true;
                                cx.notify();
                            }
                        }
                    }),
                )
                .debug_selector(move || id.to_owned())
            }),
        )
    }

    fn render_sales_totals(&self, totals: &CheckoutGroupTotal, currency: &str) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .text_xs()
            .text_color(theme::muted())
            .children(
                [
                    (Key::SalesReceipts, totals.receipts.to_string()),
                    (
                        Key::SalesRecordedPayments,
                        self.amount_label(totals.paid_cents, currency),
                    ),
                    (
                        Key::SalesRefunds,
                        self.amount_label(totals.refunded_cents, currency),
                    ),
                    (
                        Key::SalesNetPayments,
                        self.amount_label(totals.paid_cents - totals.refunded_cents, currency),
                    ),
                ]
                .into_iter()
                .map(|(label, value)| div().child(format!("{} · {value}", self.t(label)))),
            )
    }

    pub(super) fn render_sales_history(
        &self,
        history: &History,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(receipt) = &history.receipt {
            return self.render_checkout(receipt, cx);
        }
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::SalesHistory)),
            )
            .child(self.render_sales_grouping(history, cx))
            .child(history.search.clone())
            .child(self.button(
                "toggle-sales-filters",
                self.t(Key::SalesFilters),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    if let Overlay::SalesHistory(history) = &mut root.overlay {
                        history.filters_open = !history.filters_open;
                        cx.notify();
                    }
                }),
            ))
            .when(history.filters_open, |view| {
                view.child(
                    div()
                        .id("sales-filter-fields")
                        .max_h((viewport.height * 0.33).max(px(110.)))
                        .overflow_y_scroll()
                        .child(self.render_sales_filters(history, cx)),
                )
            })
            .when(history.invalid_dates, |view| {
                view.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::SalesInvalidDates)),
                )
            })
            .when(online, |view| {
                view.child(self.button(
                    "search-sales",
                    self.t(Key::SaleSearch),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        root.load_sales_history(HistoryLoad::ApplyFilters, cx)
                    }),
                ))
            })
            .when(!online, |view| view.child(self.t(Key::CheckoutOffline)));
        let body = body.when(history.refresh_failed, |view| {
            view.child(self.label(Key::SalesRefreshFailed))
                .when(online, |view| {
                    view.child(self.button(
                        "reload-sales",
                        self.t(Key::SalesReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.load_sales_history(HistoryLoad::Refresh, cx)
                        }),
                    ))
                })
        });

        let timezone = history
            .results
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .and_then(|page| page.group_totals.as_ref())
            .and_then(|group| group.timezone.parse().ok())
            .unwrap_or(self.tz);
        let period_of = |instant: DateTime<Utc>| {
            let day = instant.with_timezone(&timezone).date_naive();
            if history.group == CheckoutHistoryGroup::Month {
                day.with_day(1).unwrap_or(day)
            } else {
                day
            }
        };
        let body = if history.request.is_some() && matches!(history.results, Ok(None)) {
            body.child(self.t(Key::CheckoutLoading))
        } else {
            match &history.results {
                Err(()) => body.child(self.t(Key::CheckoutUnavailable)),
                Ok(Some(page)) => {
                    let mut rows: Vec<_> = page
                        .checkouts
                        .iter()
                        .map(|row| (period_of(row.created_at), row))
                        .collect();
                    rows.sort_by_key(|(period, _)| std::cmp::Reverse(*period));
                    let totals = (history.loaded_group == Some(history.group))
                        .then_some(page.group_totals.as_ref())
                        .flatten();
                    body.when(page.checkouts.is_empty(), |view| {
                        view.child(self.t(Key::SalesNoResults))
                    })
                    .when(!rows.is_empty() && totals.is_some(), |body| {
                        body.child(self.label(Key::SalesTotalsHelp))
                    })
                    .child(
                        div()
                            .id("sales-history-rows")
                            .debug_selector(|| "sales-history-rows".to_owned())
                            .max_h(
                                (viewport.height
                                    - px(if history.filters_open { 520. } else { 330. }))
                                .max(px(90.)),
                            )
                            .overflow_y_scroll()
                            .child(div().flex().flex_col().gap_2().children(
                                rows.iter().enumerate().map(|(index, &(period, row))| {
                                    let previous =
                                        index.checked_sub(1).map(|previous| rows[previous].0);
                                    let group = (previous != Some(period)).then(|| {
                                        if history.group == CheckoutHistoryGroup::Month {
                                            period.format("%Y-%m").to_string()
                                        } else {
                                            i18n::date_label(self.locale, period)
                                        }
                                    });
                                    let period_totals = group.as_ref().and_then(|_| {
                                        totals?.rows.iter().find(|row| row.period == period)
                                    });
                                    let id = row.id;
                                    let title = row
                                        .lines
                                        .iter()
                                        .take(2)
                                        .map(|line| line.description.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ");
                                    let status =
                                        i18n::receipt_status_label(self.locale, &row.status);
                                    let detail = format!(
                                        "{} · {} · {}",
                                        self.date_time_label(row.created_at),
                                        status,
                                        self.amount_label(
                                            i64::from(row.total_cents),
                                            &row.currency
                                        )
                                    );
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_1()
                                        .border_b_1()
                                        .border_color(theme::line())
                                        .py_1()
                                        .when_some(group, |view, label| {
                                            view.child(
                                                div()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(label),
                                            )
                                        })
                                        .when_some(period_totals, |view, totals| {
                                            view.child(
                                                div()
                                                    .debug_selector(move || {
                                                        format!("sales-totals-{period}")
                                                    })
                                                    .child(self.render_sales_totals(
                                                        totals,
                                                        &row.currency,
                                                    )),
                                            )
                                        })
                                        .child(self.button(
                                            SharedString::from(format!("history-{id}")),
                                            title,
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.open_history_receipt(id, cx)
                                            }),
                                        ))
                                        .child(
                                            div()
                                                .text_sm()
                                                .text_color(theme::muted())
                                                .child(detail),
                                        )
                                }),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .when(online && history.page > 1, |view| {
                                let page = history.page - 1;
                                view.child(self.button(
                                    "sales-previous",
                                    "<",
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.load_sales_history(HistoryLoad::Page(page), cx)
                                    }),
                                ))
                            })
                            .when(
                                online
                                    && page.total > u64::from(history.page) * 15
                                    && history.page < 100_000,
                                |view| {
                                    let page = history.page + 1;
                                    view.child(self.button(
                                        "sales-next",
                                        ">",
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.load_sales_history(HistoryLoad::Page(page), cx)
                                        }),
                                    ))
                                },
                            ),
                    )
                }
                Ok(None) => body,
            }
        };
        let body = body.child(self.button(
            "sales-back",
            self.t(Key::Back),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
        ));
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(240.)).min(px(620.)),
            (viewport.height - px(24.)).max(px(180.)),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn cached_receipts_can_change_group_offline_without_reusing_daily_totals(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(720.), px(820.)));
        let id = Uuid::new_v4();
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_sales_history(cx);
            let Overlay::SalesHistory(history) = &mut root.overlay else {
                panic!("missing transactions");
            };
            history.loaded_group = Some(CheckoutHistoryGroup::Day);
            history.results = Ok(Some(
                serde_json::from_value(serde_json::json!({
                    "total": 26,
                    "checkouts": [{
                        "id": id,
                        "createdAt": "2026-02-28T23:30:00Z",
                        "currency": "EUR",
                        "status": "paid",
                        "totalCents": 2000,
                        "lines": []
                    }],
                    "groupTotals": {
                        "timezone": "Europe/Madrid",
                        "rows": [{
                            "period": "2026-03-01",
                            "receipts": 26,
                            "paidCents": 52000,
                            "refundedCents": 1000
                        }]
                    }
                }))
                .unwrap(),
            ));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("sales-totals-2026-03-01").is_some());
        let months = cx.debug_bounds("sales-months").expect("months control");
        cx.simulate_click(months.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let Overlay::SalesHistory(history) = &root.overlay else {
                panic!("missing transactions");
            };
            assert_eq!(history.group, CheckoutHistoryGroup::Month);
            assert!(history.needs_refresh);
            assert_eq!(history.loaded_group, Some(CheckoutHistoryGroup::Day));
            assert!(matches!(history.results, Ok(Some(ref page)) if page.checkouts[0].id == id));
        });
        let days = cx.debug_bounds("sales-days").expect("days control");
        cx.simulate_click(days.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::SalesHistory(history) if history.group == CheckoutHistoryGroup::Day));
        });
        assert!(cx.debug_bounds("sales-totals-2026-03-01").is_some());
    }
}
