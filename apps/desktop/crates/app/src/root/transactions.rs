use super::*;
use checkout::CheckoutReview;
use sob_core::billing::CheckoutPage;
use uuid::Uuid;

pub(super) struct History {
    search: Entity<TextField>,
    _search_events: Subscription,
    term: String,
    page: u32,
    results: Result<Option<CheckoutPage>, ()>,
    request: Option<Arc<()>>,
    pub(super) receipt: Option<CheckoutReview>,
}

impl Root {
    pub(super) fn open_sales_history(&mut self, cx: &mut Context<Self>) {
        let search = cx.new(|cx| TextField::new(self.t(Key::SalesSearch), false, cx));
        let events = cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.load_sales_history(1, cx);
            }
        });
        self.overlay = Overlay::SalesHistory(Box::new(History {
            search,
            _search_events: events,
            term: String::new(),
            page: 1,
            results: Ok(None),
            request: None,
            receipt: None,
        }));
        self.load_sales_history(1, cx);
    }

    fn load_sales_history(&mut self, page: u32, cx: &mut Context<Self>) {
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
        if page == 1 {
            history.term = history.search.read(cx).text().trim().to_owned();
        }
        let term = history.term.clone();
        let request = Arc::new(());
        history.request = Some(request.clone());
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.checkout_history(&term, page) })
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
                history.page = page;
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
            .when(online, |view| {
                view.child(self.button(
                    "search-sales",
                    self.t(Key::SaleSearch),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.load_sales_history(1, cx)),
                ))
            })
            .when(!online, |view| view.child(self.t(Key::CheckoutOffline)));

        let body = if history.request.is_some() {
            body.child(self.t(Key::CheckoutLoading))
        } else {
            match &history.results {
                Err(()) => body.child(self.t(Key::CheckoutUnavailable)),
                Ok(Some(page)) if page.checkouts.is_empty() => {
                    body.child(self.t(Key::SalesNoResults))
                }
                Ok(Some(page)) => body
                    .child(
                        div()
                            .id("sales-history-rows")
                            .max_h((viewport.height - px(235.)).max(px(100.)))
                            .overflow_y_scroll()
                            .child(div().flex().flex_col().gap_2().children(
                                page.checkouts.iter().map(|row| {
                                    let id = row.id;
                                    let title = row
                                        .lines
                                        .iter()
                                        .take(2)
                                        .map(|line| line.description.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ");
                                    let status = match row.status.as_str() {
                                        "open" => self.t(Key::SalesStatusOpen),
                                        "paid" => self.t(Key::SalesStatusPaid),
                                        "void" => self.t(Key::SalesStatusVoid),
                                        "refunded" => self.t(Key::SalesStatusRefunded),
                                        "partially_refunded" => {
                                            self.t(Key::SalesStatusPartiallyRefunded)
                                        }
                                        _ => row.status.as_str(),
                                    };
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
                                        root.load_sales_history(page, cx)
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
                                            root.load_sales_history(page, cx)
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
