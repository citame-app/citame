use super::*;
use sob_core::inventory::{StockKind, StockRequestId};

#[derive(Default)]
pub(super) struct Panel {
    pub(super) history: Option<MovementPage>,
    pub(super) needs_refresh: bool,
    draft: Option<Draft>,
    pending: Option<PendingStock>,
    rejected_generation_for: Option<StockRequestId>,
}

impl Panel {
    pub(super) fn can_refresh(&self) -> bool {
        self.pending.is_none() && self.draft.is_none() && !self.needs_refresh
    }

    fn may_discard(&self, pending: &PendingStock, product: &Product) -> bool {
        self.rejected_generation_for == Some(pending.command.idempotency_key)
            && !self.needs_refresh
            && self
                .history
                .as_ref()
                .is_some_and(|history| history.inventory_generation == product.inventory_generation)
            && previous_generation(pending, product)
    }
}

struct Draft {
    kind: StockKind,
    quantity: Entity<TextField>,
    reason: Entity<TextField>,
}

fn kind_label(kind: StockKind) -> Key {
    match kind {
        StockKind::Opening => Key::InventoryStockOpening,
        StockKind::Receive => Key::InventoryStockReceive,
        StockKind::Consume => Key::InventoryStockConsume,
        StockKind::Count => Key::InventoryStockCount,
        StockKind::Sale => Key::InventoryStockSale,
        StockKind::Return => Key::InventoryStockReturn,
    }
}

fn previous_generation(pending: &PendingStock, product: &Product) -> bool {
    product
        .inventory_generation
        .as_ref()
        .is_some_and(|generation| *generation != pending.command.generation)
}

impl Root {
    pub(super) fn open_stock_panel(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(product) = desk.product.as_ref() else {
            return;
        };
        if desk.request.is_some() || desk.editor.is_some() || desk.stock.is_some() {
            return;
        }
        let id = product.id;
        match self.svc.store.pending_stock(id) {
            Ok(pending) => {
                desk.stock = Some(Panel {
                    pending,
                    ..Panel::default()
                });
                self.request_inventory(Action::StockProduct(id), cx);
            }
            Err(_) => {
                desk.error = Some(Key::InventoryStockStoreFailed);
                cx.notify();
            }
        }
    }

    fn begin_stock_movement(&mut self, kind: StockKind, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let (Some(product), Some(panel)) = (&desk.product, &mut desk.stock) else {
            return;
        };
        if desk.request.is_some()
            || !product.can_manage
            || product.inventory_generation.is_none()
            || panel.pending.is_some()
            || panel.needs_refresh
        {
            return;
        }
        if let Some(draft) = &mut panel.draft {
            // A physical count is a total, while deliveries and consumption are changes.
            if (draft.kind == StockKind::Count) != (kind == StockKind::Count) {
                draft
                    .quantity
                    .update(cx, |field, cx| field.set_text("", cx));
            }
            draft.kind = kind;
        } else {
            panel.draft = Some(Draft {
                kind,
                quantity: cx.new(|cx| TextField::new("", false, cx)),
                reason: cx.new(|cx| TextField::new("", false, cx)),
            });
        }
        desk.error = None;
        cx.notify();
    }

    fn save_stock_movement(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let (Some(product), Some(panel)) = (&desk.product, &mut desk.stock) else {
            return;
        };
        if desk.request.is_some() || panel.needs_refresh || !product.can_manage {
            return;
        }
        if panel.pending.is_none() {
            let Some(draft) = &panel.draft else {
                return;
            };
            let Some(prepared) = PendingStock::prepare(
                product,
                draft.kind,
                draft.quantity.read(cx).text(),
                draft.reason.read(cx).text(),
            ) else {
                desk.error = Some(Key::InventoryStockInvalid);
                cx.notify();
                return;
            };
            match self.svc.store.reserve_pending_stock(&prepared) {
                Ok(true) => panel.pending = Some(prepared),
                Ok(false) => {
                    // Do not send an operation that was prepared in another window behind this one.
                    match self.svc.store.pending_stock(product.id) {
                        Ok(pending) => {
                            panel.pending = pending;
                            panel.needs_refresh = panel.pending.is_none();
                            desk.error = Some(Key::InventoryStockOtherWindow);
                        }
                        Err(_) => desk.error = Some(Key::InventoryStockStoreFailed),
                    }
                    cx.notify();
                    return;
                }
                Err(_) => {
                    desk.error = Some(Key::InventoryStockStoreFailed);
                    cx.notify();
                    return;
                }
            }
            panel.draft = None;
        }
        let Some(pending) = &panel.pending else {
            return;
        };
        // A stale window may display an older generation than a request prepared in a
        // different window. Only the accepting server can classify that request.
        if panel.rejected_generation_for == Some(pending.command.idempotency_key) {
            return;
        }
        match self.svc.store.pending_stock(product.id) {
            Ok(Some(current)) if &current == pending => {
                self.request_inventory(Action::MoveStock(current), cx);
            }
            Ok(current) => {
                panel.needs_refresh = true;
                panel.pending = current;
                desk.error = Some(Key::InventoryStockOtherWindow);
                cx.notify();
            }
            Err(_) => {
                desk.error = Some(Key::InventoryStockStoreFailed);
                cx.notify();
            }
        }
    }

    pub(super) fn finish_stock_movement(
        &mut self,
        pending: PendingStock,
        result: Result<Box<Product>, StockWriteError>,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(panel) = &mut desk.stock else {
            return;
        };
        match result {
            Err(StockWriteError::Transport(error)) => {
                desk.error = Some(match error {
                    TransportError::ReplicaGenerationChanged => {
                        panel.rejected_generation_for = Some(pending.command.idempotency_key);
                        panel.needs_refresh = true;
                        panel.history = None;
                        Key::InventoryStockGenerationChanged
                    }
                    TransportError::Forbidden(_) | TransportError::Unauthorized => {
                        Key::InventoryRestricted
                    }
                    _ => Key::InventoryStockPending,
                });
                cx.notify();
                return;
            }
            outcome => {
                if self.svc.store.clear_pending_stock(&pending).is_err() {
                    desk.error = Some(Key::InventoryStockStoreFailed);
                    cx.notify();
                    return;
                }
                panel.pending = None;
                panel.rejected_generation_for = None;
                match outcome {
                    Ok(product) => {
                        desk.product = Some(*product);
                        panel.history = None;
                        self.request_inventory(Action::Movements(pending.product_id, 1), cx);
                        return;
                    }
                    Err(_) => {
                        panel.needs_refresh = true;
                        desk.error = Some(Key::InventoryStockReview);
                    }
                }
            }
        }
        cx.notify();
    }

    fn discard_obsolete_stock(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let (Some(product), Some(panel)) = (&desk.product, &mut desk.stock) else {
            return;
        };
        if desk.request.is_some() || panel.needs_refresh || !product.can_manage {
            return;
        }
        let Some(pending) = panel
            .pending
            .as_ref()
            .filter(|pending| panel.may_discard(pending, product))
        else {
            return;
        };
        if self.svc.store.clear_pending_stock(pending).is_err() {
            desk.error = Some(Key::InventoryStockStoreFailed);
        } else {
            panel.pending = None;
            panel.rejected_generation_for = None;
            panel.draft = None;
            desk.error = None;
        }
        cx.notify();
    }

    pub(super) fn render_stock_panel(
        &self,
        panel: &Panel,
        product: &Product,
        idle: bool,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = product.id;
        let mut body = div().mt_3().flex().flex_col().gap_2().child(
            div()
                .font_weight(FontWeight::BOLD)
                .child(self.t(Key::InventoryStockHistory)),
        );
        if let Some(pending) = &panel.pending {
            let command = &pending.command;
            let obsolete = panel.rejected_generation_for == Some(command.idempotency_key);
            body = body
                .child(format!(
                    "{} · {} {} · {}",
                    self.t(kind_label(command.kind)),
                    command.quantity,
                    product.unit_label,
                    command.reason
                ))
                .child(self.t(if obsolete {
                    Key::InventoryStockOldRequest
                } else {
                    Key::InventoryStockPending
                }))
                .when(
                    ready && !panel.needs_refresh && product.can_manage,
                    |body| {
                        if panel.may_discard(pending, product) {
                            body.child(self.button(
                                "inventory-stock-discard-obsolete",
                                self.t(Key::InventoryStockDiscardOld),
                                Kind::Danger,
                                cx.listener(|root, _, _, cx| root.discard_obsolete_stock(cx)),
                            ))
                        } else if !obsolete && product.inventory_generation.is_some() {
                            body.child(self.button(
                                "inventory-stock-retry",
                                self.t(Key::InventoryStockRetry),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_stock_movement(cx)),
                            ))
                        } else {
                            body
                        }
                    },
                );
        } else if idle
            && product.can_manage
            && product.inventory_generation.is_some()
            && !panel.needs_refresh
        {
            let actions = [
                (StockKind::Receive, "inventory-receive"),
                (StockKind::Consume, "inventory-consume"),
                (StockKind::Count, "inventory-count"),
            ];
            body = body.child(div().flex().flex_wrap().gap_2().children(actions.map(
                |(kind, id)| {
                    self.button(
                        id,
                        self.t(kind_label(kind)),
                        if panel.draft.as_ref().is_some_and(|draft| draft.kind == kind) {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        },
                        cx.listener(move |root, _, _, cx| root.begin_stock_movement(kind, cx)),
                    )
                },
            )));
            if let Some(draft) = &panel.draft {
                body = body
                    .child(self.t(if draft.kind == StockKind::Count {
                        Key::InventoryStockCounted
                    } else {
                        Key::InventoryStockQuantity
                    }))
                    .child(draft.quantity.clone())
                    .child(self.t(Key::CashReason))
                    .child(draft.reason.clone())
                    .child(self.button(
                        "inventory-stock-save",
                        self.t(if ready {
                            Key::InventoryStockSave
                        } else {
                            Key::InventoryStockSaveLocal
                        }),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_stock_movement(cx)),
                    ));
            }
        }
        if ready {
            body = body.child(self.button(
                "inventory-stock-review",
                self.t(Key::InventoryReviewLatest),
                Kind::Ghost,
                cx.listener(move |root, _, _, cx| {
                    root.request_inventory(Action::StockProduct(id), cx)
                }),
            ));
        }
        body = body.child(self.render_stock_history(panel, product, ready, cx));
        body.when(idle, |body| {
            body.child(self.button(
                "inventory-stock-back",
                self.t(Key::InventoryProductDetails),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ))
        })
    }

    fn render_stock_history(
        &self,
        panel: &Panel,
        product: &Product,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = product.id;
        let history = div().mt_2().flex().flex_col().gap_2();
        let Some(page) = &panel.history else {
            return history.when(ready, |body| {
                body.child(self.button(
                    "inventory-stock-load",
                    self.t(Key::InventoryRefresh),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.request_inventory(Action::Movements(id, 1), cx)
                    }),
                ))
            });
        };
        history
            .when(page.movements.is_empty(), |body| {
                body.child(self.t(Key::InventoryStockEmpty))
            })
            .children(page.movements.iter().map(|movement| {
                div()
                    .child(format!(
                        "{} · {:+} {} · {}",
                        self.t(kind_label(movement.kind)),
                        movement.quantity_delta,
                        product.unit_label,
                        movement
                            .created_at
                            .with_timezone(&self.tz)
                            .format("%d/%m/%Y %H:%M"),
                    ))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(movement.reason.clone()),
                    )
            }))
            .when(ready, |body| {
                let number = page.pagination.page;
                let controls = [
                    (
                        "inventory-stock-prev",
                        Key::InboxPrevious,
                        number.saturating_sub(1),
                        number > 1,
                    ),
                    (
                        "inventory-stock-next",
                        Key::InboxNext,
                        number + 1,
                        page.pagination.has_next(),
                    ),
                ];
                body.child(
                    div().flex().flex_wrap().gap_2().children(
                        controls
                            .into_iter()
                            .filter(|(_, _, _, visible)| *visible)
                            .map(|(button_id, key, number, _)| {
                                self.button(
                                    button_id,
                                    self.t(key),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.request_inventory(Action::Movements(id, number), cx)
                                    }),
                                )
                            }),
                    ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(generation: &str) -> Product {
        serde_json::from_value(serde_json::json!({
            "id": "0198f5a0-7b1c-7000-8000-000000000001", "name": "Synthetic stock",
            "sku": "TEST", "stockOnHand": 3, "stockReserved": 1, "available": 2,
            "unitLabel": "pack", "priceCents": 1200, "currency": "EUR", "active": true,
            "version": 4, "canManage": true, "inventoryGeneration": generation
        }))
        .unwrap()
    }

    #[test]
    fn a_stale_window_cannot_discard_an_unconfirmed_request_from_another_generation() {
        let pending = PendingStock::prepare(
            &product("generation2"),
            StockKind::Count,
            "2",
            "Shelf count",
        )
        .unwrap();
        let stale_view = product("generation1");
        let mut panel = Panel {
            history: Some(
                serde_json::from_value(serde_json::json!({
                    "movements": [], "pagination": {"page": 1, "pageSize": 20, "total": 0},
                    "inventoryGeneration": "generation1"
                }))
                .unwrap(),
            ),
            ..Panel::default()
        };
        assert!(!panel.may_discard(&pending, &stale_view));
        panel.rejected_generation_for = Some(pending.command.idempotency_key);
        panel.needs_refresh = true;
        assert!(!panel.may_discard(&pending, &stale_view));
        panel.needs_refresh = false;
        assert!(!panel.may_discard(&pending, &product("generation2")));
        assert!(panel.may_discard(&pending, &stale_view));
    }

    #[gpui::test]
    async fn offline_stock_can_be_saved_and_the_same_request_is_present_on_reopen(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_inventory(cx);
            let id = product("generation1").id;
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("missing inventory")
            };
            desk.product = Some(product("generation1"));
            root.open_stock_panel(cx);
            root.begin_stock_movement(StockKind::Count, cx);
            let Overlay::Inventory(desk) = &root.overlay else {
                panic!("missing inventory")
            };
            let draft = desk.stock.as_ref().unwrap().draft.as_ref().unwrap();
            draft
                .quantity
                .update(cx, |field, cx| field.set_text("2", cx));
            draft
                .reason
                .update(cx, |field, cx| field.set_text("Shelf count", cx));
            root.save_stock_movement(cx);
            let pending = root.svc.store.pending_stock(id).unwrap().unwrap();
            assert_eq!(pending.command.quantity, 2);
            assert_eq!(pending.command.generation, "generation1");
            root.dismiss_overlay(cx);
            root.open_stock_panel(cx);
            let Overlay::Inventory(desk) = &root.overlay else {
                panic!("missing inventory")
            };
            assert_eq!(
                desk.stock.as_ref().unwrap().pending.as_ref(),
                Some(&pending)
            );
            assert!(desk.stock.as_ref().unwrap().draft.is_none());
        });
    }
}
