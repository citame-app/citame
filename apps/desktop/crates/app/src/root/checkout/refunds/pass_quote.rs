use super::*;
use sob_core::billing::PassRefundQuote;

pub(super) struct QuotedPassRefund {
    pub(super) generation: String,
    pub(super) terms: PassRefundQuote,
}

impl RefundEditor {
    fn requested_visits(&self, cx: &App) -> Option<u32> {
        PassRefundQuote::parse_visit_count(self.amount_or_visits.read(cx).text())
    }

    pub(super) fn active_pass_quote(
        &self,
        receipt: &AppointmentCheckout,
        cx: &App,
    ) -> Option<&QuotedPassRefund> {
        self.pass_quote.as_ref().filter(|quote| {
            receipt.refund_review_generation.as_deref() == Some(quote.generation.as_str())
                && self.requested_visits(cx) == Some(quote.terms.unit_count)
        })
    }
}

impl Root {
    fn quote_pass_refund(&mut self, cx: &mut Context<Self>) {
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
        let Some(editor) = &mut form.refund else {
            return;
        };
        if editor.payment.pass_period_id.is_none()
            || editor.reviewed
            || editor.pass_quote_request.is_some()
        {
            return;
        }
        let Some(generation) = form.receipt.refund_review_generation.clone() else {
            return;
        };
        let Some(units) = editor.requested_visits(cx) else {
            return;
        };
        let payment_id = editor.payment.id;
        let request = Arc::new(());
        let receipt = form.receipt.clone();
        editor.pass_quote_request = Some(request.clone());
        editor.pass_quote = None;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.quote_pass_refund(&receipt, payment_id, units) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let unknown = root.t(Key::CheckoutPassRefundQuoteFailed);
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                let Some(editor) = &mut form.refund else {
                    return;
                };
                if !editor
                    .pass_quote_request
                    .as_ref()
                    .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                {
                    return;
                }
                editor.pass_quote_request = None;
                if form.receipt.refund_review_generation.as_deref() == Some(generation.as_str())
                    && editor.requested_visits(cx) == Some(units)
                {
                    match result {
                        Ok(terms) => {
                            editor.pass_quote = Some(QuotedPassRefund { generation, terms })
                        }
                        Err(_) => form.error = Some(unknown.to_owned()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_pass_refund_quote(
        &self,
        form: &ReceiptForm,
        editor: &RefundEditor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child(self.t(Key::CheckoutPassRefundHelp)))
            .child(self.label(Key::CheckoutPassRefundVisits))
            .child(editor.amount_or_visits.clone());
        if editor.pass_quote_request.is_some() {
            return body.child(self.t(Key::CheckoutLoading));
        }
        let quote = editor.active_pass_quote(&form.receipt, cx);
        body.when_some(quote, |view, quote| {
            let money = |amount| self.amount_label(i64::from(amount), &form.receipt.currency);
            view.child(format!(
                "{} · {}",
                self.t(Key::CheckoutAmount),
                money(quote.terms.amount_cents)
            ))
            .child(format!(
                "{} · {}",
                self.t(Key::CheckoutPassRefundAvailable),
                quote.terms.available_uses
            ))
            .when(quote.terms.excess_cents > 0, |view| {
                view.child(format!(
                    "{} · {}",
                    self.t(Key::CheckoutOverpaid),
                    money(quote.terms.excess_cents)
                ))
            })
            .when(quote.terms.access_fee, |view| {
                view.child(self.t(Key::CheckoutPassRefundAccessFee))
            })
        })
        .when(
            editor.requested_visits(cx).is_some() && !form.refreshing,
            |view| {
                view.child(self.checkout_keyboard_button(
                    "quote-pass-refund",
                    self.t(Key::CheckoutPassRefundQuote),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.quote_pass_refund(cx)),
                ))
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn editing_visits_or_restoring_the_receipt_invalidates_review(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let payment = Uuid::now_v7();
        let period = Uuid::now_v7();
        let receipt_id = Uuid::now_v7();
        let receipt = |generation| {
            serde_json::from_value(json!({
                "id": receipt_id, "currency": "EUR", "status": "paid", "canRefund": true,
                "refundReviewGeneration": generation, "totalCents": 1000, "discountCents": 0,
                "paidCents": 1000, "balanceCents": 0,
                "lines": [{ "id": Uuid::now_v7(), "passPeriodId": period,
                    "description": "Three visits", "quantity": 1, "unitAmountCents": 1000 }],
                "payments": [{ "id": payment, "method": "external_card", "status": "succeeded",
                    "amountCents": 1000 }],
            }))
            .unwrap()
        };
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.overlay =
                Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt("before"), 0, cx));
            root.select_refund(payment, cx);
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("receipt missing");
            };
            let editor = form.refund.as_mut().unwrap();
            editor
                .reason
                .update(cx, |field, cx| field.set_text("Unused visit", cx));
            editor
                .amount_or_visits
                .update(cx, |field, cx| field.set_text("1", cx));
            editor.pass_quote = Some(QuotedPassRefund {
                generation: "before".into(),
                terms: PassRefundQuote {
                    amount_cents: 334,
                    unit_count: 1,
                    excess_cents: 0,
                    available_uses: 3,
                    access_fee: false,
                },
            });
            let attempt = editor.reviewed_attempt(&form.receipt, cx).unwrap();
            assert_eq!(attempt.amount_cents(), 334);
            assert_eq!(attempt.pass_selection().unwrap().unit_count, 1);
            editor
                .amount_or_visits
                .update(cx, |field, cx| field.set_text("2", cx));
            assert!(editor.reviewed_attempt(&form.receipt, cx).is_none());
            editor.attempt = Some(attempt);
            editor.reviewed = true;
            form.replace_receipt(receipt("after"), cx);
            let editor = form.refund.as_ref().unwrap();
            assert!(!editor.reviewed);
            assert!(editor.pass_quote.is_none());
            assert!(!editor.has_attempt());
        });
    }
}
