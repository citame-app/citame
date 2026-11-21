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
    submitted: CheckoutHistoryFilters,
    status: Option<&'static str>,
    method: Option<&'static str>,
    filters_open: bool,
    invalid_dates: bool,
    group_by_month: bool,
    pub(super) page: u32,
    results: Result<Option<CheckoutPage>, ()>,
    request: Option<Arc<()>>,
    observed_revision: Option<i64>,
    pub(super) receipt: Option<CheckoutReview>,
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

fn boundary(
    field: &Entity<TextField>,
    upper: bool,
    tz: Tz,
    cx: &App,
) -> Option<Option<DateTime<Utc>>> {
    let text = field.read(cx).text().trim();
    if text.is_empty() {
        return Some(None);
    }
    let date = reports::parse_report_date(text)?;
    let (start, end) = calendar::local_day_range(tz, date);
    Some(Some(if upper { end } else { start }))
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
            submitted: CheckoutHistoryFilters::default(),
            status: None,
            method: None,
            filters_open: false,
            invalid_dates: false,
            group_by_month: false,
            page: 1,
            results: Ok(None),
            request: None,
            observed_revision: None,
            receipt: None,
        }));
        self.load_sales_history(HistoryLoad::ApplyFilters, cx);
    }

    pub(super) fn refresh_sales_history(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        if self.status.connectivity == Connectivity::Online
            && matches!(&self.overlay, Overlay::SalesHistory(history)
                if history.receipt.is_none() && history.request.is_none() && !history.invalid_dates
                    && (reconnected || (matches!(history.results, Ok(Some(_)))
                        && history.observed_revision != self.svc.store.live_view_revision("commerce").ok())))
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
            let dates = boundary(&history.from, false, self.tz, cx).zip(boundary(
                &history.to,
                true,
                self.tz,
                cx,
            ));
            let Some((from, to)) =
                dates.filter(|(from, to)| !from.zip(*to).is_some_and(|(from, to)| from >= to))
            else {
                history.invalid_dates = true;
                history.request = None;
                cx.notify();
                return;
            };
            history.invalid_dates = false;
            history.submitted = CheckoutHistoryFilters {
                search: history.search.read(cx).text().trim().into(),
                status: history.status,
                method: history.method,
                from,
                to,
                group_by: None,
            };
        }
        let mut filters = history.submitted.clone();
        filters.group_by = Some(if history.group_by_month {
            CheckoutHistoryGroup::Month
        } else {
            CheckoutHistoryGroup::Day
        });
        let page = match load {
            HistoryLoad::ApplyFilters => 1,
            HistoryLoad::Page(page) => page,
            HistoryLoad::Refresh => history.page,
        };
        if !matches!(load, HistoryLoad::Refresh) {
            history.results = Ok(None);
        }
        let request = Arc::new(());
        history.request = Some(request.clone());
        history.observed_revision = self.svc.store.live_view_revision("commerce").ok();
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
                history.results = result.map(Some).map_err(|_| ());
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
            .child(
                div().flex().gap_2().children(
                    [(false, Key::SalesByDay), (true, Key::SalesByMonth)]
                        .into_iter()
                        .map(|(month, key)| {
                            self.button(
                                if month { "sales-months" } else { "sales-days" },
                                self.t(key),
                                if history.group_by_month == month {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    let Overlay::SalesHistory(history) = &mut root.overlay else {
                                        return;
                                    };
                                    if history.group_by_month != month
                                        && root.status.connectivity == Connectivity::Online
                                    {
                                        history.group_by_month = month;
                                        let page = history.page;
                                        root.load_sales_history(HistoryLoad::Page(page), cx);
                                    }
                                }),
                            )
                        }),
                ),
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
            if history.group_by_month {
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
                Ok(Some(page)) => body
                    .when(page.checkouts.is_empty(), |view| {
                        view.child(self.t(Key::SalesNoResults))
                    })
                    .when(
                        !page.checkouts.is_empty() && page.group_totals.is_some(),
                        |body| body.child(self.label(Key::SalesTotalsHelp)),
                    )
                    .child(
                        div()
                            .id("sales-history-rows")
                            .max_h(
                                (viewport.height
                                    - px(if history.filters_open { 480. } else { 290. }))
                                .max(px(90.)),
                            )
                            .overflow_y_scroll()
                            .child(div().flex().flex_col().gap_2().children(
                                page.checkouts.iter().enumerate().map(|(index, row)| {
                                    let period = period_of(row.created_at);
                                    let previous = index.checked_sub(1).map(|previous| {
                                        period_of(page.checkouts[previous].created_at)
                                    });
                                    let group = (previous != Some(period)).then(|| {
                                        if history.group_by_month {
                                            period.format("%Y-%m").to_string()
                                        } else {
                                            i18n::date_label(self.locale, period)
                                        }
                                    });
                                    let totals = group.as_ref().and_then(|_| {
                                        page.group_totals
                                            .as_ref()?
                                            .rows
                                            .iter()
                                            .find(|row| row.period == period)
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
                                        .when_some(totals, |view, totals| {
                                            view.child(
                                                self.render_sales_totals(totals, &row.currency),
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
                    ),
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
