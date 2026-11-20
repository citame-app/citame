use super::*;
use sob_core::billing::{RefundAttempt, RefundablePayment};

pub(super) struct RefundEditor {
    payment: RefundablePayment,
    amount: Entity<TextField>,
    reason: Entity<TextField>,
    _changes: [Subscription; 2],
    attempt: Option<RefundAttempt>,
    reviewed: bool,
}

impl RefundEditor {
    pub(super) fn has_attempt(&self) -> bool {
        self.attempt.is_some()
    }

    fn reviewed_amount(&self, receipt: &AppointmentCheckout, cx: &App) -> Option<u32> {
        let payment = receipt
            .recordable_refunds_available()
            .find(|payment| payment.id == self.payment.id)?;
        if payment.is_full_visit() {
            return Some(payment.available);
        }
        parse_reviewed_amount(self.amount.read(cx).text())
            .filter(|amount| (1..=payment.available).contains(amount))
    }

    fn valid_reason(&self, cx: &App) -> bool {
        (3..=300).contains(&self.reason.read(cx).text().trim().encode_utf16().count())
    }
}

impl Root {
    fn select_refund(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.busy
            || form.refreshing
            || form.request.is_some()
            || form.stock_return.is_some()
            || form.refund.is_some()
            || form.confirming_void
        {
            return;
        }
        let Some(payment) = form
            .receipt
            .recordable_refunds_available()
            .find(|payment| payment.id == id)
        else {
            return;
        };
        let amount = cx.new(|cx| TextField::new("EUR", false, cx));
        let reason = cx.new(|cx| TextField::new("", false, cx));
        let changes = [
            cx.observe(&amount, |_, _, cx| cx.notify()),
            cx.observe(&reason, |_, _, cx| cx.notify()),
        ];
        form.refund = Some(RefundEditor {
            payment,
            amount,
            reason,
            _changes: changes,
            attempt: None,
            reviewed: false,
        });
        form.error = None;
        cx.notify();
    }

    fn confirm_refund(&mut self, cx: &mut Context<Self>) {
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
        let Some(editor) = &mut form.refund else {
            return;
        };
        if form.busy || form.refreshing || !editor.reviewed {
            return;
        }
        let attempt = if let Some(attempt) = &editor.attempt {
            attempt.clone()
        } else {
            let Some(amount) = editor.reviewed_amount(&form.receipt, cx) else {
                return;
            };
            let Some(attempt) = RefundAttempt::new(amount, editor.reason.read(cx).text()) else {
                return;
            };
            editor.attempt = Some(attempt.clone());
            attempt
        };
        let receipt = form.receipt.clone();
        let payment_id = editor.payment.id;
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(
                    async move { transport.record_checkout_refund(&receipt, payment_id, &attempt) },
                )
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let message = root.t(Key::CheckoutRefundUnconfirmed);
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                let Some(editor) = &mut form.refund else {
                    return;
                };
                if editor.payment.id != payment_id {
                    return;
                }
                form.busy = false;
                match result {
                    Ok(receipt) => {
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx)
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                        form.refund = None;
                    }
                    Err(TransportError::BadRequest(error) | TransportError::Forbidden(error)) => {
                        editor.reviewed = false;
                        editor.attempt = None;
                        form.error = Some(error);
                        form.observed_revision = -1;
                    }
                    Err(_) => form.error = Some(message.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_void_receipt(&mut self, cx: &mut Context<Self>) {
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
        if !form.confirming_void || form.busy || form.refreshing || !form.receipt.can_void() {
            return;
        }
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.void_checkout(&receipt) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let message = root.t(Key::CheckoutVoidUnconfirmed);
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&form.receipt, &previous) {
                    return;
                }
                form.busy = false;
                match result {
                    Ok(receipt) => {
                        form.replace_receipt(receipt, cx);
                        form.confirming_void = false;
                    }
                    Err(TransportError::BadRequest(error) | TransportError::Forbidden(error)) => {
                        form.error = Some(error);
                        form.confirming_void = false;
                    }
                    Err(_) => form.error = Some(message.into()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_void_receipt(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let view = div();
        if form.receipt.status == "void" {
            return view.child(self.t(Key::SalesStatusVoid));
        }
        if form.confirming_void && form.busy {
            return view.child(self.t(Key::CheckoutLoading));
        }
        if self.status.connectivity != Connectivity::Online
            || form.busy
            || form.refreshing
            || form.request.is_some()
            || form.stock_return.is_some()
            || form.refund.is_some()
            || !form.receipt.can_void()
        {
            return view;
        }
        if form.confirming_void {
            return view
                .flex()
                .flex_wrap()
                .gap_2()
                .child(self.t(Key::CheckoutVoidReview))
                .child(self.button(
                    "confirm-void-receipt",
                    self.t(Key::CheckoutVoidConfirm),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| root.confirm_void_receipt(cx)),
                ))
                .child(self.button(
                    "cancel-void-receipt",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() {
                            form.confirming_void = false;
                            cx.notify();
                        }
                    }),
                ));
        }
        view.child(self.button(
            "review-void-receipt",
            self.t(Key::CheckoutVoid),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| {
                if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() {
                    form.confirming_void = true;
                    form.error = None;
                    cx.notify();
                }
            }),
        ))
    }

    pub(super) fn render_refunds(&self, form: &ReceiptForm, cx: &mut Context<Self>) -> gpui::Div {
        let receipt = &form.receipt;
        let online = self.status.connectivity == Connectivity::Online;
        let money = |amount| self.amount_label(i64::from(amount), &receipt.currency);
        let mut body = div().flex().flex_col().gap_2();
        if !receipt.refunds.is_empty() {
            body =
                body.child(self.label(Key::CheckoutRefunds))
                    .children(receipt.refunds.iter().map(|refund| {
                        let status = match refund.status.as_str() {
                            "succeeded" => Key::CheckoutRefundRecorded,
                            "failed" => Key::CheckoutRefundFailed,
                            _ => Key::CheckoutRefundPending,
                        };
                        div().text_sm().child(format!(
                            "{} · {} · {}",
                            self.t(status),
                            money(refund.amount_cents),
                            refund.reason
                        ))
                    }));
        }
        let Some(editor) = &form.refund else {
            return body.when(
                online
                    && !form.busy
                    && !form.refreshing
                    && form.request.is_none()
                    && form.stock_return.is_none()
                    && !form.confirming_void,
                |view| {
                    view.children(receipt.recordable_refunds_available().map(|payment| {
                        let id = payment.id;
                        self.button(
                            SharedString::from(format!("refund-{id}")),
                            format!(
                                "{} · {} · {}",
                                self.t(Key::CheckoutRefund),
                                self.t(tender_label(payment.tender)),
                                money(payment.available)
                            ),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.select_refund(id, cx)),
                        )
                    }))
                },
            );
        };
        body = body.child(self.label(Key::CheckoutRefund));
        if form.busy {
            return body.child(self.t(Key::CheckoutLoading));
        }
        if !online {
            return body.child(self.t(Key::CheckoutOffline));
        }
        if editor.reviewed {
            let amount = editor.reviewed_amount(receipt, cx);
            return body
                .when_some(amount, |view, cents| {
                    view.child(format!(
                        "{} · {}",
                        self.t(tender_label(editor.payment.tender)),
                        money(cents)
                    ))
                    .child(editor.reason.read(cx).text().trim().to_owned())
                })
                .child(self.button(
                    "confirm-checkout-refund",
                    self.t(if editor.has_attempt() {
                        Key::CheckoutRefundRetry
                    } else {
                        Key::CheckoutRefundConfirm
                    }),
                    Kind::Danger,
                    cx.listener(|root, _, _, cx| root.confirm_refund(cx)),
                ))
                .when(!editor.has_attempt(), |view| {
                    view.child(self.button(
                        "edit-checkout-refund",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                                && let Some(editor) = &mut form.refund
                            {
                                editor.reviewed = false;
                                cx.notify();
                            }
                        }),
                    ))
                });
        }
        body.child(self.label(Key::CheckoutAmount))
            .map(|view| {
                if editor.payment.is_full_visit() {
                    view.child(money(editor.payment.available))
                } else {
                    view.child(editor.amount.clone())
                }
            })
            .child(self.label(Key::CheckoutRefundReason))
            .child(editor.reason.clone())
            .when(
                editor.reviewed_amount(receipt, cx).is_some()
                    && editor.valid_reason(cx)
                    && !form.refreshing,
                |view| {
                    view.child(self.button(
                        "review-checkout-refund",
                        self.t(Key::CheckoutRefundReview),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                                && let Some(editor) = &mut form.refund
                            {
                                editor.reviewed = true;
                                cx.notify();
                            }
                        }),
                    ))
                },
            )
            .child(self.button(
                "cancel-checkout-refund",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() {
                        form.refund = None;
                        form.error = None;
                        cx.notify();
                    }
                }),
            ))
    }
}
