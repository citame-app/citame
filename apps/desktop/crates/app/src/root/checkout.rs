use super::*;
use sob_core::billing::{
    AppointmentCheckout, CheckoutFinalPrice, PaymentAttempt, PaymentAttention, ReceiptTender,
    normalize_gift_card_code, parse_reviewed_amount,
};
use sob_core::sync::TransportError;
use std::sync::Arc;
use uuid::Uuid;

mod cloud;
mod passes;
mod print;
mod reconciliation;
mod refunds;
mod stock_return;

pub(super) enum CheckoutReview {
    Loading(Arc<()>),
    Failed,
    Receipt(Box<ReceiptForm>),
}

impl CheckoutReview {
    pub(super) fn from_receipt(
        receipt: AppointmentCheckout,
        observed_revision: i64,
        cx: &mut Context<Root>,
    ) -> Self {
        let value = amount_entry(receipt.collectible_cents());
        let amount = cx.new(|cx| {
            let mut field = TextField::new("EUR", false, cx);
            field.set_text(&value, cx);
            field
        });
        let amount_changed = cx.observe(&amount, |_, _, cx| cx.notify());
        let gift_code = cx.new(|cx| TextField::new("SOB-…", true, cx));
        let gift_code_changed = cx.observe(&gift_code, |_, _, cx| cx.notify());
        Self::Receipt(Box::new(ReceiptForm {
            price_fields: ReceiptForm::price_fields(&receipt, cx),
            receipt: Arc::new(receipt),
            selected: None,
            request: None,
            pass_picker: None,
            refund: None,
            reconciliation: None,
            bank_outcome_changed: false,
            stock_return: None,
            stock_return_notice: None,
            confirming_void: false,
            amount,
            print_opening: None,
            cloud_opening: None,
            gift_code,
            _gift_code_changed: gift_code_changed,
            _amount_changed: amount_changed,
            busy: false,
            refreshing: false,
            observed_revision,
            error: None,
        }))
    }

    pub(super) fn can_go_back(&self) -> bool {
        !matches!(self, Self::Receipt(form) if form.busy
            || form.request.is_some()
            || form.refund.as_ref().is_some_and(|editor| editor.has_attempt()))
    }
}

pub(super) struct ReceiptForm {
    receipt: Arc<AppointmentCheckout>,
    selected: Option<ReceiptTender>,
    request: Option<PaymentAttempt>,
    pass_picker: Option<passes::PassPicker>,
    amount: Entity<TextField>,
    print_opening: Option<Arc<()>>,
    cloud_opening: Option<Arc<()>>,
    gift_code: Entity<TextField>,
    _gift_code_changed: Subscription,
    _amount_changed: Subscription,
    price_fields: Vec<PriceField>,
    refund: Option<refunds::RefundEditor>,
    reconciliation: Option<reconciliation::BankTransactionReview>,
    bank_outcome_changed: bool,
    stock_return: Option<stock_return::ReturnEditor>,
    stock_return_notice: Option<Key>,
    confirming_void: bool,
    busy: bool,
    refreshing: bool,
    observed_revision: i64,
    error: Option<String>,
}

struct PriceField {
    id: Uuid,
    editor: Entity<TextField>,
    _changed: Subscription,
}

fn tender_label(method: ReceiptTender) -> Key {
    match method {
        ReceiptTender::Cash => Key::CheckoutCash,
        ReceiptTender::ExternalCard => Key::CheckoutExternalCard,
        ReceiptTender::GiftCard => Key::SalesGiftCard,
        ReceiptTender::Package => Key::SalesPackage,
        ReceiptTender::Membership => Key::SalesMembership,
    }
}

impl Root {
    pub(super) fn can_open_appointment_checkout(&self, appointment: &Appointment) -> bool {
        self.status.connectivity == Connectivity::Online
            && self
                .svc
                .current_session()
                .is_some_and(|session| matches!(session.role.as_str(), "owner" | "staff"))
            && appointment.status != AppointmentStatus::Cancelled
            && !appointment.externally_settled
            && (appointment.external_balance.is_some()
                || appointment.billing_review_reasons.is_empty())
            && !appointment.services.is_empty()
            && appointment
                .services
                .iter()
                .all(|line| line.currency == "EUR" && !line.source_unpriced)
    }

    pub(super) fn open_appointment_checkout(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        let id = details.id.clone();
        if details.checkout.is_some()
            || !self
                .svc
                .store
                .outbox(usize::MAX)
                .is_ok_and(|edits| edits.iter().all(|edit| edit.entity_id != id))
        {
            return;
        }
        let Ok(Some(appointment)) = self.svc.store.appointment(&id) else {
            return;
        };
        if !self.can_open_appointment_checkout(&appointment) {
            return;
        }
        let balance = appointment.external_balance;
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let observed_revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        let token = Arc::new(());
        let session = self.svc.session.clone();
        if let Overlay::Details(details) = &mut self.overlay {
            details.checkout = Some(CheckoutReview::Loading(token.clone()));
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor()
                .spawn(async move { transport.open_appointment_checkout(&id, balance) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none() {
                    return;
                }
                let Overlay::Details(details) = &mut this.overlay else { return };
                if !matches!(&details.checkout, Some(CheckoutReview::Loading(current)) if Arc::ptr_eq(current, &token)) {
                    return;
                }
                details.checkout = Some(match result {
                    Ok(receipt) => CheckoutReview::from_receipt(receipt, observed_revision, cx),
                    Err(_) => CheckoutReview::Failed,
                });
                cx.notify();
            });
        }).detach();
    }

    pub(super) fn refresh_checkout_if_changed(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.busy
            || form.refreshing
            || form.stock_return.is_some()
            || form.request.is_some()
            || form
                .refund
                .as_ref()
                .is_some_and(|editor| editor.has_attempt())
            || form.observed_revision == revision
        {
            return;
        }
        form.refreshing = true;
        form.observed_revision = revision;
        let previous = form.receipt.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let receipt = previous.clone();
            let result = cx
                .background_executor()
                .spawn(async move { transport.refresh_checkout(&receipt) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&form.receipt, &previous) {
                    return;
                }
                form.refreshing = false;
                match result {
                    Ok(receipt) => {
                        let suggested = amount_entry(previous.collectible_cents());
                        if form.amount.read(cx).text() == suggested {
                            form.amount.update(cx, |field, cx| {
                                field.set_text(&amount_entry(receipt.collectible_cents()), cx)
                            });
                        }
                        form.replace_receipt(receipt, cx);
                        form.error = None;
                        if let Some(review) = &mut form.reconciliation {
                            review.needs_refresh = false;
                        }
                    }
                    Err(_) if form.reconciliation.is_some() => {
                        if let Some(review) = &mut form.reconciliation {
                            review.needs_refresh = true;
                        }
                    }
                    Err(_) => {
                        // Avoid collecting against a balance we could not verify.
                        if let Some(review) = root.checkout_review_mut() {
                            *review = CheckoutReview::Failed;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn record_checkout_payment(
        &mut self,
        pass_attempt: Option<PaymentAttempt>,
        cx: &mut Context<Self>,
    ) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        let collectible = form.receipt.collectible_cents();
        if form.busy
            || form.refreshing
            || form.refund.is_some()
            || form.reconciliation.is_some()
            || form.stock_return.is_some()
            || form.confirming_void
            || collectible == 0
        {
            return;
        }
        if form.request.is_none() {
            form.request = if let Some(attempt) = pass_attempt {
                form.pass_picker = None;
                Some(attempt)
            } else {
                let Some((selected, amount)) = form.selected.zip(form.reviewed_amount(cx)) else {
                    return;
                };
                if selected == ReceiptTender::GiftCard {
                    PaymentAttempt::with_gift_card(amount, form.gift_code.read(cx).text())
                } else {
                    Some(PaymentAttempt::new(selected, amount))
                }
            };
        }
        let Some(request) = form.request.clone() else {
            return;
        };
        form.busy = true;
        form.error = None;
        let receipt = form.receipt.clone();
        let session = self.svc.session.clone();
        cx.notify();

        let submitted = request.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.record_checkout_payment(&receipt, &submitted) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                if result.is_ok() {
                    this.svc.wake(Wake::Manual);
                }
                let fallback = this.t(Key::CheckoutNotConfirmed);
                let Some(CheckoutReview::Receipt(form)) = this.checkout_review_mut() else {
                    return;
                };
                if form.request != Some(request) {
                    return;
                }
                form.busy = false;
                match result {
                    Ok(receipt) => {
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx);
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                        form.request = None;
                        form.gift_code
                            .update(cx, |field, cx| field.set_text("", cx));
                    }
                    Err(
                        TransportError::BadRequest(message) | TransportError::Forbidden(message),
                    ) => {
                        form.request = None;
                        form.error = Some(message);
                    }
                    Err(_) => form.error = Some(fallback.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn finalize_checkout_prices(&mut self, cx: &mut Context<Self>) {
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
        if form.busy
            || form.refreshing
            || form.request.is_some()
            || form.refund.is_some()
            || form.stock_return.is_some()
            || form.confirming_void
        {
            return;
        }
        let Some(prices) = form.reviewed_prices(cx) else {
            return;
        };
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let (result, refreshed) = cx
                .background_executor()
                .spawn(async move {
                    let result = transport.finalize_checkout_prices(&receipt, &prices);
                    let refreshed = if result.is_err() {
                        transport.refresh_checkout(&receipt).ok()
                    } else {
                        None
                    };
                    (result, refreshed)
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let fallback = root.t(Key::CheckoutPricesNotConfirmed);
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !Arc::ptr_eq(&form.receipt, &previous) {
                    return;
                }
                form.busy = false;
                match result {
                    Ok(receipt) => {
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx);
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                    }
                    Err(error) => {
                        let Some(receipt) = refreshed else {
                            if let Some(review) = root.checkout_review_mut() {
                                *review = CheckoutReview::Failed;
                            }
                            cx.notify();
                            return;
                        };
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx);
                        });
                        form.replace_receipt(receipt, cx);
                        form.selected = None;
                        form.error = Some(match error {
                            TransportError::BadRequest(message) => message,
                            _ => fallback.to_owned(),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn checkout_review_mut(&mut self) -> Option<&mut CheckoutReview> {
        Self::checkout_review_in(&mut self.overlay)
    }

    fn checkout_review_in(overlay: &mut Overlay) -> Option<&mut CheckoutReview> {
        match overlay {
            Overlay::Details(details) => details.checkout.as_mut(),
            Overlay::WalkInReceipt(review) => Some(review),
            _ => overlay.sales_history_mut()?.receipt.as_mut(),
        }
    }

    pub(super) fn render_checkout(
        &self,
        review: &CheckoutReview,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let history = self.overlay.sales_history().is_some();
        let body = div().flex().flex_col().gap_3().child(
            div().text_lg().font_weight(FontWeight::BOLD).child(self.t(
                if history || matches!(self.overlay, Overlay::WalkInReceipt(_)) {
                    Key::SaleCreateReceipt
                } else {
                    Key::OpenAppointmentCheckout
                },
            )),
        );
        let body = match review {
            CheckoutReview::Loading(_) => body.child(self.t(Key::CheckoutLoading)),
            CheckoutReview::Failed => body.child(self.t(Key::CheckoutUnavailable)),
            CheckoutReview::Receipt(form) => {
                let receipt = &form.receipt;
                let due = self.amount_label(i64::from(receipt.balance_cents), &receipt.currency);
                let collectible = receipt.collectible_cents();
                let money = |cents: i64| self.amount_label(cents, &receipt.currency);
                let body = body
                    .child(format!(
                        "{}: {}",
                        self.t(Key::CheckoutTotal),
                        money(i64::from(receipt.total_cents))
                    ))
                    .when_some(receipt.external_balance, |view, balance| {
                        view.child(format!(
                            "{}: {}",
                            self.t(Key::CheckoutBooksyPaid),
                            money(i64::from(balance.paid_in_booksy_cents))
                        ))
                    })
                    .when(receipt.paid_cents > 0, |view| {
                        view.child(format!(
                            "{}: {}",
                            self.t(Key::CheckoutPaidInCitame),
                            money(receipt.paid_cents as i64)
                        ))
                    })
                    .when(receipt.discount_cents > 0, |view| {
                        view.child(format!(
                            "{}: {}",
                            self.t(Key::CheckoutDiscount),
                            money(i64::from(receipt.discount_cents))
                        ))
                    })
                    .child(format!("{}: {due}", self.t(Key::CheckoutDue)))
                    .when(receipt.overpaid_cents > 0, |view| {
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(format!(
                                    "{} · {}",
                                    self.t(Key::CheckoutOverpaid),
                                    self.amount_label(
                                        receipt.overpaid_cents.min(i64::MAX as u64) as i64,
                                        &receipt.currency
                                    )
                                )),
                        )
                    })
                    .when_some(receipt.payment_attention(), |view, attention| {
                        let key = match attention {
                            PaymentAttention::Pending => Key::CheckoutPaymentPending,
                            PaymentAttention::Reconciliation => Key::CheckoutPaymentReview,
                        };
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(self.t(key)),
                        )
                    })
                    .when(receipt.appointment_id.is_none() || history, |view| {
                        view.children(receipt.lines.iter().map(|line| {
                            div()
                                .text_sm()
                                .child(format!("{} × {}", line.quantity, line.description))
                        }))
                    })
                    .when_some(form.error.as_ref(), |view, message| {
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(message.clone()),
                        )
                    });
                let body = body.when(form.bank_outcome_changed, |view| {
                    view.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(Key::CheckoutBankOutcomeChanged)),
                    )
                });
                let body = body
                    .child(self.render_bank_transaction_review(form, cx))
                    .when(form.reconciliation.is_none(), |view| {
                        view.child(self.render_refunds(form, cx))
                            .child(self.render_void_receipt(form, cx))
                            .child(self.render_stock_returns(form, cx))
                    })
                    .when(form.can_print(), |view| {
                        view.child(self.render_print_receipt(form, cx))
                    })
                    .when(
                        self.status.connectivity == Connectivity::Online
                            && form.can_open_in_cloud(),
                        |view| view.child(self.render_cloud_receipt(form, cx)),
                    );
                let reviewing_prices = form.refund.is_none()
                    && form.reconciliation.is_none()
                    && form.stock_return.is_none()
                    && !form.confirming_void
                    && receipt.can_review_prices()
                    && self.status.connectivity == Connectivity::Online
                    && !form.busy
                    && !form.refreshing
                    && form.request.is_none();
                let body = body.when(reviewing_prices, |view| {
                    let fields = form.price_fields.iter().filter_map(|field| {
                        let line = receipt.lines.iter().find(|line| line.id == field.id)?;
                        Some(
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .text_sm()
                                .child(line.description.clone())
                                .when(line.minimum_unit_amount_cents > 0, |view| {
                                    view.child(format!(
                                        "{}: {}",
                                        self.t(Key::CheckoutPriceMinimum),
                                        money(i64::from(line.minimum_unit_amount_cents))
                                    ))
                                })
                                .child(field.editor.clone()),
                        )
                    });
                    view.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(self.t(Key::CheckoutFinalPrices))
                            .children(fields)
                            .map(|view| {
                                if form.reviewed_prices(cx).is_some() {
                                    view.child(self.button(
                                        "checkout-final-prices",
                                        self.t(Key::CheckoutSetFinalPrices),
                                        Kind::Primary,
                                        cx.listener(|this, _, _, cx| {
                                            this.finalize_checkout_prices(cx)
                                        }),
                                    ))
                                } else {
                                    view.child(
                                        div().text_sm().child(self.t(Key::CheckoutPricesInvalid)),
                                    )
                                }
                            }),
                    )
                });
                if form.refund.is_some()
                    || form.reconciliation.is_some()
                    || form.stock_return.is_some()
                    || form.confirming_void
                {
                    body
                } else if receipt.status == "paid" {
                    body.child(self.t(Key::ReceiptPaid))
                } else if self.status.connectivity != Connectivity::Online {
                    body.child(self.t(Key::CheckoutOffline))
                } else if form.refreshing {
                    body.child(self.t(Key::CheckoutLoading))
                } else if form.busy {
                    body.child(self.t(Key::CheckoutRecording))
                } else if collectible == 0 {
                    body.when(!reviewing_prices, |view| {
                        view.child(self.t(Key::CheckoutCannotCollect))
                    })
                } else {
                    let reviewed = form.reviewed_amount(cx);
                    let needs_gift_code =
                        form.request.is_none() && form.selected == Some(ReceiptTender::GiftCard);
                    let valid_tender = !needs_gift_code
                        || normalize_gift_card_code(form.gift_code.read(cx).text()).is_some();
                    let selected = form
                        .request
                        .as_ref()
                        .map(PaymentAttempt::tender)
                        .or(form.selected);
                    body.when(collectible < receipt.balance_cents, |view| {
                        view.child(format!(
                            "{}: {}",
                            self.t(Key::CheckoutPayableNow),
                            money(i64::from(collectible))
                        ))
                    })
                    .when(form.request.is_none(), |view| {
                        let view = view.child(
                            div()
                                .text_sm()
                                .child(self.t(Key::CheckoutAmount))
                                .child(form.amount.clone()),
                        );
                        view.children(
                            [
                                (ReceiptTender::Cash, "checkout-cash"),
                                (ReceiptTender::ExternalCard, "checkout-card"),
                                (ReceiptTender::GiftCard, "checkout-gift"),
                            ]
                            .into_iter()
                            .filter(|(tender, _)| {
                                *tender != ReceiptTender::GiftCard || receipt.allows_gift_card()
                            })
                            .map(|(tender, id)| {
                                self.button(
                                    id,
                                    self.t(tender_label(tender)),
                                    if form.selected == Some(tender) {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |this, _, _, cx| {
                                        if let Some(CheckoutReview::Receipt(form)) =
                                            this.checkout_review_mut()
                                            && form.request.is_none()
                                        {
                                            form.selected = Some(tender);
                                            form.error = None;
                                            if tender != ReceiptTender::GiftCard {
                                                form.gift_code
                                                    .update(cx, |field, cx| field.set_text("", cx));
                                            }
                                            cx.notify();
                                        }
                                    }),
                                )
                            }),
                        )
                    })
                    .when(needs_gift_code, |view| {
                        view.child(self.label(Key::CheckoutGiftCode))
                            .child(form.gift_code.clone())
                            .when(
                                !valid_tender && !form.gift_code.read(cx).text().is_empty(),
                                |view| {
                                    view.child(
                                        div().text_sm().child(self.t(Key::CheckoutGiftCodeInvalid)),
                                    )
                                },
                            )
                    })
                    .when(form.request.is_none() && receipt.allows_pass(), |view| {
                        view.child(self.render_pass_picker(form, cx))
                    })
                    .when(reviewed.is_none(), |view| {
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(self.t(Key::CheckoutAmountInvalid)),
                        )
                    })
                    .when_some(
                        selected.zip(reviewed.filter(|_| valid_tender)),
                        |view, (method, amount)| {
                            view.child(self.button(
                                "checkout-confirm",
                                format!(
                                    "{} · {} · {}",
                                    self.t(Key::ConfirmCheckoutPayment),
                                    self.t(tender_label(method)),
                                    money(i64::from(amount))
                                ),
                                Kind::Primary,
                                cx.listener(|this, _, _, cx| {
                                    this.record_checkout_payment(None, cx)
                                }),
                            ))
                        },
                    )
                }
            }
        };
        let scrollable = div().id("checkout-keyboard").tab_group().child(
            div()
                .id("checkout-content")
                .min_h_0()
                .max_h(px(530.))
                .overflow_y_scroll()
                .child(body),
        );
        self.modal(div().child(scrollable.when(review.can_go_back(), |view| {
            view.child(self.checkout_keyboard_button(
                "back-from-checkout",
                self.t(Key::Back),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
            ))
        })))
    }
}

impl ReceiptForm {
    fn can_print(&self) -> bool {
        self.is_idle() && !self.refreshing
    }

    fn is_idle(&self) -> bool {
        !self.busy
            && self.request.is_none()
            && self.refund.is_none()
            && self.reconciliation.is_none()
            && self.stock_return.is_none()
            && !self.confirming_void
    }

    fn price_fields(receipt: &AppointmentCheckout, cx: &mut Context<Root>) -> Vec<PriceField> {
        receipt
            .lines
            .iter()
            .filter(|line| line.price_pending)
            .map(|line| {
                let editor = cx.new(|cx| TextField::new("EUR", false, cx));
                let changed = cx.observe(&editor, |_, _, cx| cx.notify());
                PriceField {
                    id: line.id,
                    editor,
                    _changed: changed,
                }
            })
            .collect()
    }

    fn replace_receipt(&mut self, receipt: AppointmentCheckout, cx: &mut Context<Root>) {
        if let Some(editor) = &mut self.refund {
            editor.receipt_changed(receipt.refund_review_generation.as_deref());
        }
        if self.receipt.pricing_version != receipt.pricing_version {
            self.price_fields = Self::price_fields(&receipt, cx);
        }
        self.receipt = Arc::new(receipt);
        self.pass_picker = None;
        if let Some(review) = &self.reconciliation
            && !review.remains_eligible(&self.receipt)
        {
            self.reconciliation = None;
        }
    }

    fn reviewed_prices(&self, cx: &App) -> Option<Vec<CheckoutFinalPrice>> {
        if !self.receipt.can_review_prices() || self.price_fields.is_empty() {
            return None;
        }
        self.price_fields
            .iter()
            .map(|field| {
                let line = self
                    .receipt
                    .lines
                    .iter()
                    .find(|l| l.id == field.id && l.price_pending)?;
                let cents = parse_reviewed_amount(field.editor.read(cx).text())
                    .filter(|price| *price >= line.minimum_unit_amount_cents)?;
                Some(CheckoutFinalPrice {
                    id: field.id,
                    unit_amount_cents: cents,
                })
            })
            .collect()
    }

    fn reviewed_amount(&self, cx: &App) -> Option<u32> {
        self.request
            .as_ref()
            .map(PaymentAttempt::amount_cents)
            .or_else(|| parse_reviewed_amount(self.amount.read(cx).text()))
            .filter(|amount| *amount > 0 && *amount <= self.receipt.collectible_cents())
    }
}

fn amount_entry(cents: u32) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use serde_json::json;

    #[gpui::test]
    async fn a_final_price_requires_a_reviewed_amount_at_or_above_the_minimum(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |_, _, cx| {
                let receipt = serde_json::from_value(json!({
                    "id": "checkout", "appointmentId": "visit", "currency": "EUR", "status": "open",
                    "totalCents": 3000, "discountCents": 0, "paidCents": 0, "balanceCents": 3000,
                    "pricingVersion": 1, "payments": [],
                    "lines": [{
                        "id": "01a1d81f-2231-75bd-ba65-bc41f42803e9", "description": "Treatment",
                        "quantity": 1, "unitAmountCents": 3000, "minimumUnitAmountCents": 3000, "pricePending": true
                    }]
                }))
                .unwrap();
                let amount = cx.new(|cx| TextField::new("EUR", false, cx));
                let amount_changed = cx.observe(&amount, |_, _, cx| cx.notify());
                let gift_code = cx.new(|cx| TextField::new("SOB-…", true, cx));
                let gift_code_changed = cx.observe(&gift_code, |_, _, cx| cx.notify());
                let form = ReceiptForm {
                    price_fields: ReceiptForm::price_fields(&receipt, cx),
                    receipt: Arc::new(receipt),
                    selected: None,
                    request: None,
                    pass_picker: None,
                    refund: None,
                    reconciliation: None,
                    bank_outcome_changed: false,
                    stock_return: None,
                    stock_return_notice: None,
                    confirming_void: false,
                    amount,
                    print_opening: None,
                    cloud_opening: None,
                    gift_code,
                    _gift_code_changed: gift_code_changed,
                    _amount_changed: amount_changed,
                    busy: false,
                    refreshing: false,
                    observed_revision: 0,
                    error: None,
                };
                let editor = &form.price_fields[0].editor;
                assert!(form.reviewed_prices(cx).is_none());
                editor.update(cx, |field, cx| field.set_text("29,99", cx));
                assert!(form.reviewed_prices(cx).is_none());
                editor.update(cx, |field, cx| field.set_text("30,00", cx));
                assert_eq!(form.reviewed_prices(cx).unwrap()[0].unit_amount_cents, 3000);
            })
            .unwrap();
    }

    #[gpui::test]
    async fn a_receipt_amount_respects_the_deposit_limit_and_is_frozen_for_retry(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |_, _, cx| {
                let receipt = serde_json::from_value(json!({
                    "id": "checkout", "appointmentId": "visit", "currency": "EUR", "status": "open",
                    "totalCents": 9000, "discountCents": 1000, "paidCents": 1000,
                    "balanceCents": 8000, "payableCents": 1500, "payments": [],
                }))
                .unwrap();
                let amount = cx.new(|cx| TextField::new("EUR", false, cx));
                let amount_changed = cx.observe(&amount, |_, _, cx| cx.notify());
                let gift_code = cx.new(|cx| TextField::new("SOB-…", true, cx));
                let gift_code_changed = cx.observe(&gift_code, |_, _, cx| cx.notify());
                let mut form = ReceiptForm {
                    receipt: Arc::new(receipt),
                    price_fields: Vec::new(),
                    selected: Some(ReceiptTender::Cash),
                    request: None,
                    pass_picker: None,
                    refund: None,
                    reconciliation: None,
                    bank_outcome_changed: false,
                    stock_return: None,
                    stock_return_notice: None,
                    confirming_void: false,
                    amount,
                    print_opening: None,
                    cloud_opening: None,
                    gift_code,
                    _gift_code_changed: gift_code_changed,
                    _amount_changed: amount_changed,
                    busy: false,
                    refreshing: false,
                    observed_revision: 0,
                    error: None,
                };
                form.amount
                    .update(cx, |field, cx| field.set_text("15,01", cx));
                assert_eq!(form.reviewed_amount(cx), None);
                form.amount
                    .update(cx, |field, cx| field.set_text("12,50", cx));
                assert_eq!(form.reviewed_amount(cx), Some(1250));
                form.request = Some(PaymentAttempt::new(ReceiptTender::Cash, 1250));
                form.amount.update(cx, |field, cx| field.set_text("15", cx));
                assert_eq!(form.reviewed_amount(cx), Some(1250));
            })
            .unwrap();
    }
}
