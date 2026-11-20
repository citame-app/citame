use super::*;
use sob_core::inventory::StockReturnAttempt;

pub(super) struct ReturnEditor {
    line_id: Uuid,
    quantity: Entity<TextField>,
    reason: Entity<TextField>,
    _changes: [Subscription; 2],
    attempt: Option<StockReturnAttempt>,
}

impl ReturnEditor {
    fn input(&self, maximum: u32, cx: &App) -> Option<(u32, String)> {
        let quantity = self.quantity.read(cx).text().trim().parse().ok()?;
        let reason = self.reason.read(cx).text().trim();
        StockReturnAttempt::valid_input(quantity, maximum, reason)
            .then(|| (quantity, reason.to_owned()))
    }
}

impl Root {
    fn open_stock_return(&mut self, line_id: Uuid, cx: &mut Context<Self>) {
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let store_failed = self.t(Key::InventoryStockStoreFailed);
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        if form.busy
            || form.refreshing
            || form.request.is_some()
            || form.refund.is_some()
            || form.confirming_void
            || form.stock_return.is_some()
            || !form
                .receipt
                .returnable_products()
                .any(|line| line.id == line_id)
        {
            return;
        }
        let Ok(receipt_id) = form.receipt.id.parse() else {
            return;
        };
        let attempt = match self
            .svc
            .store
            .pending_stock_return(receipt_id, &actor.user_id)
        {
            Ok(attempt) => attempt,
            Err(_) => {
                form.error = Some(store_failed.to_owned());
                cx.notify();
                return;
            }
        };
        let line_id = attempt
            .as_ref()
            .map_or(line_id, StockReturnAttempt::line_id);
        let quantity = cx.new(|cx| {
            let mut field = TextField::new("", false, cx);
            field.set_text("1", cx);
            field
        });
        let reason = cx.new(|cx| TextField::new("", false, cx));
        let changes = [
            cx.observe(&quantity, |_, _, cx| cx.notify()),
            cx.observe(&reason, |_, _, cx| cx.notify()),
        ];
        form.stock_return = Some(ReturnEditor {
            line_id,
            quantity,
            reason,
            _changes: changes,
            attempt,
        });
        form.error = None;
        form.stock_return_notice = None;
        cx.notify();
    }

    fn submit_stock_return(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let session = self.svc.session.clone();
        let store_failed = self.t(Key::InventoryStockStoreFailed);
        let another_window = self.t(Key::InventoryStockOtherWindow);
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        let Some(editor) = &mut form.stock_return else {
            return;
        };
        if form.busy || form.refreshing {
            return;
        }
        if editor.attempt.is_none() {
            let Some(line) = form
                .receipt
                .returnable_products()
                .find(|line| line.id == editor.line_id)
            else {
                return;
            };
            let Some((quantity, reason)) = editor.input(line.quantity, cx) else {
                return;
            };
            let Some(attempt) =
                form.receipt
                    .stock_return(editor.line_id, quantity, &reason, actor.user_id.clone())
            else {
                return;
            };
            match self.svc.store.reserve_stock_return(&attempt) {
                Ok(true) => editor.attempt = Some(attempt),
                Ok(false) => {
                    form.error = Some(another_window.to_owned());
                    form.stock_return = None;
                    cx.notify();
                    return;
                }
                Err(_) => {
                    form.error = Some(store_failed.to_owned());
                    cx.notify();
                    return;
                }
            }
        }
        let Some(attempt) = editor.attempt.clone() else {
            return;
        };
        if form.receipt.stock_return_obsolete(&attempt) {
            return;
        }
        let receipt = form.receipt.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        let submitted = attempt.clone();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.return_inventory_stock(&submitted) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let pending = root.t(Key::CheckoutStockReturnUnconfirmed);
                let store_failed = root.t(Key::InventoryStockStoreFailed);
                let cleared = root
                    .svc
                    .store
                    .settle_stock_return(&attempt, &result)
                    .is_ok();
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&receipt, &form.receipt) {
                    return;
                }
                let Some(editor) = &mut form.stock_return else {
                    return;
                };
                form.busy = false;
                if !cleared {
                    form.error = Some(store_failed.to_owned());
                    cx.notify();
                    return;
                }
                match result {
                    Ok(_) => {
                        form.stock_return = None;
                        form.error = None;
                        form.stock_return_notice = Some(Key::CheckoutStockReturnDone);
                    }
                    Err(TransportError::ReplicaGenerationChanged) => {
                        form.stock_return = None;
                        form.observed_revision = -1;
                        form.stock_return_notice = Some(Key::CheckoutStockReturnRestored);
                    }
                    Err(TransportError::BadRequest(message)) => {
                        editor.attempt = None;
                        form.error = Some(message);
                    }
                    Err(TransportError::Forbidden(message)) => form.error = Some(message),
                    Err(_) => form.error = Some(pending.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn discard_obsolete_stock_return(&mut self, cx: &mut Context<Self>) {
        let store_failed = self.t(Key::InventoryStockStoreFailed);
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        let Some(attempt) = form
            .stock_return
            .as_ref()
            .and_then(|editor| editor.attempt.as_ref())
        else {
            return;
        };
        if form.busy || !form.receipt.stock_return_obsolete(attempt) {
            return;
        }
        if self.svc.store.clear_stock_return(attempt).is_ok() {
            form.stock_return = None;
            form.stock_return_notice = None;
            form.error = None;
        } else {
            form.error = Some(store_failed.to_owned());
        }
        cx.notify();
    }

    pub(super) fn render_stock_returns(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(form.stock_return_notice, |view, notice| {
                view.child(div().text_sm().child(self.t(notice)))
            });
        let Some(editor) = &form.stock_return else {
            return body.when(
                online
                    && !form.busy
                    && !form.refreshing
                    && form.request.is_none()
                    && form.refund.is_none()
                    && !form.confirming_void,
                |view| {
                    view.children(form.receipt.returnable_products().map(|line| {
                        let id = line.id;
                        self.button(
                            SharedString::from(format!("stock-return-{id}")),
                            format!(
                                "{} · {}",
                                self.t(Key::CheckoutStockReturn),
                                line.description
                            ),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.open_stock_return(id, cx)),
                        )
                    }))
                },
            );
        };
        let body = body.child(self.label(Key::CheckoutStockReturn));
        let line = form
            .receipt
            .lines
            .iter()
            .find(|line| line.id == editor.line_id);
        let body = body
            .when_some(line, |view, line| {
                view.child(format!(
                    "{} · {}: {}",
                    line.description,
                    self.t(Key::CheckoutStockReturnSold),
                    line.quantity
                ))
            })
            .child(self.t(Key::CheckoutStockReturnHelp));
        if form.busy {
            return body.child(self.t(Key::InventoryStockSaving));
        }
        let body = body.when(!online, |view| view.child(self.t(Key::CheckoutOffline)));
        if let Some(attempt) = &editor.attempt {
            let obsolete = form.receipt.stock_return_obsolete(attempt);
            return body
                .child(format!(
                    "{}: {}",
                    self.t(Key::InventoryStockQuantity),
                    attempt.quantity()
                ))
                .child(attempt.reason().to_owned())
                .when(online && obsolete, |view| {
                    view.child(self.t(Key::CheckoutStockReturnReviewBeforeDiscard))
                        .child(self.button(
                            "discard-stock-return",
                            self.t(Key::CheckoutStockReturnDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| root.discard_obsolete_stock_return(cx)),
                        ))
                })
                .when(online && !obsolete, |view| {
                    view.child(self.button(
                        "retry-stock-return",
                        self.t(Key::InventoryStockRetry),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.submit_stock_return(cx)),
                    ))
                });
        }
        let Some(line) = line else {
            return body;
        };
        body.child(self.label(Key::InventoryStockQuantity))
            .child(editor.quantity.clone())
            .child(self.label(Key::CheckoutStockReturnReason))
            .child(editor.reason.clone())
            .when(
                online && editor.input(line.quantity, cx).is_some(),
                |view| {
                    view.child(self.button(
                        "submit-stock-return",
                        self.t(Key::CheckoutStockReturn),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.submit_stock_return(cx)),
                    ))
                },
            )
            .child(self.button(
                "cancel-stock-return",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() {
                        form.stock_return = None;
                        form.error = None;
                        cx.notify();
                    }
                }),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn a_restored_receipt_keeps_the_old_return_until_explicit_discard(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            let receipt_id = Uuid::now_v7();
            let line_id = Uuid::now_v7();
            let product_id = Uuid::now_v7();
            let receipt = |generation| {
                serde_json::from_value::<AppointmentCheckout>(json!({
                    "id": receipt_id, "currency": "EUR", "status": "paid",
                    "stockReturnGeneration": generation, "fulfilledAt": "2026-03-09T12:00:00Z",
                    "totalCents": 2000, "paidCents": 2000, "discountCents": 0, "balanceCents": 0,
                    "payments": [],
                    "lines": [{"id":line_id, "productId":product_id, "kind":"product",
                        "description":"Shampoo", "quantity":2, "unitAmountCents":1000}]
                }))
                .unwrap()
            };
            let attempt = receipt("first")
                .stock_return(line_id, 1, "Unopened return", "u".into())
                .unwrap();
            assert!(root.svc.store.reserve_stock_return(&attempt).unwrap());
            let restored = receipt("second");
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(restored, 0, cx));
            root.open_stock_return(line_id, cx);
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("missing receipt")
            };
            let editor = form
                .stock_return
                .as_ref()
                .expect("pending return recovered");
            assert_eq!(editor.attempt.as_ref(), Some(&attempt));
            assert!(form.receipt.stock_return_obsolete(&attempt));
            root.discard_obsolete_stock_return(cx);
            assert!(
                root.svc
                    .store
                    .pending_stock_return(receipt_id, "u")
                    .unwrap()
                    .is_none()
            );
        });
    }
}
