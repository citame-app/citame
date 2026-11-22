use super::super::intake_editor::{self, IntakeDraft};
use super::*;
use sob_core::intake::IntakeSelection;
use sob_core::waitlist::WaitlistEntry;

pub(super) struct OfferReview {
    entry: WaitlistEntry,
    review_hash: Option<String>,
    can_waive: bool,
    forms: Vec<IntakeDraft>,
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
    pub(super) fn is_acceptance_retry(&self, action: &Action) -> bool {
        matches!(action, Action::Accept(id, input)
            if id == &self.entry.id && self.request.as_ref() == Some(input))
    }

    pub(super) fn editable_intake(&mut self) -> Option<&mut Vec<IntakeDraft>> {
        self.request.is_none().then_some(&mut self.forms)
    }

    fn intake_selection(&self, cx: &App) -> Option<IntakeSelection> {
        self.review_hash.as_ref()?;
        intake_editor::selection(&self.forms, cx)
    }

    pub(super) fn require_intake_review(&mut self) {
        self.clear_request();
        self.review_hash = None;
    }

    pub(super) fn clear_request(&mut self) {
        self.request = None;
    }

    pub(super) fn is_same_offer(&self, entry: &WaitlistEntry) -> bool {
        entry.can_manage
            && entry.state == WaitlistState::Offered
            && entry.id == self.entry.id
            && entry.version == self.entry.version
            && entry.offer.as_ref().is_some_and(|offer| {
                offer.expires_at > Utc::now()
                    && self
                        .entry
                        .offer
                        .as_ref()
                        .is_some_and(|prior| prior.id == offer.id)
            })
    }
}

impl Root {
    pub(super) fn begin_waitlist_offer(&mut self, entry: WaitlistEntry, cx: &mut Context<Self>) {
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || !entry.can_manage || entry.offer.is_none() {
            return;
        }
        let locale = self.locale;
        let waiver =
            cx.new(|cx| TextField::new(i18n::t(locale, Key::WaitlistWaiverReason), false, cx));
        let waiver_sub = cx.subscribe(&waiver, |_, _, event, cx| {
            if matches!(event, FieldEvent::Changed) {
                cx.notify();
            }
        });
        desk.offer_review = Some(OfferReview {
            entry,
            review_hash: None,
            forms: Vec::new(),
            can_waive: false,
            waiver,
            _waiver_sub: waiver_sub,
            request: None,
            confirming_requeue: false,
        });
        self.load_waitlist_offer_requirements(cx);
    }

    fn load_waitlist_offer_requirements(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Waitlist(desk) = &mut self.overlay else {
            return;
        };
        let Ok(scope) = self.svc.store.waitlist_cache_scope() else {
            return;
        };
        if desk.cached {
            return;
        }
        if !scope.permits_read() || Some(&scope) != desk.scope.as_ref() {
            desk.reject_scope();
            cx.notify();
            return;
        }
        let Some(review) = desk
            .offer_review
            .as_mut()
            .filter(|review| !desk.busy && review.request.is_none())
        else {
            return;
        };
        let entry = review.entry.clone();
        review.review_hash = None;
        desk.busy = true;
        desk.error = None;
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
                if this.svc.store.waitlist_cache_scope().ok().as_ref() != Some(&scope) {
                    desk.reject_scope();
                    cx.notify();
                    return;
                }
                match result {
                    Ok((requirements, can_waive)) => {
                        if let Some(review) = &mut desk.offer_review {
                            review.review_hash = Some(requirements.review_hash.clone());
                            intake_editor::refresh(
                                &mut review.forms,
                                requirements,
                                this.locale,
                                cx,
                            );
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
        if desk.busy || self.status.connectivity != Connectivity::Online {
            return;
        }
        if let Some(input) = &review.request {
            let action = Action::Accept(review.entry.id.clone(), input.clone());
            self.waitlist_request(action, cx);
            return;
        }
        if desk.cached {
            return;
        }
        let (Some(review_hash), Some(selection)) =
            (&review.review_hash, review.intake_selection(cx))
        else {
            return;
        };
        let Some(input) = review.entry.reviewed_acceptance(
            Utc::now(),
            review.can_waive,
            review.waiver.read(cx).text(),
            review_hash.clone(),
            selection,
        ) else {
            return;
        };
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
        if desk.busy || !review.entry.can_manage || review.request.is_some() {
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
        self.calendar_mode = CalendarMode::Day;
        self.overview_staff.clear();
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
        let allowed = can_write
            && review
                .entry
                .reviewable_offer(Utc::now(), review.can_waive, review.waiver.read(cx).text())
                .is_some()
            && review.intake_selection(cx).is_some();
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
        let awaiting_confirmation = review.request.is_some();
        if !awaiting_confirmation && review.review_hash.is_some() {
            for form in &review.forms {
                body = body.child(self.render_intake_form(form, cx));
            }
        } else if awaiting_confirmation {
            body = body.child(self.t(Key::WaitlistAcceptanceSubmitted));
        }
        if offer.policy.enabled {
            body = body
                .child(div().text_sm().child(self.t(Key::WaitlistDepositWeb)))
                .when(review.can_waive && !awaiting_confirmation, |d| {
                    d.child(review.waiver.clone())
                });
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
                    .when(
                        can_write
                            && !awaiting_confirmation
                            && (review.review_hash.is_none() || !review.forms.is_empty()),
                        |d| {
                            d.child(
                                self.button(
                                    "wl-load-forms",
                                    self.t(Key::WaitlistRefreshForms),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| {
                                        this.load_waitlist_offer_requirements(cx)
                                    }),
                                )
                                .tab_index(0)
                                .focus(|style| style.border_color(theme::text())),
                            )
                        },
                    )
                    .when(
                        allowed
                            || (awaiting_confirmation
                                && self.status.connectivity == Connectivity::Online
                                && matches!(&self.overlay, Overlay::Waitlist(desk) if !desk.busy)),
                        |d| {
                            d.child(
                                self.button(
                                    "wl-accept",
                                    self.t(if awaiting_confirmation {
                                        Key::WaitlistRetryAcceptance
                                    } else {
                                        Key::WaitlistAcceptOffer
                                    }),
                                    Kind::Primary,
                                    cx.listener(|this, _, _, cx| this.confirm_waitlist_offer(cx)),
                                )
                                .tab_index(0)
                                .focus(|style| style.border_color(theme::text()))
                                .debug_selector(|| "wl-accept".to_owned()),
                            )
                        },
                    )
                    .when(
                        can_write && review.entry.can_manage && !awaiting_confirmation,
                        |d| {
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
                        },
                    ),
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

#[cfg(test)]
pub(in crate::root) fn show_intake_test_offer(root: &mut Root, cx: &mut Context<Root>) {
    use serde_json::json;
    let now = Utc::now();
    let entry = serde_json::from_value(json!({
        "id":"offer-entry","clientId":"client","serviceIds":[],"serviceNames":[],
        "fromDate":now.date_naive(),"toDate":now.date_naive(),
        "fromTime":"10:00","toTime":"12:00","state":"offered","version":2,"canManage":true,
        "offer":{"id":"offer","staffId":"staff","staffName":"Test professional",
            "startsAt":now,"endsAt":now + chrono::Duration::minutes(30),
            "expiresAt":now + chrono::Duration::hours(1),"priceCents":1500,
            "currency":"EUR","services":[],"policy":{"enabled":false}},
    }))
    .unwrap();
    let form = serde_json::from_value(json!({
        "id":"rev","definition":{"title":"Synthetic form","description":"","requiredAtBooking":true,
            "allowTeamResponses":true,"fields":[
                {"id":"q","label":"Does this apply?","help":"","kind":"boolean","required":true}
            ]}
    }))
    .unwrap();
    let waiver = cx.new(|cx| TextField::new("", false, cx));
    let waiver_sub = cx.observe(&waiver, |_, _, cx| cx.notify());
    root.overlay = Overlay::Waitlist(Box::new(Desk {
        active: true,
        page: 1,
        scope: root.svc.store.waitlist_cache_scope().ok(),
        data: None,
        saved_pages: vec![],
        busy: false,
        cached: false,
        error: None,
        confirm: None,
        form: None,
        policy_review: None,
        booked: None,
        observed_revision: 0,
        requested_at: Instant::now(),
        offer_review: Some(OfferReview {
            entry,
            review_hash: Some("current".into()),
            can_waive: false,
            forms: vec![IntakeDraft::new(form, None, root.locale, cx)],
            waiver,
            _waiver_sub: waiver_sub,
            request: None,
            confirming_requeue: false,
        }),
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn an_uncertain_acceptance_can_retry_the_frozen_request_on_a_saved_page(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, window) = super::super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.status.connectivity = Connectivity::Online;
                show_intake_test_offer(root, cx);
                let Overlay::Waitlist(desk) = &mut root.overlay else {
                    panic!("missing waitlist");
                };
                desk.cached = true;
                let review = desk.offer_review.as_mut().unwrap();
                let input = review
                    .entry
                    .reviewed_acceptance(
                        Utc::now(),
                        false,
                        "",
                        "current".into(),
                        IntakeSelection {
                            saved: vec![],
                            inline: vec![],
                        },
                    )
                    .unwrap();
                review.request = Some(input.clone());
                let id = review.entry.id.clone();
                let mut other = input;
                other.idempotency_key.push_str("-other");
                root.waitlist_request(Action::Accept(id, other), cx);
                assert!(matches!(&root.overlay, Overlay::Waitlist(desk) if !desk.busy));
                root.confirm_waitlist_offer(cx);
                assert!(matches!(&root.overlay, Overlay::Waitlist(desk) if desk.busy));
            })
            .unwrap();
    }
}
