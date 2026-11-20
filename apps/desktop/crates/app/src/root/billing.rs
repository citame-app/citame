use super::*;
use sob_core::billing::{
    ImportedPricePreview, ImportedPriceReview, ReviewedServicePrice, parse_reviewed_amount,
};
use sob_core::sync::TransportError;
use std::sync::Arc;

pub(super) enum PriceReview {
    Loading(Arc<()>),
    Form(Box<ReviewForm>),
    Failed,
    Saved,
}

pub(super) struct ReviewForm {
    preview: ImportedPricePreview,
    amounts: Vec<Entity<TextField>>,
    reference: Entity<TextField>,
    pending: Option<Arc<()>>,
    error: Option<Key>,
}

impl ReviewForm {
    fn request(&self, cx: &App) -> Option<ImportedPriceReview> {
        let reference = self.reference.read(cx).text().trim().to_owned();
        if !(3..=300).contains(&reference.encode_utf16().count())
            || !(1..=100).contains(&self.preview.lines.len())
        {
            return None;
        }
        let lines = self
            .preview
            .lines
            .iter()
            .zip(&self.amounts)
            .map(|(line, input)| {
                Some(ReviewedServicePrice {
                    id: line.id.clone(),
                    amount_cents: parse_reviewed_amount(input.read(cx).text())?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(ImportedPriceReview {
            appointment_version: self.preview.appointment_version,
            reference,
            lines,
        })
    }
}

impl Root {
    pub(super) fn owner_can_reconcile_billing(&self) -> bool {
        self.status.connectivity == Connectivity::Online
            && self
                .svc
                .current_session()
                .is_some_and(|session| session.role == "owner")
    }

    pub(super) fn can_open_price_review(&self, appointment: &Appointment) -> bool {
        self.owner_can_reconcile_billing()
            && !appointment.externally_settled
            && appointment.external_balance.is_none()
            && appointment.status != AppointmentStatus::Cancelled
            && appointment.services.iter().any(|line| line.source_unpriced)
            && appointment
                .services
                .iter()
                .all(|line| line.currency == "EUR")
            && appointment
                .billing_review_reasons
                .iter()
                .all(|reason| *reason == BillingReviewReason::UnknownAmount)
    }

    pub(super) fn open_price_review(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        let id = details.id.clone();
        let Ok(Some(appointment)) = self.svc.store.appointment(&id) else {
            return;
        };
        if details.price_review.is_some()
            || !self.can_open_price_review(&appointment)
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
            details.price_review = Some(PriceReview::Loading(token.clone()));
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { transport.imported_price_preview(&id) }).await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none() { return; }
                let Overlay::Details(details) = &mut this.overlay else { return };
                if !matches!(&details.price_review, Some(PriceReview::Loading(current)) if Arc::ptr_eq(current, &token)) {
                    return;
                }
                details.price_review = Some(match result {
                    Ok(preview) => PriceReview::Form(Box::new(ReviewForm {
                        amounts: preview.lines.iter().map(|_| cx.new(|cx| TextField::new("EUR", false, cx))).collect(),
                        reference: cx.new(|cx| TextField::new("", false, cx)),
                        preview,
                        pending: None,
                        error: None,
                    })),
                    Err(_) => {
                        this.svc.wake(Wake::Manual);
                        PriceReview::Failed
                    }
                });
                cx.notify();
            });
        }).detach();
    }

    fn save_price_review(&mut self, cx: &mut Context<Self>) {
        let connected = self.owner_can_reconcile_billing();
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        let Some(PriceReview::Form(form)) = &mut details.price_review else {
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
            form.error = Some(Key::PriceReviewInvalid);
            cx.notify();
            return;
        };
        let id = details.id.clone();
        let session = self.svc.session.clone();
        let token = Arc::new(());
        form.pending = Some(token.clone());
        form.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.review_imported_price(&id, &payload) })
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
                let Some(PriceReview::Form(form)) = &mut details.price_review else {
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
                    Ok(()) => details.price_review = Some(PriceReview::Saved),
                    Err(TransportError::Offline(_)) => {
                        form.pending = None;
                        form.error = Some(Key::PriceReviewOffline);
                    }
                    Err(TransportError::RateLimited(_)) | Err(TransportError::Server(_)) => {
                        form.pending = None;
                        form.error = Some(Key::PriceReviewUnavailable);
                    }
                    Err(_) => details.price_review = Some(PriceReview::Failed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_price_review(
        &self,
        review: &PriceReview,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut body = div().flex().flex_col().gap_3().child(
            div()
                .text_lg()
                .font_weight(FontWeight::BOLD)
                .child(self.t(Key::ReviewImportedPrice)),
        );
        match review {
            PriceReview::Loading(_) => body = body.child(self.t(Key::PriceReviewLoading)),
            PriceReview::Failed => body = body.child(self.t(Key::PriceReviewUnavailable)),
            PriceReview::Saved => body = body.child(self.t(Key::PriceReviewSaved)),
            PriceReview::Form(form) => {
                body = body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::PriceReviewBasis)),
                );
                if form.pending.is_some() {
                    body = body.child(self.t(Key::PriceReviewSaving));
                } else {
                    body = body
                        .child(
                            div()
                                .id("imported-price-lines")
                                .min_h_0()
                                .max_h(px(330.))
                                .overflow_y_scroll()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .children(
                                    form.preview
                                        .lines
                                        .iter()
                                        .zip(&form.amounts)
                                        .enumerate()
                                        .map(|(index, (line, input))| {
                                            div()
                                                .text_sm()
                                                .child(SharedString::from(format!(
                                                    "{} · {}",
                                                    index + 1,
                                                    line.name
                                                )))
                                                .child(input.clone())
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .text_sm()
                                .child(self.t(Key::PriceReviewReference))
                                .child(form.reference.clone()),
                        )
                        .when_some(form.error, |x, error| {
                            x.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::conflict_fg())
                                    .child(self.t(error)),
                            )
                        })
                        .when(self.owner_can_reconcile_billing(), |x| {
                            x.child(self.button(
                                "save-imported-price-review",
                                self.t(Key::SaveReviewedPrices),
                                Kind::Primary,
                                cx.listener(|this, _, _, cx| this.save_price_review(cx)),
                            ))
                        });
                }
            }
        }
        self.modal(body.child(self.button(
            "back-from-price-review",
            self.t(Key::Back),
            Kind::Ghost,
            cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
        )))
    }
}
