use super::*;
use sob_core::waitlist::{OfferRequirements, WaitlistEntry};
use std::collections::BTreeSet;

pub(super) struct OfferReview {
    entry: WaitlistEntry,
    requirements: Option<OfferRequirements>,
    can_waive: bool,
    selected: BTreeSet<String>,
    waiver: Entity<TextField>,
    _waiver_sub: Subscription,
    request: Option<AcceptOffer>,
    confirming_requeue: bool,
}

pub(super) struct PolicyReview {
    version: u32,
    enabled: bool,
    duration: Entity<TextField>,
}

impl OfferReview {
    fn requirements_met(&self) -> bool {
        self.requirements.as_ref().is_some_and(|data| {
            data.forms
                .iter()
                .filter(|form| form.definition.required_at_booking)
                .all(|form| {
                    data.ready_responses.iter().any(|answer| {
                        answer.revision_id == form.id && self.selected.contains(&answer.id)
                    })
                })
        })
    }

    fn offer_is_current(&self) -> bool {
        self.entry.can_manage
            && self.entry.state == WaitlistState::Offered
            && self
                .entry
                .offer
                .as_ref()
                .is_some_and(|offer| offer.expires_at > Utc::now())
    }
}

impl Root {
    pub(super) fn begin_waitlist_offer(&mut self, entry: WaitlistEntry, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || !entry.can_manage || entry.offer.is_none() {
            return;
        }
        desk.error = None;
        desk.busy = true;
        let locale = self.locale;
        let waiver =
            cx.new(|cx| TextField::new(i18n::t(locale, Key::WaitlistWaiverReason), false, cx));
        let waiver_sub = cx.subscribe(&waiver, |_, _, event, cx| {
            if matches!(event, FieldEvent::Changed) {
                cx.notify();
            }
        });
        desk.offer_review = Some(OfferReview {
            entry: entry.clone(),
            requirements: None,
            selected: BTreeSet::new(),
            can_waive: false,
            waiver,
            _waiver_sub: waiver_sub,
            request: None,
            confirming_requeue: false,
        });
        self.waitlist_generation = self.waitlist_generation.wrapping_add(1);
        let generation = self.waitlist_generation;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.waitlist_offer_requirements(&entry) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.waitlist_generation
                    || !Arc::ptr_eq(&session, &this.svc.session)
                    || this.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::Waitlist(desk) = &mut this.overlay else {
                    return;
                };
                desk.busy = false;
                match result {
                    Ok((requirements, can_waive)) => {
                        if let Some(review) = &mut desk.offer_review {
                            review.requirements = Some(requirements);
                            review.can_waive = can_waive;
                        }
                    }
                    Err(_) => desk.error = Some(Key::WaitlistError),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_waitlist_offer(&mut self, cx: &mut Context<Self>) {
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        let Some(review) = desk.offer_review.as_mut() else {
            return;
        };
        if desk.busy || !review.offer_is_current() || !review.requirements_met() {
            return;
        }
        let (Some(offer), Some(requirements)) = (&review.entry.offer, &review.requirements) else {
            return;
        };
        let reason = review.waiver.read(cx).text().trim();
        if offer.policy.enabled
            && (!review.can_waive || !(8..=300).contains(&reason.chars().count()))
        {
            return;
        }
        let mut input = AcceptOffer {
            version: review.entry.version,
            offer_id: offer.id.clone(),
            expected_total_cents: offer.price_cents,
            idempotency_key: review
                .request
                .as_ref()
                .map_or_else(WaitlistRequest::new_key, |prior| {
                    prior.idempotency_key.clone()
                }),
            intake_review_hash: requirements.review_hash.clone(),
            intake_submission_ids: review.selected.iter().cloned().collect(),
            protection_waiver_reason: offer.policy.enabled.then(|| reason.to_owned()),
        };
        if review.request.as_ref().is_some_and(|prior| prior != &input) {
            input.idempotency_key = WaitlistRequest::new_key();
        }
        review.request = Some(input.clone());
        let id = review.entry.id.clone();
        self.waitlist_request(Action::Accept(id, input), cx);
    }

    fn requeue_waitlist(&mut self, cx: &mut Context<Self>) {
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        let Some(review) = desk.offer_review.as_mut() else {
            return;
        };
        if desk.busy || !review.entry.can_manage {
            return;
        }
        if !review.confirming_requeue {
            review.confirming_requeue = true;
            cx.notify();
            return;
        }
        let Some(offer) = &review.entry.offer else {
            return;
        };
        let action = Action::Decline(
            review.entry.id.clone(),
            review.entry.version,
            offer.id.clone(),
        );
        self.waitlist_request(action, cx);
    }

    pub(super) fn open_waitlist_booking(
        &mut self,
        appointment: &BookedAppointment,
        cx: &mut Context<Self>,
    ) {
        self.overlay = Overlay::None;
        self.week_mode = false;
        self.pending_local_today = false;
        self.date = appointment.starts_at.with_timezone(&self.tz).date_naive();
        self.svc.wake(Wake::Manual);
        self.reload(cx);
        self.open_details(&appointment.id, cx);
    }

    pub(super) fn render_waitlist_offer(
        &self,
        review: &OfferReview,
        can_write: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let Some(offer) = &review.entry.offer else {
            return div();
        };
        let waiver = review.waiver.read(cx).text().trim();
        let allowed = can_write
            && review.offer_is_current()
            && review.requirements_met()
            && (!offer.policy.enabled
                || (review.can_waive && (8..=300).contains(&waiver.chars().count())));
        let mut body = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::WaitlistReviewOffer)),
            )
            .child(SharedString::from(format!(
                "{} – {}",
                self.date_time_label(offer.starts_at),
                self.hhmm(offer.ends_at)
            )))
            .child(SharedString::from(
                offer
                    .staff_name
                    .clone()
                    .unwrap_or_else(|| self.staff_name(&offer.staff_id)),
            ))
            .children(offer.services.iter().map(|service| {
                div().text_sm().child(SharedString::from(format!(
                    "{} · {}",
                    service.name,
                    self.amount_label(i64::from(service.price_cents), &service.currency)
                )))
            }))
            .child(SharedString::from(i18n::fill(
                self.t(Key::WaitlistOfferTotal),
                &[(
                    "amount",
                    &self.amount_label(i64::from(offer.price_cents), &offer.currency),
                )],
            )))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(SharedString::from(i18n::fill(
                        self.t(Key::WaitlistOfferExpires),
                        &[("date", &self.date_time_label(offer.expires_at))],
                    ))),
            )
            .when(offer.expires_at <= Utc::now(), |d| {
                d.child(self.t(Key::WaitlistOfferExpired))
            });
        if let Some(requirements) = &review.requirements {
            for form in requirements
                .forms
                .iter()
                .filter(|form| form.definition.required_at_booking)
            {
                let answer = requirements
                    .ready_responses
                    .iter()
                    .find(|answer| answer.revision_id == form.id);
                let mut row = div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_2()
                    .border_1()
                    .border_color(theme::line())
                    .rounded_lg()
                    .child(SharedString::from(form.definition.title.clone()));
                if let Some(answer) = answer {
                    let id = answer.id.clone();
                    row = row.child(self.chip(
                        SharedString::from(format!("wl-form-{id}")),
                        SharedString::from(i18n::fill(
                            self.t(Key::WaitlistUseResponse),
                            &[("date", &self.date_time_label(answer.created_at))],
                        )),
                        review.selected.contains(&id),
                        cx.listener(move |this, _, _, cx| {
                            if let Overlay::Waitlist(desk) = &mut this.overlay
                                && !desk.busy
                                && let Some(review) = &mut desk.offer_review
                            {
                                if !review.selected.remove(&id) {
                                    review.selected.insert(id.clone());
                                }
                                cx.notify();
                            }
                        }),
                    ));
                } else {
                    row = row.child(div().text_sm().child(self.t(Key::WaitlistFormsOnWeb)));
                }
                body = body.child(row);
            }
        }
        if offer.policy.enabled {
            body = body
                .child(div().text_sm().child(self.t(Key::WaitlistDepositWeb)))
                .when(review.can_waive, |d| d.child(review.waiver.clone()));
        }
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .id("wl-offer-body")
                    .max_h(px(430.))
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.review_back_button(cx))
                    .when(allowed, |d| {
                        d.child(self.button(
                            "wl-accept",
                            self.t(Key::WaitlistAcceptOffer),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.confirm_waitlist_offer(cx)),
                        ))
                    })
                    .when(can_write && review.entry.can_manage, |d| {
                        d.child(self.button(
                            "wl-requeue",
                            self.t(if review.confirming_requeue {
                                Key::WaitlistConfirmRequeue
                            } else {
                                Key::WaitlistRequeue
                            }),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.requeue_waitlist(cx)),
                        ))
                    }),
            )
    }

    pub(super) fn begin_waitlist_policy(&mut self, cx: &mut Context<Self>) {
        if !self
            .svc
            .current_session()
            .is_some_and(|session| session.role == "owner")
        {
            return;
        }
        let t = self.t(Key::WaitlistPolicyMinutes);
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.cached {
            return;
        }
        let Some(data) = &desk.data else {
            return;
        };
        let duration = cx.new(|cx| {
            let mut field = TextField::new(t, false, cx);
            field.set_text(&data.policy.offer_minutes.to_string(), cx);
            field
        });
        desk.policy_review = Some(PolicyReview {
            version: data.policy.version,
            enabled: data.policy.enabled,
            duration,
        });
        desk.error = None;
        cx.notify();
    }

    fn save_waitlist_policy(&mut self, cx: &mut Context<Self>) {
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        let Some(review) = &desk.policy_review else {
            return;
        };
        let Ok(offer_minutes) = review.duration.read(cx).text().trim().parse::<u32>() else {
            desk.error = Some(Key::WaitlistPolicyInvalid);
            cx.notify();
            return;
        };
        if !(5..=120).contains(&offer_minutes) {
            desk.error = Some(Key::WaitlistPolicyInvalid);
            cx.notify();
            return;
        }
        let policy = WaitlistPolicy {
            version: review.version,
            enabled: review.enabled,
            offer_minutes,
        };
        self.waitlist_request(Action::Policy(policy), cx);
    }

    pub(super) fn render_waitlist_policy(
        &self,
        review: &PolicyReview,
        can_write: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::WaitlistPolicySettings)),
            )
            .child(self.chip(
                "wl-policy-toggle",
                self.t(if review.enabled {
                    Key::WaitlistPolicyOn
                } else {
                    Key::WaitlistPolicyOff
                }),
                review.enabled,
                cx.listener(|this, _, _, cx| {
                    if let Overlay::Waitlist(desk) = &mut this.overlay
                        && !desk.busy
                        && let Some(review) = &mut desk.policy_review
                    {
                        review.enabled = !review.enabled;
                        cx.notify();
                    }
                }),
            ))
            .child(self.t(Key::WaitlistPolicyMinutes))
            .child(review.duration.clone())
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(self.review_back_button(cx))
                    .when(can_write, |d| {
                        d.child(self.button(
                            "wl-save-policy",
                            self.t(Key::WaitlistPolicySave),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.save_waitlist_policy(cx)),
                        ))
                    }),
            )
    }

    fn review_back_button(&self, cx: &mut Context<Self>) -> Stateful<gpui::Div> {
        self.button(
            "wl-back",
            self.t(Key::Back),
            Kind::Ghost,
            cx.listener(|this, _, _, cx| {
                if let Overlay::Waitlist(desk) = &mut this.overlay
                    && !desk.busy
                {
                    desk.offer_review = None;
                    desk.policy_review = None;
                    desk.error = None;
                    cx.notify();
                }
            }),
        )
    }
}
