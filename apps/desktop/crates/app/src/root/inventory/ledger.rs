use super::*;
use sob_core::inventory::StockKind;

pub(super) struct Panel {
    search: Entity<TextField>,
    _search_subscription: Subscription,
    pub(super) query: LedgerQuery,
    pub(super) page: u32,
    pub(super) results: Option<LedgerPage>,
    export: Option<Arc<()>>,
    export_notice: Option<Key>,
}

const FILTERS: [(Option<StockKind>, Key); 7] = [
    (None, Key::InventoryLedgerAll),
    (Some(StockKind::Opening), Key::InventoryStockOpening),
    (Some(StockKind::Receive), Key::InventoryLedgerDelivery),
    (Some(StockKind::Consume), Key::InventoryLedgerUse),
    (Some(StockKind::Count), Key::InventoryLedgerCount),
    (Some(StockKind::Sale), Key::InventoryStockSale),
    (Some(StockKind::Return), Key::InventoryStockReturn),
];

impl Root {
    pub(super) fn open_inventory_ledger(&mut self, cx: &mut Context<Self>) {
        let label = self.t(Key::InventoryLedgerSearch);
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some()
            || desk.product.is_some()
            || desk.ledger.is_some()
            || desk.catalog.is_none()
        {
            return;
        }
        let search = cx.new(|cx| TextField::new(label, false, cx));
        let subscription = cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.search_inventory_ledger(cx);
            }
        });
        let query = LedgerQuery::default();
        desk.ledger = Some(Panel {
            search,
            _search_subscription: subscription,
            query: query.clone(),
            page: 1,
            results: None,
            export: None,
            export_notice: None,
        });
        self.request_inventory(Action::Ledger(query, 1), cx);
    }

    fn search_inventory_ledger(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &self.overlay
            && let Some(panel) = &desk.ledger
        {
            self.filter_inventory_ledger(panel.query.kind, cx);
        }
    }

    fn filter_inventory_ledger(&mut self, kind: Option<StockKind>, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some() || desk.product.is_some() {
            return;
        }
        let Some(panel) = &mut desk.ledger else {
            return;
        };
        let Some(query) = LedgerQuery::new(panel.search.read(cx).text(), kind) else {
            desk.error = Some(Key::InventorySearchInvalid);
            cx.notify();
            return;
        };
        self.request_inventory(Action::Ledger(query, 1), cx);
    }

    fn page_inventory_ledger(&mut self, page: u32, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &self.overlay
            && desk.product.is_none()
            && let Some(panel) = &desk.ledger
        {
            self.request_inventory(Action::Ledger(panel.query.clone(), page), cx);
        }
    }

    fn show_latest_inventory_ledger(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &self.overlay
            && desk.product.is_none()
            && let Some(panel) = &desk.ledger
        {
            let mut query = panel.query.clone();
            query.anchor = None;
            self.request_inventory(Action::Ledger(query, 1), cx);
        }
    }

    fn close_inventory_ledger(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &mut self.overlay
            && desk.request.is_none()
            && desk.product.is_none()
        {
            desk.ledger = None;
            desk.retry = None;
            self.reload_inventory(cx);
        }
    }

    fn export_inventory_ledger(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.ledger else {
            return;
        };
        if desk.request.is_some() || panel.export.is_some() || panel.results.is_none() {
            return;
        }
        let query = panel.query.clone();
        let token = Arc::new(());
        panel.export = Some(token.clone());
        panel.export_notice = None;
        cx.notify();
        prompt_csv_export(
            "citame-stock-movements.csv",
            move |output| {
                transport
                    .write_inventory_ledger_csv(&query, output)
                    .map_err(std::io::Error::other)
            },
            move |root, notice, cx| {
                if let Overlay::Inventory(desk) = &mut root.overlay
                    && let Some(panel) = &mut desk.ledger
                    && panel
                        .export
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(&token, active))
                {
                    panel.export = None;
                    panel.export_notice = notice;
                    cx.notify();
                }
            },
            cx,
        );
    }

    pub(super) fn render_inventory_ledger(
        &self,
        panel: &Panel,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let results = panel.results.as_ref();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(div().min_w(px(170.)).flex_1().child(panel.search.clone()))
                    .when(ready, |row| {
                        row.child(self.button(
                            "ledger-find",
                            self.t(Key::InventoryFind),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.search_inventory_ledger(cx)),
                        ))
                        .child(self.button(
                            "ledger-back-to-products",
                            self.t(Key::InventoryProductList),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.close_inventory_ledger(cx)),
                        ))
                        .child(self.button(
                            "ledger-latest",
                            self.t(Key::InventoryLedgerLatest),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.show_latest_inventory_ledger(cx)),
                        ))
                        .when(
                            panel.export.is_none() && results.is_some(),
                            |row| {
                                row.child(self.button(
                                    "ledger-export",
                                    self.t(Key::ReportExport),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| root.export_inventory_ledger(cx)),
                                ))
                            },
                        )
                    }),
            )
            .when(ready, |body| {
                body.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .children(
                            FILTERS
                                .into_iter()
                                .enumerate()
                                .map(|(index, (kind, label))| {
                                    self.button(
                                        SharedString::from(format!("ledger-filter-{index}")),
                                        self.t(label),
                                        if panel.query.kind == kind {
                                            Kind::Primary
                                        } else {
                                            Kind::Ghost
                                        },
                                        cx.listener(move |root, _, _, cx| {
                                            root.filter_inventory_ledger(kind, cx)
                                        }),
                                    )
                                }),
                        ),
                )
            })
            .when_some(panel.export_notice, |view, notice| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(notice)),
                )
            })
            .when(results.is_some_and(|page| page.has_newer), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::InventoryLedgerNewer)),
                )
            })
            .when_some(results, |body, page| {
                let number = page.pagination.page;
                body.when(page.movements.is_empty(), |body| {
                    body.child(self.t(Key::InventoryLedgerEmpty))
                })
                .children(page.movements.iter().map(|row| {
                    let movement = &row.movement;
                    let product = movement.product_id;
                    let kind = FILTERS
                        .iter()
                        .find(|(kind, _)| *kind == Some(movement.kind))
                        .map_or(Key::InventoryLedgerAll, |(_, label)| *label);
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .border_b_1()
                        .border_color(theme::line())
                        .py_2()
                        .child(
                            div()
                                .flex_1()
                                .child(format!("{} · {}", row.product_name, row.sku))
                                .child(div().text_sm().text_color(theme::muted()).child(format!(
                                        "{} · {:+} · {}",
                                        self.t(kind),
                                        movement.quantity_delta,
                                        movement
                                            .created_at
                                            .with_timezone(&self.tz)
                                            .format("%d/%m/%Y %H:%M"),
                                    )))
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(theme::muted())
                                        .child(movement.reason.clone()),
                                ),
                        )
                        .when(ready, |row| {
                            row.child(self.button(
                                SharedString::from(format!("ledger-product-{}", movement.id)),
                                self.t(Key::InventoryProductDetails),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.request_inventory(Action::Product(product), cx)
                                }),
                            ))
                        })
                        .when_some(movement.receipt_id.filter(|_| ready), |row, id| {
                            row.child(self.button(
                                SharedString::from(format!("ledger-receipt-{}", movement.id)),
                                self.t(Key::InventoryReceiptView),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_linked_inventory_receipt(id, cx)
                                }),
                            ))
                        })
                }))
                .when(ready, |body| {
                    body.child(
                        div()
                            .flex()
                            .gap_2()
                            .when(number > 1, |row| {
                                row.child(self.button(
                                    "ledger-prev",
                                    self.t(Key::InboxPrevious),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.page_inventory_ledger(number - 1, cx)
                                    }),
                                ))
                            })
                            .when(page.pagination.has_next(), |row| {
                                row.child(self.button(
                                    "ledger-next",
                                    self.t(Key::InboxNext),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.page_inventory_ledger(number + 1, cx)
                                    }),
                                ))
                            }),
                    )
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn ledger_retains_filters_and_retries_the_attempted_navigation(cx: &mut TestAppContext) {
        let (_dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_inventory(cx);
            root.open_inventory_ledger(cx);
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("inventory should be open");
            };
            assert!(desk.ledger.is_none());
            desk.catalog = Some(
                serde_json::from_value(serde_json::json!({
                    "products": [],
                    "pagination": {"page": 1, "pageSize": 20, "total": 0}
                }))
                .unwrap(),
            );
            root.open_inventory_ledger(cx);
            let query = LedgerQuery::new("cotton", Some(StockKind::Consume)).unwrap();
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("inventory should be open");
            };
            let panel = desk.ledger.as_mut().unwrap();
            panel.query = query.clone();
            panel.page = 2;
            root.filter_inventory_ledger(Some(StockKind::Return), cx);
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("ledger should remain open after the offline request");
            };
            assert_eq!(desk.error, Some(Key::InventoryOffline));
            let product = ProductId::nil();
            desk.retry = Some((Instant::now(), Action::Product(product)));
            assert!(matches!(desk.reload_action(), Action::Product(id) if id == product));
            assert!(matches!(
                desk.navigation_action(),
                Action::Ledger(applied, 2) if applied == query
            ));
            root.close_inventory_ledger(cx);
            let Overlay::Inventory(desk) = &root.overlay else {
                panic!("catalog should be open");
            };
            assert!(desk.retry.is_none());
            assert!(matches!(desk.reload_action(), Action::Catalog(_, 1)));
        });
    }
}
