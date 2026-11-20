use super::intake_editor::{self, IntakeDraft};
use super::*;
use sob_core::booking::{BookingError, BookingTerms, ReviewedBooking};
use sob_core::sync::TransportError;

pub(super) struct BookingReview {
    identity: Arc<()>,
    terms: BookingTerms,
    service_summary: Vec<String>,
    forms: Vec<IntakeDraft>,
    review_hash: Option<String>,
    submitted: Option<ReviewedBooking>,
    busy: bool,
    restored: bool,
    confirm_exit: bool,
}

impl BookingReview {
    pub(super) fn blocks_dismissal(&self) -> bool {
        self.submitted.is_some()
    }

    fn packet(&self, cx: &App) -> Option<ReviewedBooking> {
        let hash = self.review_hash.as_ref()?;
        let selection = intake_editor::selection(&self.forms, cx)?;
        Some(self.terms.reviewed(hash.clone(), selection))
    }
}

impl Root {
    pub(super) fn editable_intake_forms(&mut self) -> Option<&mut Vec<IntakeDraft>> {
        match &mut self.overlay {
            Overlay::Waitlist(desk) => desk.editable_intake(),
            Overlay::New(form) => {
                let review = form.intake.as_mut()?;
                (!review.busy && review.submitted.is_none() && review.review_hash.is_some())
                    .then_some(&mut review.forms)
            }
            _ => None,
        }
    }

    pub(super) fn set_intake_editor_error(&mut self, key: Key) {
        match &mut self.overlay {
            Overlay::Waitlist(desk) => desk.set_intake_error(key),
            Overlay::New(form) => form.error = Some(key),
            _ => {}
        }
    }

    pub(super) fn start_booking_intake(&mut self, terms: BookingTerms, cx: &mut Context<Self>) {
        let service_summary = terms
            .services()
            .iter()
            .map(|service| {
                format!(
                    "{} · {}",
                    service.name,
                    self.amount_label(service.price_cents, &service.currency)
                )
            })
            .collect();
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        form.error = None;
        form.intake = Some(BookingReview {
            terms,
            service_summary,
            identity: Arc::new(()),
            forms: Vec::new(),
            review_hash: None,
            submitted: None,
            busy: false,
            restored: false,
            confirm_exit: false,
        });
        self.fetch_booking_requirements(cx);
    }

    fn fetch_booking_requirements(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && !review.restored && review.submitted.is_none())
        else {
            return;
        };
        let identity = review.identity.clone();
        let terms = review.terms.clone();
        let session = self.svc.session.clone();
        review.busy = true;
        review.review_hash = None;
        form.error = None;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.direct_booking_requirements(&terms) })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::New(form) = &mut root.overlay else {
                    return;
                };
                let Some(review) = form
                    .intake
                    .as_mut()
                    .filter(|review| Arc::ptr_eq(&review.identity, &identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok(requirements) => {
                        let Some(generation) = requirements.desktop_generation.clone() else {
                            form.error = Some(Key::BookingIntakeUnavailable);
                            cx.notify();
                            return;
                        };
                        if review.terms.generation() != generation {
                            review.restored = true;
                            form.error = Some(Key::BookingIntakeRestore);
                            cx.notify();
                            return;
                        }
                        let hash = requirements.review_hash.clone();
                        intake_editor::refresh(&mut review.forms, requirements, root.locale, cx);
                        review.review_hash = Some(hash);
                        if review.forms.is_empty() {
                            root.confirm_booking_intake(cx);
                            return;
                        }
                    }
                    Err(_) => form.error = Some(Key::BookingIntakeUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_booking_intake(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && !review.restored)
        else {
            return;
        };
        let Some(packet) = review.submitted.clone().or_else(|| review.packet(cx)) else {
            return;
        };
        if let Err(error) = packet.mark_local_dispatch(&mut self.svc.store) {
            if matches!(error, CoreError::CalendarGenerationChanged) {
                review.submitted = None;
                review.restored = true;
                form.error = Some(Key::BookingIntakeRestore);
                self.svc.wake(Wake::Manual);
            } else {
                form.error = Some(Key::ErrGeneric);
            }
            cx.notify();
            return;
        }
        let retrying_pending = review.submitted.is_some();
        let identity = review.identity.clone();
        let session = self.svc.session.clone();
        review.busy = true;
        review.submitted = Some(packet.clone());
        review.confirm_exit = false;
        form.error = None;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.create_reviewed_booking(&packet) })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Overlay::New(form) = &mut root.overlay else {
                    return;
                };
                let Some(review) = form
                    .intake
                    .as_mut()
                    .filter(|review| Arc::ptr_eq(&review.identity, &identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok(saved) => {
                        root.finish_new_booking(saved.starts_at, cx);
                        return;
                    }
                    Err(BookingError::IntakeChanged) => {
                        review.submitted = None;
                        review.review_hash = None;
                        form.error = Some(Key::WaitlistFormsChanged);
                    }
                    Err(BookingError::SlotUnavailable) => {
                        form.intake = None;
                        form.error = Some(Key::ConflictSlotTaken);
                    }
                    Err(BookingError::CatalogueChanged) => {
                        form.intake = None;
                        form.error = Some(Key::ErrRefreshCatalog);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::IntentConflict) => {
                        review.submitted = None;
                        review.restored = true;
                        form.error = Some(Key::BookingIntakeIntentConflict);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::AccessChanged) => {
                        if !retrying_pending {
                            form.intake = None;
                        }
                        form.error = Some(Key::BookingIntakeAccessChanged);
                    }
                    Err(BookingError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        review.submitted = None;
                        review.restored = true;
                        form.error = Some(Key::BookingIntakeRestore);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::Rejected) => {
                        review.submitted = None;
                        form.error = Some(Key::BookingIntakeRejected);
                    }
                    Err(_) => form.error = Some(Key::BookingIntakeUnconfirmed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn back_from_booking_intake(&mut self, cx: &mut Context<Self>) {
        if let Overlay::New(form) = &mut self.overlay
            && form
                .intake
                .as_ref()
                .is_some_and(|review| !review.blocks_dismissal())
        {
            form.intake = None;
            form.error = None;
            cx.notify();
        }
    }

    pub(super) fn render_booking_intake(
        &self,
        form: &NewForm,
        review: &BookingReview,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let awaiting = review.submitted.is_some();
        let mut body = div()
            .id("booking-intake-scroll")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_sm()
                    .child(self.date_time_label(review.terms.starts_at())),
            );
        body = body.children(
            review
                .service_summary
                .iter()
                .map(|summary| div().text_sm().child(summary.clone())),
        );
        if !awaiting && review.review_hash.is_some() && !review.restored && !review.busy {
            for draft in &review.forms {
                body = body.child(self.render_intake_form(draft, cx));
            }
        }
        if review.busy {
            body = body.child(self.t(Key::WaitlistLoading));
        }
        let mut actions = div().flex_none().flex().flex_wrap().gap_2();
        if !awaiting {
            actions = actions.child(
                self.button(
                    "booking-review-back",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.back_from_booking_intake(cx)),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text())),
            );
        }
        if awaiting && !review.busy {
            actions = actions.child(
                self.button(
                    "booking-review-exit",
                    self.t(if review.confirm_exit {
                        Key::BookingIntakeExitConfirm
                    } else {
                        Key::BookingIntakeExit
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.exit_unconfirmed_booking(cx)),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text())),
            );
        }
        if online && !review.busy && !review.restored {
            if !awaiting && (review.review_hash.is_none() || !review.forms.is_empty()) {
                actions = actions.child(
                    self.button(
                        "booking-review-reload",
                        self.t(Key::WaitlistRefreshForms),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.fetch_booking_requirements(cx)),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text())),
                );
            }
            if awaiting || review.packet(cx).is_some() {
                actions = actions.child(
                    self.button(
                        "booking-review-confirm",
                        self.t(if awaiting {
                            Key::WaitlistRetryAcceptance
                        } else {
                            Key::WaitlistAcceptOffer
                        }),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.confirm_booking_intake(cx)),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text()))
                    .debug_selector(|| "booking-review-confirm".to_owned()),
                );
            }
        }
        self.modal_with_height(
            div()
                .child(
                    div()
                        .flex_none()
                        .text_xl()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::BookingIntakeTitle)),
                )
                .child(body)
                .when_some(form.error, |panel, error| {
                    panel.child(
                        div()
                            .flex_none()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .when(!online, |panel| {
                    panel.child(self.t(Key::BookingIntakeOffline))
                })
                .child(actions),
            (viewport.width - px(24.)).clamp(px(0.), px(660.)),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }

    fn exit_unconfirmed_booking(&mut self, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && review.submitted.is_some())
        else {
            return;
        };
        if review.confirm_exit {
            self.overlay = Overlay::None;
            self.svc.wake(Wake::Manual);
        } else {
            review.confirm_exit = true;
            form.error = Some(Key::BookingIntakeExitHelp);
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn a_calendar_booking_requires_confirmation_and_keeps_answers_out_of_the_outbox(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            root.open_new(window, cx);
            root
        });
        entity.update(cx, |root, cx| {
            let staff_id = root.staff[0].id.clone();
            let service_id = ops::performed_services(&root.svc.store, &staff_id).unwrap().remove(0);
            let terms = BookingTerms::prepare(&root.svc.store, NewAppointment {
                staff_id, service_ids: vec![service_id], client_id: root.clients[0].0.clone(),
                starts_at: "2026-03-09T13:00:00Z".parse().unwrap(), notes: None, override_notice: false,
            }, None).unwrap();
            root.start_booking_intake(terms, cx);
            let Overlay::New(form) = &mut root.overlay else { panic!("missing booking editor"); };
            let review = form.intake.as_mut().unwrap();
            review.review_hash = Some("a".repeat(64));
            let revision = serde_json::from_value(json!({
                "id":"rev","definition":{"title":"Synthetic calendar form","description":"",
                    "requiredAtBooking":true,"allowTeamResponses":true,"fields":[
                        {"id":"q","label":"Do you agree?","help":"","kind":"boolean","required":true}
                    ]}
            })).unwrap();
            review.forms = vec![IntakeDraft::new(revision, None, root.locale, cx)];
            cx.notify();
        });
        let click = |cx: &mut gpui::VisualTestContext, selector| {
            cx.run_until_parked();
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing {selector}"));
            cx.simulate_click(bounds.center(), Default::default());
            cx.run_until_parked();
        };
        click(cx, "intake-rev-q-false");
        assert!(cx.debug_bounds("booking-review-confirm").is_none());
        click(cx, "intake-confirm-rev");
        assert!(cx.debug_bounds("booking-review-confirm").is_some());
        entity.update(cx, |root, cx| {
            let Overlay::New(form) = &root.overlay else {
                panic!("missing booking editor");
            };
            let review = form.intake.as_ref().unwrap();
            let payload = serde_json::to_value(review.packet(cx).unwrap()).unwrap();
            assert_eq!(payload["intakeResponses"][0]["answers"]["q"], false);
            assert!(root.svc.store.outbox(10).unwrap().is_empty());
        });
    }
}
