use super::*;
use sob_core::billing::{
    BankRefundReviewContext, ReviewedBankRefund, SavedBankRefund, SavedBankRefundStatus,
};

impl Root {
    pub(super) fn save_reviewed_bank_refund(&mut self, cx: &mut Context<Self>) {
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let store_error = self.t(Key::CheckoutBankRefundStoreError);
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        let Some(editor) = &form.refund else { return };
        if form.busy || form.refreshing || !editor.reviewed {
            return;
        }
        let RefundTender::Bank(method) = editor.payment.tender else {
            return;
        };
        let Ok(checkout_id) = form.receipt.id.parse() else {
            return;
        };
        let Some(generation) = editor.bank_generation.clone() else {
            return;
        };
        if form.receipt.refund_review_generation.as_deref() != Some(generation.as_str()) {
            return;
        }
        let Some(attempt) = editor.reviewed_attempt(&form.receipt, cx) else {
            return;
        };
        let saved = SavedBankRefund {
            payment_id: editor.payment.id,
            method,
            request: ReviewedBankRefund {
                attempt,
                review: BankRefundReviewContext {
                    checkout_id,
                    actor_user_id: actor.user_id,
                    generation,
                },
            },
        };
        match self.svc.store.reserve_bank_refund(&saved) {
            Ok(true) => {
                form.refund = None;
                self.resume_bank_refund(cx);
            }
            Ok(false) => {
                // A different window already saved a review. Show that exact payload.
                form.refund = None;
                cx.notify();
            }
            Err(_) => {
                form.error = Some(store_error.to_owned());
                cx.notify();
            }
        }
    }

    fn resume_bank_refund(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        if !form.is_idle() || form.refreshing {
            return;
        }
        let Ok(checkout_id) = form.receipt.id.parse() else {
            return;
        };
        let Ok(Some(saved)) = self
            .svc
            .store
            .pending_bank_refund(checkout_id, &actor.user_id)
        else {
            return;
        };
        if saved.status(&form.receipt) != SavedBankRefundStatus::Ready {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let receipt = form.receipt.clone();
        let previous = receipt.clone();
        let request = saved.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.record_reviewed_bank_refund(&receipt, &request) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let unconfirmed = root.t(Key::CheckoutRefundUnconfirmed);
                let store_error = root.t(Key::CheckoutBankRefundStoreError);
                let quote_failed = root.t(Key::CheckoutPassRefundQuoteFailed);
                let cleared = root.svc.store.settle_bank_refund(&saved, &result).is_ok();
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&previous, &form.receipt) {
                    return;
                }
                form.busy = false;
                if !cleared {
                    form.error = Some(store_error.to_owned());
                    cx.notify();
                    return;
                }
                match result {
                    Ok(receipt) => {
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx)
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                    }
                    Err(TransportError::ReplicaGenerationChanged) => {
                        form.observed_revision = -1;
                        form.error = Some(unconfirmed.to_owned());
                    }
                    Err(TransportError::BadRequest(error) | TransportError::Forbidden(error)) => {
                        form.error = Some(if saved.request.attempt.pass_selection().is_some() {
                            quote_failed.to_owned()
                        } else {
                            error
                        });
                    }
                    Err(_) => form.error = Some(unconfirmed.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn discard_obsolete_bank_refund(&mut self, cx: &mut Context<Self>) {
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let store_error = self.t(Key::CheckoutBankRefundStoreError);
        let Some(CheckoutReview::Receipt(form)) = Self::checkout_review_in(&mut self.overlay)
        else {
            return;
        };
        if form.busy || form.refreshing {
            return;
        }
        let Ok(checkout_id) = form.receipt.id.parse() else {
            return;
        };
        let Ok(Some(saved)) = self
            .svc
            .store
            .pending_bank_refund(checkout_id, &actor.user_id)
        else {
            return;
        };
        if saved.status(&form.receipt) != SavedBankRefundStatus::Obsolete {
            return;
        }
        form.error = self
            .svc
            .store
            .clear_bank_refund(&saved)
            .err()
            .map(|_| store_error.to_owned());
        cx.notify();
    }

    pub(super) fn render_saved_bank_refund(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> Option<gpui::Div> {
        let actor = self.svc.current_session()?;
        let checkout_id = form.receipt.id.parse().ok()?;
        let saved = match self
            .svc
            .store
            .pending_bank_refund(checkout_id, &actor.user_id)
        {
            Ok(saved) => saved?,
            Err(_) => {
                return Some(
                    div()
                        .text_sm()
                        .child(self.t(Key::CheckoutBankRefundStoreError)),
                );
            }
        };
        let body = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::CheckoutBankRefundRecovered))
            .child(format!(
                "{} · {}",
                self.t(reconciliation::bank_method_label(saved.method)),
                self.amount_label(
                    i64::from(saved.request.attempt.amount_cents()),
                    &form.receipt.currency
                ),
            ))
            .child(
                div()
                    .text_sm()
                    .child(saved.request.attempt.reason().to_owned()),
            )
            .when_some(saved.request.attempt.pass_selection(), |view, selection| {
                view.child(format!(
                    "{} · {}",
                    self.t(Key::CheckoutPassRefundVisits),
                    selection.unit_count
                ))
            });
        if form.busy || form.refreshing {
            return Some(body.child(self.t(Key::CheckoutLoading)));
        }
        match saved.status(&form.receipt) {
            SavedBankRefundStatus::Unavailable => {
                return Some(body.child(self.t(Key::CheckoutBankRefundUnavailable)));
            }
            SavedBankRefundStatus::Obsolete => {
                return Some(body.child(self.t(Key::CheckoutBankRefundRestored)).child(
                    self.checkout_keyboard_button(
                        "discard-obsolete-bank-refund",
                        self.t(Key::CheckoutBankRefundDiscard),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.discard_obsolete_bank_refund(cx)),
                    ),
                ));
            }
            SavedBankRefundStatus::Ready => {}
        }
        if self.status.connectivity != Connectivity::Online {
            return Some(body.child(self.t(Key::CheckoutOffline)));
        }
        Some(body.child(self.checkout_keyboard_button(
            "resume-bank-refund",
            self.t(Key::CheckoutBankRefundResume),
            Kind::Primary,
            cx.listener(|root, _, _, cx| root.resume_bank_refund(cx)),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sob_core::billing::BankPaymentMethod;

    #[gpui::test]
    async fn a_restored_receipt_blocks_the_old_review_until_the_operator_discards_it(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let id = Uuid::now_v7();
        let saved = SavedBankRefund {
            payment_id: Uuid::now_v7(),
            method: BankPaymentMethod::Bizum,
            request: ReviewedBankRefund {
                attempt: RefundAttempt::new(1400, "Synthetic pending reservation").unwrap(),
                review: BankRefundReviewContext {
                    checkout_id: id,
                    actor_user_id: "u".into(),
                    generation: "before".into(),
                },
            },
        };
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            assert!(root.svc.store.reserve_bank_refund(&saved).unwrap());
            root.status.connectivity = Connectivity::Online;
            let receipt = serde_json::from_value(json!({
                "id": id, "currency": "EUR", "status":"paid", "canRefund":true,
                "refundReviewGeneration":"restored", "totalCents":1400,
                "paidCents":1400, "balanceCents":0, "discountCents":0, "payments":[],
            }))
            .unwrap();
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt, 0, cx));
            root
        });
        root.update(cx, |root, cx| {
            let pending = root.svc.store.pending_bank_refund(id, "u").unwrap().unwrap();
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else { panic!("receipt missing") };
            assert_eq!(pending.status(&form.receipt), SavedBankRefundStatus::Obsolete);
            root.resume_bank_refund(cx);
            assert!(matches!(root.checkout_review_mut(), Some(CheckoutReview::Receipt(form)) if !form.busy));
            assert!(root.svc.store.pending_bank_refund(id, "u").unwrap().is_some());
            root.discard_obsolete_bank_refund(cx);
            assert!(root.svc.store.pending_bank_refund(id, "u").unwrap().is_none());
        });
    }

    #[gpui::test]
    async fn a_draft_approved_before_a_restore_requires_review_again(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let id = Uuid::now_v7();
        let payment = Uuid::now_v7();
        let fixture = |generation| {
            serde_json::from_value(json!({
                "id": id, "currency":"EUR", "status":"paid", "canRefund":true,
                "refundReviewGeneration":generation, "totalCents":1400, "paidCents":1400,
                "balanceCents":0, "discountCents":0, "payments":[{
                    "id":payment, "status":"succeeded", "method":"redsys_card", "amountCents":1400,
                    "order":"1234567890"
                }],
            }))
            .unwrap()
        };
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.overlay =
                Overlay::WalkInReceipt(CheckoutReview::from_receipt(fixture("before"), 0, cx));
            root.select_refund(payment, cx);
            let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                panic!("receipt missing")
            };
            let editor = form.refund.as_mut().unwrap();
            editor.reviewed = true;
            editor.bank_generation = Some("before".into());
            form.replace_receipt(fixture("restored"), cx);
            let editor = form.refund.as_ref().unwrap();
            assert!(!editor.reviewed);
            assert!(editor.bank_generation.is_none());
        });
    }
}
