use super::*;

impl Root {
    pub(in crate::root::inventory) fn render_warehouses(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let can_write = self.svc.store.can_queue_product_edits() && panel.request.is_none();
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::InventoryWarehouses)),
            )
            .when_some(panel.notice, |body, key| {
                body.child(div().text_sm().child(self.t(key)))
            })
            .when(panel.request.is_some(), |body| {
                body.child(self.t(Key::InventoryLoading))
            });
        if panel.discard {
            return body
                .child(self.t(Key::SalonConfirmDiscard))
                .child(self.button(
                    "warehouse-discard",
                    self.t(Key::SalonDiscard),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| {
                        if let Some(panel) = root.warehouse_panel() {
                            panel.draft = None;
                            panel.discard = false;
                            panel.generation = None;
                            panel.replaces = None;
                            root.load_warehouse_stock(cx);
                        }
                    }),
                ));
        }
        if let Some(Draft::Location { warehouse, name }) = &panel.draft {
            let active = warehouse.active;
            let current = panel
                .replaces
                .as_ref()
                .and_then(|_| panel.locations.as_ref())
                .and_then(|list| {
                    list.warehouses
                        .iter()
                        .find(|row| row.id == Some(warehouse.id))
                });
            return body
                .when_some(current, |body, row| {
                    body.child(self.label(Key::InventoryDocumentCurrent))
                        .child(format!(
                            "{} · {}",
                            self.warehouse_name(row),
                            self.t(if row.active {
                                Key::InventoryWarehouseActive
                            } else {
                                Key::InventoryWarehouseArchived
                            })
                        ))
                })
                .child(self.label(Key::InventoryWarehouseName))
                .child(name.clone())
                .child(self.button(
                    "warehouse-toggle-active",
                    self.t(if active {
                        Key::InventoryWarehouseActive
                    } else {
                        Key::InventoryWarehouseArchived
                    }),
                    if active { Kind::Primary } else { Kind::Ghost },
                    cx.listener(|root, _, _, cx| {
                        if let Some(panel) = root.warehouse_panel()
                            && let Some(Draft::Location { warehouse, .. }) = &mut panel.draft
                        {
                            warehouse.active = !warehouse.active;
                            cx.notify();
                        }
                    }),
                ))
                .when(can_write && panel.generation.is_some(), |body| {
                    body.child(self.warehouse_submit(cx))
                });
        }
        if let Some(Draft::Transfer {
            source,
            destination,
            reason,
            lines,
            ..
        }) = &panel.draft
        {
            body = body
                .when_some(
                    panel
                        .locations
                        .as_ref()
                        .and_then(|list| list.warehouses.iter().find(|row| row.id == *source)),
                    |body, row| {
                        body.child(self.label(Key::InventoryWarehouseSource))
                            .child(self.warehouse_name(row).to_owned())
                    },
                )
                .child(self.label(Key::InventoryWarehouseDestination))
                .child(
                    div().flex().flex_wrap().gap_2().children(
                        panel
                            .locations
                            .iter()
                            .flat_map(|list| &list.warehouses)
                            .filter(|row| row.active && row.id != *source)
                            .enumerate()
                            .map(|(index, row)| {
                                let location = row.id;
                                self.button(
                                    ("warehouse-destination", index),
                                    self.warehouse_name(row).to_owned(),
                                    if *destination == Some(location) {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        if let Some(panel) = root.warehouse_panel()
                                            && let Some(Draft::Transfer { destination, .. }) =
                                                &mut panel.draft
                                        {
                                            *destination = Some(location);
                                            cx.notify();
                                        }
                                    }),
                                )
                            }),
                    ),
                )
                .child(self.label(Key::InventoryWarehouseReason))
                .child(reason.clone())
                .children(lines.iter().enumerate().map(|(index, line)| {
                    let id = line.balance.product_id;
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .child(div().flex_1().child(line.balance.name.clone()).child(
                            div().text_xs().text_color(theme::muted()).child(format!(
                                "{} {}",
                                line.balance.on_hand.saturating_sub(line.balance.reserved),
                                self.t(Key::InventoryWarehouseAvailable),
                            )),
                        ))
                        .child(div().w(px(96.)).child(line.quantity.clone()))
                        .child(self.button(
                            ("warehouse-remove-line", index),
                            self.t(Key::InventoryReceiptRemoveLine),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(panel) = root.warehouse_panel()
                                    && let Some(Draft::Transfer { lines, .. }) = &mut panel.draft
                                {
                                    lines.retain(|line| line.balance.product_id != id);
                                    cx.notify();
                                }
                            }),
                        ))
                }))
                .when(can_write && panel.generation.is_some(), |body| {
                    body.child(self.warehouse_submit(cx))
                });
        } else {
            body = body
                .child(
                    div().flex().flex_wrap().gap_2().children(
                        panel
                            .locations
                            .iter()
                            .flat_map(|list| &list.warehouses)
                            .enumerate()
                            .map(|(index, row)| {
                                let location = row.id;
                                let label = if row.active {
                                    self.warehouse_name(row).to_owned()
                                } else {
                                    format!(
                                        "{} · {}",
                                        self.warehouse_name(row).to_owned(),
                                        self.t(Key::InventoryWarehouseArchived)
                                    )
                                };
                                self.button(
                                    ("warehouse-location", index),
                                    label,
                                    if panel.query.location == location {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        root.choose_warehouse(location, cx)
                                    }),
                                )
                            }),
                    ),
                )
                .when(can_write && panel.locations.is_some(), |body| {
                    body.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(self.button(
                                "warehouse-new",
                                self.t(Key::InventoryWarehouseNew),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.edit_warehouse(None, cx)),
                            ))
                            .when_some(
                                panel
                                    .stock
                                    .as_ref()
                                    .map(|stock| &stock.warehouse)
                                    .filter(|row| row.id.is_some()),
                                |row, warehouse| {
                                    let warehouse = warehouse.clone();
                                    row.child(self.button(
                                        "warehouse-edit",
                                        self.t(Key::InventoryWarehouseEdit),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.edit_warehouse(Some(warehouse.clone()), cx)
                                        }),
                                    ))
                                },
                            )
                            .when(
                                panel
                                    .stock
                                    .as_ref()
                                    .is_some_and(|stock| stock.warehouse.active)
                                    && panel.locations.as_ref().is_some_and(|list| {
                                        list.warehouses.iter().filter(|row| row.active).count() > 1
                                    }),
                                |row| {
                                    row.child(self.button(
                                        "warehouse-transfer",
                                        self.t(Key::InventoryWarehouseTransfer),
                                        Kind::Primary,
                                        cx.listener(|root, _, _, cx| root.start_stock_transfer(cx)),
                                    ))
                                },
                            ),
                    )
                });
        }
        let transfer = matches!(panel.draft, Some(Draft::Transfer { .. }));
        body.child(
            div()
                .flex()
                .gap_2()
                .items_center()
                .child(div().flex_1().child(panel.search.clone()))
                .child(self.button(
                    "warehouse-search",
                    self.t(Key::InventoryRefresh),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.search_warehouse_stock(cx)),
                )),
        )
        .when(panel.stock.is_none() && panel.request.is_none(), |body| {
            body.child(self.t(Key::InventoryWarehouseUnavailable))
        })
        .when_some(panel.stock.as_ref(), |body, stock| {
            let page = stock.pagination.page;
            body.when(stock.products.is_empty(), |body| {
                body.child(self.t(Key::InventoryEmpty))
            })
            .children(stock.products.iter().enumerate().map(|(index, product)| {
                let balance = product.clone();
                let available = product.on_hand.saturating_sub(product.reserved);
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .py_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .child(
                        div().flex_1().child(product.name.clone()).child(
                            div()
                                .text_xs()
                                .text_color(theme::muted())
                                .child(product.sku.clone()),
                        ),
                    )
                    .child(div().text_sm().child(format!(
                        "{} {} · {} {}",
                        product.on_hand,
                        self.t(Key::InventoryWarehouseOnHand),
                        product.reserved,
                        self.t(Key::InventoryWarehouseReserved),
                    )))
                    .when(transfer && available > 0, |row| {
                        row.child(self.button(
                            ("warehouse-add-line", index),
                            self.t(Key::InventoryWarehouseAddLine),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.add_transfer_line(balance.clone(), cx)
                            }),
                        ))
                    })
            }))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .when(page > 1, |row| {
                        row.child(self.button(
                            "warehouse-prev",
                            "‹",
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.warehouse_page(page - 1, cx)),
                        ))
                    })
                    .child(page.to_string())
                    .when(stock.pagination.has_next(), |row| {
                        row.child(self.button(
                            "warehouse-next",
                            "›",
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.warehouse_page(page + 1, cx)),
                        ))
                    }),
            )
        })
    }

    fn warehouse_submit(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.button(
            "warehouse-save",
            self.t(Key::InventoryWarehouseSave),
            Kind::Primary,
            cx.listener(|root, _, _, cx| root.queue_warehouse_draft(cx)),
        )
    }
}
