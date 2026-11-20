use super::*;
use sob_core::billing::{ImportedPartialPaymentPreview, ImportedSettlement, parse_reviewed_amount};
use sob_core::sync::TransportError;
use std::sync::Arc;

pub(super) enum SettlementReview {
    Loading { token: Arc<()>, partial: bool },
    Form(SettlementForm),
    Failed { partial: bool },
    Saved(RecordedPayment),
}

pub(super) struct SettlementForm {
    version: i64,
    original_total: Option<u32>,
    amount: Entity<TextField>,
    reference: Entity<TextField>,
    pending: Option<Arc<()>>,
    error: Option<Key>,
}

enum Preview {
    Ready(i64, Option<u32>),
    Recorded(RecordedPayment),
}

pub(super) enum RecordedPayment {
    Full(u32),
    Partial(ExternalBalance),
}

impl SettlementReview {
    fn partial(&self) -> bool {
        match self {
            Self::Loading { partial, .. } | Self::Failed { partial } => *partial,
            Self::Form(form) => form.original_total.is_some(),
            Self::Saved(record) => matches!(record, RecordedPayment::Partial(_)),
        }
    }
}

impl SettlementForm {
    fn request(&self, cx: &App) -> Option<ImportedSettlement> {
        let reference = self.reference.read(cx).text().trim().to_owned();
        if !(3..=300).contains(&reference.encode_utf16().count()) {
            return None;
        }
        let amount_cents = parse_reviewed_amount(self.amount.read(cx).text())?;
        if self
            .original_total
            .is_some_and(|total| amount_cents == 0 || amount_cents >= total)
        {
            return None;
        }
        Some(ImportedSettlement {
            appointment_version: self.version,
            amount_cents,
            reference,
        })
    }
}

impl Root {
    pub(super) fn can_open_settlement_review(
        &self,
        appointment: &Appointment,
        partial: bool,
    ) -> bool {
        self.owner_can_reconcile_billing()
            && !appointment.externally_settled
            && appointment.external_balance.is_none()
            && appointment.status != AppointmentStatus::Cancelled
            && !appointment.services.is_empty()
            && appointment
                .services
                .iter()
                .all(|line| line.currency == "EUR")
            && if partial {
                appointment.imported_from_booksy
                    && appointment
                        .services
                        .iter()
                        .all(|line| !line.source_unpriced)
                    && appointment.services.iter().any(|line| line.price_cents > 0)
            } else {
                appointment.billing_review_reasons.iter().any(|reason| {
                    matches!(
                        reason,
                        BillingReviewReason::PaidInBooksy | BillingReviewReason::InvoicedInBooksy
                    )
                })
            }
    }

    pub(super) fn open_settlement_review(&mut self, partial: bool, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        let id = details.id.clone();
        let Ok(Some(appointment)) = self.svc.store.appointment(&id) else {
            return;
        };
        if details.settlement_review.is_some()
            || !self.can_open_settlement_review(&appointment, partial)
            || !self
                .svc
                .store
                .outbox(usize::MAX)
                .is_ok_and(|queue| queue.iter().all(|edit| edit.entity_id != id))
        {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let session = self.svc.session.clone();
        let token = Arc::new(());
        if let Overlay::Details(details) = &mut self.overlay {
            details.settlement_review = Some(SettlementReview::Loading {
                token: token.clone(),
                partial,
            });
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor()
                .spawn(async move {
                    if partial {
                        transport.imported_partial_payment_preview(&id).map(|response| match response {
                            ImportedPartialPaymentPreview::Ready(terms) =>
                                Preview::Ready(terms.appointment_version, Some(terms.original_total_cents)),
                            ImportedPartialPaymentPreview::Recorded(payment) =>
                                Preview::Recorded(RecordedPayment::Partial(payment.external_balance)),
                        })
                    } else {
                        transport.imported_settlement_status(&id).map(|status| match status.settlement {
                            Some(payment) => Preview::Recorded(RecordedPayment::Full(payment.amount_cents)),
                            None => Preview::Ready(status.appointment_version, None),
                        })
                    }
                }).await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none() { return; }
                let Overlay::Details(details) = &mut this.overlay else { return };
                if !matches!(&details.settlement_review, Some(SettlementReview::Loading { token: current, .. }) if Arc::ptr_eq(current, &token)) { return; }
                details.settlement_review = Some(match result {
                    Ok(Preview::Recorded(recorded)) => {
                        this.svc.wake(Wake::Manual);
                        SettlementReview::Saved(recorded)
                    }
                    Ok(Preview::Ready(version, original_total)) => SettlementReview::Form(SettlementForm {
                            version,
                            original_total,
                            amount: cx.new(|cx| TextField::new("EUR", false, cx)),
                            reference: cx.new(|cx| TextField::new("", false, cx)),
                            pending: None,
                            error: None,
                        }),
                    Err(_) => SettlementReview::Failed { partial },
                });
                cx.notify();
            });
        }).detach();
    }

    fn save_settlement_review(&mut self, cx: &mut Context<Self>) {
        let connected = self.owner_can_reconcile_billing();
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        let Some(SettlementReview::Form(form)) = &mut details.settlement_review else {
            return;
        };
        if form.pending.is_some() {
            return;
        }
        let Some(transport) = self.svc.transport().filter(|_| connected) else {
            form.error = Some(Key::PriceReviewOffline);
            cx.notify();
            return;
        };
        let Some(payload) = form.request(cx) else {
            form.error = Some(if form.original_total.is_some() {
                Key::PartialPaymentInvalid
            } else {
                Key::SettlementInvalid
            });
            cx.notify();
            return;
        };
        let id = details.id.clone();
        let original_total = form.original_total;
        let token = Arc::new(());
        let session = self.svc.session.clone();
        form.pending = Some(token.clone());
        form.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if let Some(total) = original_total {
                        transport
                            .confirm_imported_partial_payment(&id, &payload, total)
                            .map(RecordedPayment::Partial)
                    } else {
                        transport
                            .confirm_imported_settlement(&id, &payload)
                            .map(RecordedPayment::Full)
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                if !matches!(&result, Err(TransportError::Offline(_))) {
                    this.svc.wake(Wake::Manual);
                }
                let Overlay::Details(details) = &mut this.overlay else {
                    return;
                };
                let Some(SettlementReview::Form(form)) = &mut details.settlement_review else {
                    return;
                };
                if !form
                    .pending
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &token))
                {
                    return;
                }
                match result {
                    Ok(saved) => details.settlement_review = Some(SettlementReview::Saved(saved)),
                    Err(error) => {
                        form.pending = None;
                        form.error = Some(match error {
                            TransportError::Offline(_) => Key::PriceReviewOffline,
                            _ => Key::SettlementUnavailable,
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_settlement_review(
        &self,
        review: &SettlementReview,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let partial = review.partial();
        let body = div().flex().flex_col().gap_3().child(
            div()
                .text_lg()
                .font_weight(FontWeight::BOLD)
                .child(self.t(if partial {
                    Key::ReviewPartialPayment
                } else {
                    Key::ReviewImportedSettlement
                })),
        );
        let body =
            match review {
                SettlementReview::Loading { .. } => body.child(self.t(Key::PriceReviewLoading)),
                SettlementReview::Failed { .. } => body.child(self.t(Key::SettlementUnavailable)),
                SettlementReview::Saved(RecordedPayment::Full(amount)) => body
                    .child(self.t(Key::SettlementSaved))
                    .child(SharedString::from(
                        self.amount_label(i64::from(*amount), "EUR"),
                    )),
                SettlementReview::Saved(RecordedPayment::Partial(balance)) => body
                    .child(self.t(Key::PartialPaymentSaved))
                    .child(self.external_balance_label(*balance)),
                SettlementReview::Form(form) if form.pending.is_some() => {
                    body.child(self.t(Key::SettlementSaving))
                }
                SettlementReview::Form(form) => body
                    .child(div().text_sm().text_color(theme::muted()).child(
                        match form.original_total {
                            Some(total) => {
                                SharedString::from(self.t(Key::PartialPaymentHelp).replace(
                                    "{amount}",
                                    &self.amount_label(i64::from(total), "EUR"),
                                ))
                            }
                            None => SharedString::from(self.t(Key::SettlementHelp)),
                        },
                    ))
                    .child(
                        div()
                            .text_sm()
                            .child(self.t(Key::SettlementAmount))
                            .child(form.amount.clone()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .child(self.t(Key::PriceReviewReference))
                            .child(form.reference.clone()),
                    )
                    .when_some(form.error, |view, error| {
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(self.t(error)),
                        )
                    })
                    .when(self.owner_can_reconcile_billing(), |view| {
                        view.child(self.button(
                            "confirm-imported-settlement",
                            self.t(if partial {
                                Key::ConfirmPartialPayment
                            } else {
                                Key::ConfirmSettlement
                            }),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.save_settlement_review(cx)),
                        ))
                    }),
            };
        self.modal(body.child(self.button(
            "back-from-settlement",
            self.t(Key::Back),
            Kind::Ghost,
            cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
        )))
    }

    pub(super) fn external_balance_label(&self, balance: ExternalBalance) -> SharedString {
        let paid = self.amount_label(i64::from(balance.paid_in_booksy_cents), "EUR");
        let due = self.amount_label(i64::from(balance.due_in_citame_cents), "EUR");
        SharedString::from(
            self.t(Key::ExternalBalance)
                .replace("{paid}", &paid)
                .replace("{due}", &due),
        )
    }
}
