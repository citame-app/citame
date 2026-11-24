use super::*;
use gpui::Pixels;
use sob_core::billing::visit_payment::{
    RecordedVisitPayment, SavedVisitPayment, VisitCheckout, VisitPaymentError, VisitPaymentGroup,
    VisitTender,
};
use uuid::Uuid;

enum State {
    Loading(Arc<()>),
    Failed(Key),
    Ready(Box<VisitCheckout>),
    Saved {
        payment: SavedVisitPayment,
        sending: bool,
    },
    Recorded(RecordedVisitPayment, SavedVisitPayment, bool),
}

pub(super) struct Panel {
    group: VisitPaymentGroup,
    scope: String,
    method: VisitTender,
    state: State,
}

impl Panel {
    fn new(group: VisitPaymentGroup, scope: String, state: State) -> Self {
        Self {
            group,
            scope,
            method: VisitTender::Cash,
            state,
        }
    }

    pub(super) fn receipt_closed(&mut self) {
        if matches!(self.state, State::Ready(_)) {
            self.state = State::Failed(Key::VisitPaymentChanged);
        }
    }

    pub(super) fn sending(&self) -> bool {
        matches!(self.state, State::Saved { sending: true, .. })
    }

    pub(super) fn visible(&self, root: &Root, details: &Details) -> bool {
        root.status.connectivity == Connectivity::Online
            && self.scope == root.time_off_scope
            && authorized(details)
    }
}

fn authorized(details: &Details) -> bool {
    details
        .annotations
        .as_ref()
        .and_then(annotations::Annotations::context)
        .is_some_and(|context| context.has_visit_checkout)
}

fn tender_label(method: VisitTender) -> Key {
    match method {
        VisitTender::Cash => Key::CheckoutCash,
        VisitTender::ExternalCard => Key::VisitPaymentExternalCard,
    }
}

fn has_pending_changes(store: &sob_core::store::Store, ids: &[String]) -> bool {
    !store
        .outbox(usize::MAX)
        .is_ok_and(|entries| entries.iter().all(|entry| !ids.contains(&entry.entity_id)))
}

impl Root {
    pub(super) fn visit_payment_button(
        &self,
        appointment: &Appointment,
        details: &Details,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<gpui::Div>> {
        (self.status.connectivity == Connectivity::Online
            && authorized(details)
            && visit_group::can_switch(details)
            && VisitPaymentGroup::from_appointment(appointment).is_some())
        .then(|| {
            self.button(
                "review-visit-payment",
                self.t(Key::VisitPaymentReview),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_visit_payment(cx)),
            )
            .tab_index(0)
            .debug_selector(|| "review-visit-payment".into())
        })
    }

    fn open_visit_payment(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &self.overlay else {
            return;
        };
        if !authorized(details)
            || !visit_group::can_switch(details)
            || matches!(
                details.visit_payment.as_ref().map(|p| &p.state),
                Some(State::Saved { .. } | State::Loading(_))
            )
        {
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(account) = self.svc.current_session() else {
            return;
        };
        let id = details.id.clone();
        let Some(appointment) = self.svc.store.appointment(&id).ok().flatten() else {
            return;
        };
        let Some(group) = VisitPaymentGroup::from_appointment(&appointment) else {
            return;
        };
        let state = match self
            .svc
            .store
            .pending_visit_payment(group, &account.user_id)
        {
            Ok(Some(payment)) => State::Saved {
                payment,
                sending: false,
            },
            Ok(None) => {
                let synced = calendar::related_visit_appointments(&self.svc.store, &appointment)
                    .map(|related| {
                        let mut ids = vec![id.clone()];
                        ids.extend(related.into_iter().map(|appointment| appointment.id));
                        ids
                    })
                    .is_ok_and(|ids| !has_pending_changes(&self.svc.store, &ids));
                if synced {
                    State::Loading(Arc::new(()))
                } else {
                    State::Failed(Key::VisitPaymentSync)
                }
            }
            Err(_) => State::Failed(Key::VisitPaymentStorage),
        };
        let token = match &state {
            State::Loading(token) => Some(token.clone()),
            _ => None,
        };
        if let Overlay::Details(details) = &mut self.overlay {
            details.visit_payment = Some(Panel::new(group, self.time_off_scope.clone(), state));
        }
        cx.notify();
        let Some(token) = token else { return };
        let session = self.svc.session.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.prepare_visit_checkout(&id, group) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::Details(details) = &mut this.overlay else {
                    return;
                };
                let Some(panel) = &mut details.visit_payment else {
                    return;
                };
                if matches!(&panel.state, State::Loading(active) if Arc::ptr_eq(active, &token)) {
                    panel.state = match result {
                        Ok(visit) => State::Ready(Box::new(visit)),
                        Err(_) => State::Failed(Key::VisitPaymentUnavailable),
                    };
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn select_visit_tender(&mut self, method: VisitTender, cx: &mut Context<Self>) {
        if let Overlay::Details(details) = &mut self.overlay
            && let Some(panel) = &mut details.visit_payment
            && matches!(panel.state, State::Ready(_))
        {
            panel.method = method;
            cx.notify();
        }
    }

    fn record_visit_payment(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(account) = self.svc.current_session() else {
            return;
        };
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        if !authorized(details) {
            return;
        }
        let Some(panel) = &mut details.visit_payment else {
            return;
        };
        if panel.scope != self.time_off_scope {
            return;
        }
        let payment = match &panel.state {
            State::Saved {
                payment,
                sending: false,
            } if payment.actor_user_id == account.user_id => payment.clone(),
            State::Ready(review) => {
                let Some(payment) = review.payment(account.user_id.clone(), panel.method) else {
                    return;
                };
                let ids = review
                    .appointments
                    .iter()
                    .map(|part| part.appointment_id.to_string())
                    .collect::<Vec<_>>();
                if has_pending_changes(&self.svc.store, &ids) {
                    panel.state = State::Failed(Key::VisitPaymentSync);
                    cx.notify();
                    return;
                }
                match self.svc.store.reserve_visit_payment(&payment) {
                    Ok(true) => payment,
                    Ok(false) => {
                        // Another window or an earlier acknowledgement holds this visit's command.
                        panel.state = match self
                            .svc
                            .store
                            .pending_visit_payment(panel.group, &account.user_id)
                        {
                            Ok(Some(payment)) => State::Saved {
                                payment,
                                sending: false,
                            },
                            _ => State::Failed(Key::VisitPaymentStorage),
                        };
                        cx.notify();
                        return;
                    }
                    Err(_) => {
                        panel.state = State::Failed(Key::VisitPaymentStorage);
                        cx.notify();
                        return;
                    }
                }
            }
            _ => return,
        };

        panel.state = State::Saved {
            payment: payment.clone(),
            sending: true,
        };
        let id = details.id.clone();
        let session = self.svc.session.clone();
        let sent = payment.clone();
        cx.notify();

        cx.spawn(async move |this, cx| {
            let result = cx.background_executor()
                .spawn(async move { transport.record_visit_payment(&id, &sent) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none() {
                    return;
                }
                let next = match result {
                    Ok(receipt) => {
                        let cleanup_failed = this.svc.store.clear_visit_payment(&payment).is_err();
                        this.svc.wake(Wake::Manual);
                        State::Recorded(receipt, payment.clone(), cleanup_failed)
                    }
                    Err(VisitPaymentError::Rejected) => {
                        if this.svc.store.clear_visit_payment(&payment).is_ok() {
                            State::Failed(Key::VisitPaymentChanged)
                        } else {
                            State::Failed(Key::VisitPaymentStorage)
                        }
                    }
                    Err(VisitPaymentError::Unknown(_)) => State::Saved { payment: payment.clone(), sending: false },
                };
                let Overlay::Details(details) = &mut this.overlay else { return };
                let Some(panel) = &mut details.visit_payment else { return };
                if matches!(&panel.state, State::Saved { payment: active, .. } if *active == payment) {
                    panel.state = next;
                    cx.notify();
                }
            });
        }).detach();
    }

    pub(super) fn render_visit_payment(
        &self,
        details: &Details,
        panel: &Panel,
        viewport_height: Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let mut body = div()
            .id("visit-payment")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::VisitPaymentTitle)),
            );
        let money = |cents: u64| self.amount_label(i64::try_from(cents).unwrap_or(i64::MAX), "EUR");
        if !online {
            body = body.child(self.t(Key::CheckoutOffline));
        } else if !panel.visible(self, details) {
            body = body.child(self.t(
                if matches!(
                    details.annotations,
                    Some(annotations::Annotations::Loading { .. })
                ) {
                    Key::CheckoutLoading
                } else {
                    Key::VisitPaymentUnavailable
                },
            ));
        } else {
            body = match &panel.state {
                State::Loading(_) => body.child(self.t(Key::CheckoutLoading)),
                State::Failed(message) => body
                    .child(div().text_color(theme::muted()).child(self.t(*message)))
                    .child(
                        self.button(
                            "refresh-visit-payment",
                            self.t(Key::VisitPaymentReview),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.open_visit_payment(cx)),
                        )
                        .tab_index(0),
                    ),
                State::Ready(review) => {
                    for part in &review.appointments {
                        let status = if !part.eligible() {
                            if part.settled_externally {
                                Key::VisitPaymentSettledExternally
                            } else {
                                Key::CalendarCancelled
                            }
                        } else if part
                            .receipt
                            .as_ref()
                            .is_some_and(|receipt| receipt.payment_attention().is_some())
                        {
                            Key::VisitPaymentPendingBank
                        } else if part.receipt.as_ref().is_some_and(|receipt| {
                            receipt.lines.iter().any(|line| line.price_pending)
                        }) {
                            Key::CheckoutFinalPrices
                        } else {
                            match part.receipt.as_ref().map(|receipt| receipt.status.as_str()) {
                                Some("paid") => Key::CheckoutPaidInCitame,
                                _ => Key::VisitPaymentAwaiting,
                            }
                        };
                        let amount = part
                            .receipt
                            .as_ref()
                            .and_then(|receipt| review.payable_for(&receipt.id))
                            .unwrap_or_default();
                        let label =
                            if review.payment_review.is_some() && part.eligible() && amount > 0 {
                                money(u64::from(amount))
                            } else {
                                self.t(status).to_owned()
                            };
                        let title = format!(
                            "{} · {}",
                            part.staff_name,
                            self.date_time_label(part.starts_at)
                        );
                        let mut row =
                            self.visit_payment_row(title, part.service_names.join(" · "), label);
                        if let Some(receipt) = &part.receipt {
                            if part.eligible()
                                && let Ok(id) = Uuid::parse_str(&receipt.id)
                            {
                                row = row.child(self.visit_receipt_button(
                                    part.appointment_id,
                                    id,
                                    cx,
                                ));
                            } else if !part.eligible() {
                                row = row.child(
                                    div().text_sm().text_color(theme::muted()).children(
                                        [
                                            (Key::CheckoutTotal, u64::from(receipt.total_cents)),
                                            (Key::CheckoutPaidInCitame, receipt.paid_cents),
                                            (Key::VisitPaymentRefunded, receipt.refunded_cents),
                                        ]
                                        .into_iter()
                                        .map(
                                            |(label, amount)| {
                                                div().child(format!(
                                                    "{} · {}",
                                                    self.t(label),
                                                    money(amount)
                                                ))
                                            },
                                        ),
                                    ),
                                );
                            }
                        }
                        body = body.child(row);
                    }
                    if let Some(quote) = &review.payment_review {
                        body = body
                            .child(
                                div().flex().flex_wrap().gap_2().children(
                                    [
                                        ("visit-cash", VisitTender::Cash),
                                        ("visit-card", VisitTender::ExternalCard),
                                    ]
                                    .into_iter()
                                    .map(|(id, method)| {
                                        self.button(
                                            id,
                                            self.t(tender_label(method)),
                                            if panel.method == method {
                                                Kind::Primary
                                            } else {
                                                Kind::Ghost
                                            },
                                            cx.listener(move |this, _, _, cx| {
                                                this.select_visit_tender(method, cx)
                                            }),
                                        )
                                        .tab_index(0)
                                    }),
                                ),
                            )
                            .child(self.visit_confirm_button(
                                "confirm-visit-payment",
                                Key::ConfirmCheckoutPayment,
                                money(quote.total_cents),
                                cx,
                            ));
                    } else {
                        body = body.child(self.t(Key::VisitPaymentNoBalance));
                    }
                    body
                }
                State::Saved { payment, sending } => {
                    let amount = money(payment.total_cents());
                    body = body.child(format!(
                        "{} · {amount}",
                        self.t(tender_label(payment.command.method))
                    ));
                    if *sending {
                        body.child(self.t(Key::VisitPaymentRecording))
                    } else {
                        body.child(self.t(Key::CheckoutNotConfirmed)).child(
                            self.visit_confirm_button(
                                "retry-visit-payment",
                                Key::VisitPaymentRetry,
                                amount,
                                cx,
                            ),
                        )
                    }
                }
                State::Recorded(result, saved, cleanup_failed) => {
                    body = body.child(
                        div()
                            .text_color(theme::online())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!(
                                "{} · {}",
                                self.t(Key::VisitPaymentRecorded),
                                money(result.total_cents)
                            )),
                    );
                    if *cleanup_failed {
                        body = body.child(self.t(Key::VisitPaymentStorage));
                    }
                    for line in &result.allocations {
                        if let Some(part) = saved
                            .amounts
                            .iter()
                            .find(|part| part.receipt_id == line.receipt_id)
                        {
                            body = body.child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap_2()
                                    .child(money(u64::from(line.amount_cents)))
                                    .child(self.visit_receipt_button(
                                        part.appointment_id,
                                        line.receipt_id,
                                        cx,
                                    )),
                            );
                        }
                    }
                    body
                }
            };
        }
        self.modal_with_height(
            div().tab_group().child(body).when(
                !panel.sending()
                    && details
                        .checkout
                        .as_ref()
                        .is_none_or(|receipt| receipt.can_go_back()),
                |body| {
                    body.child(
                        self.button(
                            "back-from-visit-payment",
                            self.t(Key::Back),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
                        )
                        .tab_index(0),
                    )
                },
            ),
            px(560.),
            (viewport_height - px(24.)).clamp(px(0.), px(720.)),
            Some(cx),
        )
    }

    fn visit_payment_row(&self, title: String, services: String, status: String) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(status),
            )
            .child(div().text_sm().text_color(theme::muted()).child(services))
    }

    fn visit_receipt_button(
        &self,
        appointment: Uuid,
        receipt: Uuid,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            SharedString::from(format!("visit-receipt-{receipt}")),
            self.t(Key::VisitPaymentReceipt),
            Kind::Ghost,
            cx.listener(move |this, _, _, cx| {
                if this.status.connectivity == Connectivity::Online
                    && matches!(&this.overlay, Overlay::Details(details) if authorized(details))
                {
                    this.open_visit_receipt(appointment, receipt, cx);
                }
            }),
        )
        .tab_index(0)
    }

    fn visit_confirm_button(
        &self,
        id: &'static str,
        label: Key,
        amount: String,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            id,
            format!("{} · {amount}", self.t(label)),
            Kind::Primary,
            cx.listener(|this, _, _, cx| this.record_visit_payment(cx)),
        )
        .tab_index(0)
        .debug_selector(move || id.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sob_core::billing::visit_payment::{VisitPaymentAmount, VisitPaymentCommand, VisitSource};

    #[gpui::test]
    async fn a_saved_visit_payment_has_an_explicit_retry_only_with_live_authorization(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1280.), px(860.)));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            let anchor = root
                .svc
                .store
                .appointments_between(0, i64::MAX)
                .unwrap()
                .remove(0);
            root.open_details(&anchor.id, cx);
            root.status.connectivity = Connectivity::Online;
            let group = VisitPaymentGroup {
                group_id: Uuid::now_v7(),
                source: VisitSource::Itinerary,
            };
            let payment = SavedVisitPayment {
                group,
                actor_user_id: "u".into(),
                command: VisitPaymentCommand {
                    method: VisitTender::ExternalCard,
                    review_token: "a".repeat(64),
                    idempotency_key: Uuid::now_v7(),
                },
                amounts: vec![VisitPaymentAmount {
                    appointment_id: Uuid::parse_str(&anchor.id).unwrap(),
                    receipt_id: Uuid::now_v7(),
                    amount_cents: 1200,
                }],
            };
            assert!(root.svc.store.reserve_visit_payment(&payment).unwrap());
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("Expected details");
            };
            details.install_annotation_context(
                serde_json::from_value(json!({"rows": [], "hasVisitCheckout": true})).unwrap(),
            );
            let saved = root
                .svc
                .store
                .pending_visit_payment(group, "u")
                .unwrap()
                .unwrap();
            details.visit_payment = Some(Panel::new(
                group,
                root.time_off_scope.clone(),
                State::Saved {
                    payment: saved,
                    sending: false,
                },
            ));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("retry-visit-payment").is_some());
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Offline;
            let Overlay::Details(details) = &root.overlay else {
                panic!("Expected details");
            };
            assert!(
                !details
                    .visit_payment
                    .as_ref()
                    .unwrap()
                    .visible(root, details)
            );
            cx.notify();
        });
    }
}
