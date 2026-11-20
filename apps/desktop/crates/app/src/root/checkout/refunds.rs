use super::*;
use sob_core::billing::{RefundAttempt, RefundTender, RefundablePayment};

mod bank_refund_recovery;
mod pass_quote;

fn refund_tender_label(tender: RefundTender) -> Key {
    match tender {
        RefundTender::Manual(method) => tender_label(method),
        RefundTender::Bank(method) => reconciliation::bank_method_label(method),
    }
}

pub(super) struct RefundEditor {
    payment: RefundablePayment,
    amount_or_visits: Entity<TextField>,
    reason: Entity<TextField>,
    _changes: [Subscription; 2],
    attempt: Option<RefundAttempt>,
    reviewed: bool,
    bank_generation: Option<String>,
    pass_quote: Option<pass_quote::QuotedPassRefund>,
    pass_quote_request: Option<Arc<()>>,
}

impl RefundEditor {
    pub(super) fn receipt_changed(&mut self, generation: Option<&str>) {
        if self.bank_generation.is_some() && self.bank_generation.as_deref() != generation {
            self.reviewed = false;
            self.bank_generation = None;
        }
        if self
            .pass_quote
            .as_ref()
            .is_some_and(|quote| Some(quote.generation.as_str()) != generation)
        {
            self.pass_quote = None;
            self.attempt = None;
            self.reviewed = false;
        }
    }
    pub(super) fn has_attempt(&self) -> bool {
        self.attempt.is_some()
    }

    fn reviewed_amount(&self, receipt: &AppointmentCheckout, cx: &App) -> Option<u32> {
        let payment = receipt
            .recordable_refunds_available()
            .find(|payment| payment.id == self.payment.id)?;
        if payment.pass_period_id.is_some() {
            return self
                .active_pass_quote(receipt, cx)
                .map(|quote| quote.terms.amount_cents)
                .filter(|amount| payment.covers_amount(*amount));
        }
        if payment.is_full_visit() {
            return Some(payment.available);
        }
        parse_reviewed_amount(self.amount_or_visits.read(cx).text())
            .filter(|amount| payment.covers_amount(*amount))
    }

    fn valid_reason(&self, cx: &App) -> bool {
        (3..=300).contains(&self.reason.read(cx).text().trim().encode_utf16().count())
    }

    fn reviewed_attempt(&self, receipt: &AppointmentCheckout, cx: &App) -> Option<RefundAttempt> {
        let amount = self.reviewed_amount(receipt, cx)?;
        let reason = self.reason.read(cx).text();
        if let Some(period_id) = self.payment.pass_period_id {
            let quote = self.active_pass_quote(receipt, cx)?;
            RefundAttempt::from_pass_quote(
                &quote.terms,
                reason,
                period_id,
                quote.generation.clone(),
            )
        } else {
            RefundAttempt::new(amount, reason)
        }
    }
}

impl Root {
    fn select_refund(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if !form.is_idle() || form.refreshing {
            return;
        }
        let Some(payment) = form
            .receipt
            .recordable_refunds_available()
            .find(|payment| payment.id == id)
        else {
            return;
        };
        let amount_or_visits = cx.new(|cx| {
            let mut field = TextField::new(
                if payment.pass_period_id.is_some() {
                    ""
                } else {
                    "EUR"
                },
                false,
                cx,
            );
            if payment.pass_period_id.is_some() {
                field.set_text("0", cx);
            }
            field
        });
        let reason = cx.new(|cx| TextField::new("", false, cx));
        let changes = [
            cx.observe(&amount_or_visits, |_, _, cx| cx.notify()),
            cx.observe(&reason, |_, _, cx| cx.notify()),
        ];
        form.refund = Some(RefundEditor {
            payment,
            amount_or_visits,
            reason,
            _changes: changes,
            attempt: None,
            reviewed: false,
            bank_generation: None,
            pass_quote: None,
            pass_quote_request: None,
        });
        form.error = None;
        cx.notify();
    }

    fn confirm_refund(&mut self, cx: &mut Context<Self>) {
        if matches!(self.checkout_review_mut(), Some(CheckoutReview::Receipt(form))
            if form.refund.as_ref().is_some_and(|editor| matches!(editor.payment.tender, RefundTender::Bank(_))))
        {
            self.save_reviewed_bank_refund(cx);
            return;
        }
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
            let Some(attempt) = editor.reviewed_attempt(&form.receipt, cx) else {
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
                let quote_failed = root.t(Key::CheckoutPassRefundQuoteFailed);
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
                        editor.pass_quote = None;
                        form.error = Some(if editor.payment.pass_period_id.is_some() {
                            quote_failed.to_owned()
                        } else {
                            error
                        });
                        form.observed_revision = -1;
                    }
                    Err(TransportError::ReplicaGenerationChanged) => {
                        editor.reviewed = false;
                        editor.attempt = None;
                        editor.pass_quote = None;
                        form.error = Some(message.to_owned());
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
                            "failed" if refund.cancelled_at.is_some() => {
                                Key::CheckoutBankRefundCancelled
                            }
                            "failed" => Key::CheckoutRefundFailed,
                            "requested" => Key::CheckoutBankRefundReserved,
                            _ => Key::CheckoutRefundPending,
                        };
                        let view = div().text_sm().child(format!(
                            "{} · {} · {}",
                            self.t(status),
                            money(refund.amount_cents),
                            refund.reason
                        ));
                        view.when_some(refund.cancelled_at, |view, cancelled_at| {
                            let local = cancelled_at.with_timezone(&self.tz);
                            view.child(div().child(format!(
                                "{} · {} · #{:08x}",
                                i18n::date_label(self.locale, local.date_naive()),
                                local.format("%H:%M"),
                                refund.id.as_u128() as u32,
                            )))
                        })
                    }));
        }
        let Some(editor) = &form.refund else {
            let saved = self.render_saved_bank_refund(form, cx);
            let has_saved = saved.is_some();
            let body = body.when_some(saved, |view, saved| view.child(saved));
            return body.when(
                online
                    && !form.busy
                    && !form.refreshing
                    && form.request.is_none()
                    && form.stock_return.is_none()
                    && !form.confirming_void,
                |view| {
                    view.children(
                        receipt
                            .recordable_refunds_available()
                            .filter(|payment| {
                                (payment.pass_period_id.is_none()
                                    || receipt.refund_review_generation.is_some())
                                    && (!matches!(payment.tender, RefundTender::Bank(_))
                                        || (!has_saved
                                            && receipt.refund_review_generation.is_some()))
                            })
                            .map(|payment| {
                                let id = payment.id;
                                self.checkout_keyboard_button(
                                    SharedString::from(format!("refund-{id}")),
                                    format!(
                                        "{} · {} · {}",
                                        self.t(Key::CheckoutRefund),
                                        self.t(refund_tender_label(payment.tender)),
                                        money(payment.available)
                                    ),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| root.select_refund(id, cx)),
                                )
                            }),
                    )
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
            let amount = editor
                .attempt
                .as_ref()
                .map(RefundAttempt::amount_cents)
                .or_else(|| editor.reviewed_amount(receipt, cx));
            return body
                .when_some(amount, |view, cents| {
                    view.child(format!(
                        "{} · {}",
                        self.t(refund_tender_label(editor.payment.tender)),
                        money(cents)
                    ))
                    .child(editor.reason.read(cx).text().trim().to_owned())
                })
                .when_some(editor.active_pass_quote(receipt, cx), |view, quote| {
                    view.child(format!(
                        "{} · {}",
                        self.t(Key::CheckoutPassRefundVisits),
                        quote.terms.unit_count
                    ))
                    .when(quote.terms.access_fee, |view| {
                        view.child(self.t(Key::CheckoutPassRefundAccessFee))
                    })
                })
                .when(
                    amount.is_none() && editor.payment.pass_period_id.is_some(),
                    |view| view.child(self.t(Key::CheckoutPassRefundQuoteFailed)),
                )
                .when(amount.is_some() && !form.refreshing, |view| {
                    view.child(self.checkout_keyboard_button(
                        "confirm-checkout-refund",
                        self.t(match (editor.has_attempt(), editor.payment.tender) {
                            (true, _) => Key::CheckoutRefundRetry,
                            (false, RefundTender::Bank(_)) => Key::CheckoutBankRefundReserve,
                            (false, RefundTender::Manual(_)) => Key::CheckoutRefundConfirm,
                        }),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| root.confirm_refund(cx)),
                    ))
                })
                .when(!editor.has_attempt(), |view| {
                    view.child(self.checkout_keyboard_button(
                        "edit-checkout-refund",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                                && let Some(editor) = &mut form.refund
                            {
                                editor.reviewed = false;
                                editor.bank_generation = None;
                                editor.pass_quote = None;
                                cx.notify();
                            }
                        }),
                    ))
                });
        }
        body.map(|view| {
            if editor.payment.pass_period_id.is_some() {
                return view.child(self.render_pass_refund_quote(form, editor, cx));
            }
            let view = view.child(self.label(Key::CheckoutAmount));
            if editor.payment.is_full_visit() {
                view.child(money(editor.payment.available))
            } else {
                view.child(editor.amount_or_visits.clone())
            }
        })
        .child(self.label(Key::CheckoutRefundReason))
        .child(editor.reason.clone())
        .when(
            editor.reviewed_amount(receipt, cx).is_some()
                && editor.valid_reason(cx)
                && !form.refreshing,
            |view| {
                let generation = receipt.refund_review_generation.clone();
                view.child(self.checkout_keyboard_button(
                    "review-checkout-refund",
                    self.t(Key::CheckoutRefundReview),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                            && let Some(editor) = &mut form.refund
                        {
                            if matches!(editor.payment.tender, RefundTender::Bank(_)) {
                                if form.receipt.refund_review_generation != generation {
                                    return;
                                }
                                editor.bank_generation = generation.clone();
                            }
                            editor.reviewed = true;
                            cx.notify();
                        }
                    }),
                ))
            },
        )
        .child(self.checkout_keyboard_button(
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
