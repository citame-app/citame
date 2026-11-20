use super::*;
use sob_core::billing::{
    BankPaymentMethod, BankPaymentOutcome, BankPaymentReconciliation, BankRefund, BankRefundAction,
    PendingBankPayment,
};

struct BankReviewPresentation {
    title: Key,
    instructions: Key,
    requires_evidence: bool,
    id: &'static str,
}

#[derive(Clone)]
enum BankReviewTarget {
    Payment(PendingBankPayment),
    Refund(BankRefund),
}

impl BankReviewTarget {
    fn id(&self) -> Uuid {
        match self {
            Self::Payment(payment) => payment.id,
            Self::Refund(refund) => refund.id,
        }
    }
    fn presentation(&self) -> BankReviewPresentation {
        match self {
            Self::Payment(_) => BankReviewPresentation {
                title: Key::CheckoutBankReconcile,
                instructions: Key::CheckoutBankReviewHelp,
                requires_evidence: true,
                id: "payment-review",
            },
            Self::Refund(refund) => match refund.action {
                BankRefundAction::Dispatch => BankReviewPresentation {
                    title: Key::CheckoutBankRefundSend,
                    instructions: Key::CheckoutBankRefundSendHelp,
                    requires_evidence: false,
                    id: "refund-dispatch",
                },
                BankRefundAction::Cancel => BankReviewPresentation {
                    title: Key::CheckoutBankRefundCancel,
                    instructions: Key::CheckoutBankRefundCancelHelp,
                    requires_evidence: false,
                    id: "refund-cancel",
                },
                BankRefundAction::Reconcile => BankReviewPresentation {
                    title: Key::CheckoutBankRefundReconcile,
                    instructions: Key::CheckoutBankRefundReviewHelp,
                    requires_evidence: true,
                    id: "refund-review",
                },
            },
        }
    }

    fn remains_eligible(&self, receipt: &AppointmentCheckout) -> bool {
        match self {
            BankReviewTarget::Payment(payment) => receipt
                .reconcilable_bank_payments(Utc::now())
                .any(|candidate| candidate == *payment),
            BankReviewTarget::Refund(refund) => receipt
                .reviewable_bank_refunds(Utc::now())
                .any(|candidate| candidate == *refund),
        }
    }
}

pub(super) struct BankTransactionReview {
    target: BankReviewTarget,
    reference: Entity<TextField>,
    outcome: Option<BankPaymentOutcome>,
    pub(super) needs_refresh: bool,
    _changed: Subscription,
}

enum BankTransactionCommand {
    ReconcilePayment(Uuid, BankPaymentReconciliation),
    DispatchRefund(Uuid),
    CancelRefund(Uuid),
    ReconcileRefund(Uuid, BankPaymentReconciliation),
}

impl BankTransactionReview {
    pub(super) fn remains_eligible(&self, receipt: &AppointmentCheckout) -> bool {
        self.target.remains_eligible(receipt)
    }

    fn command(&self, cx: &App) -> Option<BankPaymentReconciliation> {
        if self.needs_refresh {
            return None;
        }
        BankPaymentReconciliation::new(self.outcome?, self.reference.read(cx).text())
    }

    fn submission(&self, cx: &App) -> Option<BankTransactionCommand> {
        if self.needs_refresh {
            return None;
        }
        Some(match &self.target {
            BankReviewTarget::Payment(payment) => {
                BankTransactionCommand::ReconcilePayment(payment.id, self.command(cx)?)
            }
            BankReviewTarget::Refund(refund) => match refund.action {
                BankRefundAction::Dispatch => BankTransactionCommand::DispatchRefund(refund.id),
                BankRefundAction::Cancel => BankTransactionCommand::CancelRefund(refund.id),
                BankRefundAction::Reconcile => {
                    BankTransactionCommand::ReconcileRefund(refund.id, self.command(cx)?)
                }
            },
        })
    }
}

pub(super) fn bank_method_label(method: BankPaymentMethod) -> Key {
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

    fn review_bank_transaction(
        &mut self,
        select: impl FnOnce(&AppointmentCheckout) -> Option<BankReviewTarget>,
        cx: &mut Context<Self>,
    ) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if !form.is_idle() || form.refreshing || form.pass_picker.is_some() {
            return;
        }
        let Some(target) = select(&form.receipt) else {
            return;
        };
        let reference = cx.new(|cx| TextField::new("", false, cx));
        let changed = cx.observe(&reference, |_, _, cx| cx.notify());
        form.reconciliation = Some(BankTransactionReview {
            target,
            reference,
            outcome: None,
            needs_refresh: false,
            _changed: changed,
        });
        form.error = None;
        form.bank_outcome_changed = false;
        cx.notify();
    }

    fn confirm_bank_transaction(&mut self, cx: &mut Context<Self>) {
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
        let Some(command) = review.submission(cx) else {
            return;
        };
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match command {
                        BankTransactionCommand::ReconcilePayment(id, command) => transport
                            .reconcile_bank_payment(&receipt, id, &command)
                            .map(|result| (result.receipt, result.bank_outcome_changed)),
                        BankTransactionCommand::ReconcileRefund(id, command) => transport
                            .reconcile_bank_refund(&receipt, id, &command)
                            .map(|receipt| (receipt, false)),
                        BankTransactionCommand::DispatchRefund(id) => transport
                            .dispatch_bank_refund(&receipt, id)
                            .map(|receipt| (receipt, false)),
                        BankTransactionCommand::CancelRefund(id) => transport
                            .cancel_bank_refund(&receipt, id)
                            .map(|receipt| (receipt, false)),
                    }
                })
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
                    Ok((receipt, bank_outcome_changed)) => {
                        form.bank_outcome_changed = bank_outcome_changed;
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

    pub(super) fn render_bank_transaction_review(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div().flex().flex_col().gap_2();
        let online = self.status.connectivity == Connectivity::Online;
        let describe = |target: &BankReviewTarget| {
            let (label, amount, order) = match target {
                BankReviewTarget::Payment(payment) => (
                    if payment.merchant_initiated {
                        Key::CheckoutAutomaticBankPayment
                    } else {
                        bank_method_label(payment.method)
                    },
                    payment.amount_cents,
                    payment.bank_order.as_str(),
                ),
                BankReviewTarget::Refund(refund) => (
                    bank_method_label(refund.method),
                    refund.amount_cents,
                    refund.bank_order.as_deref().unwrap_or("—"),
                ),
            };
            format!(
                "{} · {} · {} {}",
                self.t(label),
                self.amount_label(i64::from(amount), &form.receipt.currency),
                self.t(Key::CheckoutBankOrder),
                order
            )
        };
        let Some(review) = &form.reconciliation else {
            return body.when(
                online && form.is_idle() && !form.refreshing && form.pass_picker.is_none(),
                |view| {
                    let now = Utc::now();
                    let actions = form
                        .receipt
                        .reconcilable_bank_payments(now)
                        .map(BankReviewTarget::Payment)
                        .chain(
                            form.receipt
                                .reviewable_bank_refunds(now)
                                .map(BankReviewTarget::Refund),
                        );
                    view.children(actions.map(|target| {
                        let id = target.id();
                        let presentation = target.presentation();
                        let detail = match &target {
                            BankReviewTarget::Refund(refund) => format!(
                                "{} · #{:08x}",
                                self.amount_label(
                                    i64::from(refund.amount_cents),
                                    &form.receipt.currency
                                ),
                                refund.id.as_u128() as u32
                            ),
                            BankReviewTarget::Payment(_) => describe(&target),
                        };
                        self.checkout_keyboard_button(
                            SharedString::from(format!("bank-action-{}-{id}", presentation.id)),
                            format!("{} · {detail}", self.t(presentation.title)),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.review_bank_transaction(
                                    |receipt| {
                                        target.remains_eligible(receipt).then(|| target.clone())
                                    },
                                    cx,
                                )
                            }),
                        )
                    }))
                },
            );
        };
        let presentation = review.target.presentation();
        let body = body
            .child(self.label(presentation.title))
            .child(describe(&review.target))
            .map(|view| match &review.target {
                BankReviewTarget::Refund(refund) => view
                    .child(div().text_sm().child(format!(
                        "{} · {}",
                        self.t(Key::CheckoutBankRefundId),
                        refund.id
                    )))
                    .child(div().text_sm().child(refund.reason.clone())),
                BankReviewTarget::Payment(_) => view,
            })
            .child(div().text_sm().child(self.t(presentation.instructions)));
        let is_refund = matches!(&review.target, BankReviewTarget::Refund(_));
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
                online
                    && !form.refreshing
                    && !review.needs_refresh
                    && !presentation.requires_evidence,
                |view| {
                    view.child(self.checkout_keyboard_button(
                        "confirm-bank-refund-action",
                        self.t(presentation.title),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| root.confirm_bank_transaction(cx)),
                    ))
                },
            )
            .when(
                online
                    && !form.refreshing
                    && !review.needs_refresh
                    && presentation.requires_evidence,
                |view| {
                    view.child(self.label(Key::CheckoutBankReference))
                        .child(review.reference.clone())
                        .child(
                            div().flex().flex_wrap().gap_2().children(
                                [
                                    (
                                        BankPaymentOutcome::Succeeded,
                                        if is_refund {
                                            Key::CheckoutBankRefundSucceeded
                                        } else {
                                            Key::CheckoutBankPaid
                                        },
                                        "bank-paid",
                                    ),
                                    (
                                        BankPaymentOutcome::Failed,
                                        if is_refund {
                                            Key::CheckoutBankRefundNotSent
                                        } else {
                                            Key::CheckoutBankUnpaid
                                        },
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
                                cx.listener(|root, _, _, cx| root.confirm_bank_transaction(cx)),
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
    async fn keyboard_opens_an_exact_cancellation_review_without_dispatching(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let payment = Uuid::now_v7();
        let refund = Uuid::now_v7();
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            let receipt = serde_json::from_value(json!({
                "id": Uuid::now_v7(), "currency": "EUR", "status": "paid", "canRefund": true,
                "totalCents": 2000, "discountCents": 0, "paidCents": 2000, "balanceCents": 0,
                "payments": [{"id": payment, "method": "redsys_bizum", "status": "succeeded", "amountCents": 2000}],
                "refunds": [{"id": refund, "paymentId": payment, "amountCents": 500,
                    "reason": "Incorrect amount", "status":"requested"}]
            })).unwrap();
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt, 0, cx));
            cx.notify();
        });
        cx.run_until_parked();
        cx.simulate_keystrokes("tab");
        cx.simulate_event(gpui::KeyUpEvent {
            keystroke: gpui::Keystroke::parse("enter").unwrap(),
        });
        root.update(cx, |root, cx| {
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("expected receipt")
            };
            let review = form
                .reconciliation
                .as_ref()
                .expect("cancellation review opened");
            assert!(!form.busy);
            assert!(matches!(review.submission(cx),
                Some(BankTransactionCommand::CancelRefund(id)) if id == refund));
        });
    }

    #[gpui::test]
    async fn a_requested_refund_needs_its_own_review_and_an_uncertain_dispatch_cannot_be_resent(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let payment_id = Uuid::now_v7();
        let refund_id = Uuid::now_v7();
        let mut data = json!({
            "id": Uuid::now_v7(), "currency": "EUR", "status": "paid",
            "canRefund": true, "canDispatchBankRefunds": true,
            "totalCents": 1800, "discountCents": 0, "paidCents": 1800, "balanceCents": 0,
            "payments": [{"id": payment_id, "method": "redsys_card", "status": "succeeded",
                "amountCents": 1800, "order": "123412345678"}],
            "refunds": [{"id": refund_id, "paymentId": payment_id, "amountCents": 900,
                "reason": "Treatment adjustment", "status": "requested"}]
        });
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            let receipt = serde_json::from_value(data.clone()).unwrap();
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt, 0, cx));
            assert!(matches!(root.checkout_review_mut(),
                Some(CheckoutReview::Receipt(form)) if form.reconciliation.is_none()));
            cx.notify();
        });
        cx.run_until_parked();
        cx.simulate_keystrokes("tab");
        cx.simulate_event(gpui::KeyUpEvent {
            keystroke: gpui::Keystroke::parse("enter").unwrap(),
        });
        root.update(cx, |root, cx| {
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("expected receipt");
            };
            let review = form.reconciliation.as_mut().expect("refund review opened");
            assert!(matches!(review.submission(cx), Some(BankTransactionCommand::DispatchRefund(id)) if id == refund_id));
            review.needs_refresh = true;
            assert!(review.submission(cx).is_none());
            data["refunds"][0]["status"] = json!("reconciliation");
            data["refunds"][0]["reconcileAfter"] = json!((Utc::now() - Span::seconds(1)).to_rfc3339());
            form.replace_receipt(serde_json::from_value(data).unwrap(), cx);
            assert!(form.reconciliation.is_none());
            assert!(form.receipt.reviewable_bank_refunds(Utc::now())
                .any(|refund| refund.id == refund_id && refund.action == BankRefundAction::Reconcile));
        });
    }

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
            root.review_bank_transaction(
                |receipt| {
                    receipt
                        .reconcilable_bank_payments(Utc::now())
                        .find(|payment| payment.id == payment_id)
                        .map(BankReviewTarget::Payment)
                },
                cx,
            );
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
