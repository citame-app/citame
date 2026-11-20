use super::*;
use sob_core::billing::{
    BankPaymentMethod, BankPaymentOutcome, BankPaymentReconciliation, PendingBankPayment,
};

pub(super) struct BankPaymentReview {
    payment: PendingBankPayment,
    reference: Entity<TextField>,
    outcome: Option<BankPaymentOutcome>,
    pub(super) needs_refresh: bool,
    _changed: Subscription,
}

impl BankPaymentReview {
    pub(super) fn payment_id(&self) -> Uuid {
        self.payment.id
    }

    fn command(&self, cx: &App) -> Option<BankPaymentReconciliation> {
        if self.needs_refresh {
            return None;
        }
        BankPaymentReconciliation::new(self.outcome?, self.reference.read(cx).text())
    }
}

fn bank_method_label(method: BankPaymentMethod) -> Key {
    match method {
        BankPaymentMethod::Card => Key::SalesBankCard,
        BankPaymentMethod::Bizum => Key::SalesBizum,
    }
}

impl Root {
    pub(super) fn checkout_keyboard_button(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        kind: Kind,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        self.button(id, label, kind, on_click)
            .tab_index(0)
            .focus(|style| style.border_color(theme::text()))
    }

    fn review_bank_payment(&mut self, payment_id: Uuid, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if !form.is_idle() || form.refreshing || form.pass_picker.is_some() {
            return;
        }
        let Some(payment) = form
            .receipt
            .reconcilable_bank_payments(Utc::now())
            .find(|payment| payment.id == payment_id)
        else {
            return;
        };
        let reference = cx.new(|cx| TextField::new("", false, cx));
        let changed = cx.observe(&reference, |_, _, cx| cx.notify());
        form.reconciliation = Some(BankPaymentReview {
            payment,
            reference,
            outcome: None,
            needs_refresh: false,
            _changed: changed,
        });
        form.error = None;
        form.bank_outcome_changed = false;
        cx.notify();
    }

    fn reconcile_bank_payment(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.busy || form.refreshing {
            return;
        }
        let Some(review) = &form.reconciliation else {
            return;
        };
        let Some(command) = review.command(cx) else {
            return;
        };
        let payment_id = review.payment_id();
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(
                    async move { transport.reconcile_bank_payment(&receipt, payment_id, &command) },
                )
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                root.svc.wake(Wake::Manual);
                let error = root.t(Key::CheckoutBankUnconfirmed);
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&form.receipt, &previous) {
                    return;
                }
                form.busy = false;
                match result {
                    Ok(result) => {
                        let receipt = result.receipt;
                        form.bank_outcome_changed = result.bank_outcome_changed;
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx)
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                    }
                    Err(_) => {
                        form.error = Some(error.to_owned());
                        form.observed_revision = -1;
                        if let Some(review) = &mut form.reconciliation {
                            review.outcome = None;
                            review.needs_refresh = true;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_bank_payment_review(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div().flex().flex_col().gap_2();
        let online = self.status.connectivity == Connectivity::Online;
        let describe = |payment: &PendingBankPayment| {
            format!(
                "{} · {} · {} {}",
                self.t(if payment.merchant_initiated {
                    Key::CheckoutAutomaticBankPayment
                } else {
                    bank_method_label(payment.method)
                }),
                self.amount_label(i64::from(payment.amount_cents), &form.receipt.currency),
                self.t(Key::CheckoutBankOrder),
                payment.bank_order
            )
        };
        let Some(review) = &form.reconciliation else {
            return body.when(
                online && form.is_idle() && !form.refreshing && form.pass_picker.is_none(),
                |view| {
                    view.children(form.receipt.reconcilable_bank_payments(Utc::now()).map(
                        |payment| {
                            let id = payment.id;
                            self.checkout_keyboard_button(
                                SharedString::from(format!("review-bank-payment-{id}")),
                                format!(
                                    "{} · {}",
                                    self.t(Key::CheckoutBankReconcile),
                                    describe(&payment)
                                ),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| root.review_bank_payment(id, cx)),
                            )
                        },
                    ))
                },
            );
        };
        let body = body
            .child(self.label(Key::CheckoutBankReconcile))
            .child(describe(&review.payment))
            .child(div().text_sm().child(self.t(Key::CheckoutBankReviewHelp)));
        if form.busy {
            return body.child(self.t(Key::CheckoutRecording));
        }
        body.when(!online, |view| view.child(self.t(Key::CheckoutOffline)))
            .when(online && form.refreshing, |view| {
                view.child(self.t(Key::CheckoutLoading))
            })
            .when(online && review.needs_refresh && !form.refreshing, |view| {
                view.child(self.checkout_keyboard_button(
                    "reload-bank-payment",
                    self.t(Key::CheckoutBankReload),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() {
                            form.observed_revision = -1;
                        }
                        root.refresh_checkout_if_changed(cx);
                    }),
                ))
            })
            .when(
                online && !form.refreshing && !review.needs_refresh,
                |view| {
                    view.child(self.label(Key::CheckoutBankReference))
                        .child(review.reference.clone())
                        .child(
                            div().flex().flex_wrap().gap_2().children(
                                [
                                    (
                                        BankPaymentOutcome::Succeeded,
                                        Key::CheckoutBankPaid,
                                        "bank-paid",
                                    ),
                                    (
                                        BankPaymentOutcome::Failed,
                                        Key::CheckoutBankUnpaid,
                                        "bank-unpaid",
                                    ),
                                ]
                                .into_iter()
                                .map(|(outcome, label, id)| {
                                    let selected = review.outcome == Some(outcome);
                                    self.checkout_keyboard_button(
                                        id,
                                        if selected {
                                            format!("✓ {}", self.t(label))
                                        } else {
                                            self.t(label).to_owned()
                                        },
                                        if selected { Kind::Primary } else { Kind::Ghost },
                                        cx.listener(move |root, _, _, cx| {
                                            if let Some(CheckoutReview::Receipt(form)) =
                                                root.checkout_review_mut()
                                                && let Some(review) = &mut form.reconciliation
                                            {
                                                review.outcome = Some(outcome);
                                                cx.notify();
                                            }
                                        }),
                                    )
                                }),
                            ),
                        )
                        .when(review.command(cx).is_some(), |view| {
                            view.child(self.checkout_keyboard_button(
                                "confirm-bank-payment",
                                self.t(Key::CheckoutBankConfirm),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.reconcile_bank_payment(cx)),
                            ))
                        })
                },
            )
            .when(!review.needs_refresh, |view| {
                view.child(self.checkout_keyboard_button(
                    "cancel-bank-payment-review",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                            && form
                                .reconciliation
                                .as_ref()
                                .is_some_and(|review| !review.needs_refresh)
                        {
                            form.reconciliation = None;
                            form.error = None;
                            cx.notify();
                        }
                    }),
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn reconciliation_requires_review_and_closes_when_cloud_resolves_the_payment(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let payment_id = Uuid::now_v7();
        let mut data = json!({
            "id": Uuid::now_v7(), "currency": "EUR", "status": "open", "canRefund": true,
            "totalCents": 1800, "discountCents": 0, "paidCents": 0, "balanceCents": 1800,
            "payments": [{"id": payment_id, "method": "redsys_bizum", "status": "pending",
                "amountCents": 1800, "order": "123412345678",
                "reconcileAfter": (Utc::now() - Span::minutes(2)).to_rfc3339()}]
        });
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            let receipt = serde_json::from_value(data.clone()).unwrap();
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt, 0, cx));
            root.status.connectivity = Connectivity::Offline;
            root.review_bank_payment(payment_id, cx);
            assert!(matches!(root.checkout_review_mut(),
                Some(CheckoutReview::Receipt(form)) if form.reconciliation.is_none()));
            root.status.connectivity = Connectivity::Online;
            cx.notify();
        });
        cx.run_until_parked();
        cx.simulate_keystrokes("tab");
        cx.simulate_event(gpui::KeyUpEvent {
            keystroke: gpui::Keystroke::parse("enter").unwrap(),
        });
        root.update(cx, |root, cx| {
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("expected the reviewed receipt");
            };
            let review = form
                .reconciliation
                .as_mut()
                .expect("Tab then Enter opens the bank payment review");
            assert!(review.command(cx).is_none());
            review
                .reference
                .update(cx, |field, cx| field.set_text("BANK-1234", cx));
            review.outcome = Some(BankPaymentOutcome::Failed);
            assert!(review.command(cx).is_some());
            review.needs_refresh = true;
            assert!(review.command(cx).is_none());
            data["payments"][0]["status"] = json!("succeeded");
            form.replace_receipt(serde_json::from_value(data).unwrap(), cx);
            assert!(form.reconciliation.is_none());
        });
    }
}
