use super::*;
use sob_core::loyalty::checkout::{
    Application, AppointmentTiming, Choice, Quote, ReturnPoints, RewardError, RewardKind,
};

enum Review {
    Apply {
        application: Application,
        quote: Quote,
    },
    Return(ReturnPoints),
}

struct ReviewedReward {
    command: Arc<Review>,
    uncertain: bool,
}

enum Request {
    Balance(Uuid),
    Quote(Choice),
    Write,
}

enum Response {
    Balance(Option<u64>),
    Quote(Choice, Quote),
    Receipt(Box<AppointmentCheckout>),
}

pub(super) struct Editor {
    identity: Arc<()>,
    generation: String,
    returning: bool,
    kind: RewardKind,
    input: Entity<TextField>,
    _changed: Subscription,
    balance: Option<u64>,
    review: Option<ReviewedReward>,
    observed_balance: i64,
    balance_retry_at: Option<Instant>,
    retry_at: Option<Instant>,
    feedback: Option<Key>,
}

impl Editor {
    pub(super) fn uncertain(&self) -> bool {
        self.review.as_ref().is_some_and(|review| review.uncertain)
    }

    pub(super) fn reconcile_receipt(
        &mut self,
        previous: &AppointmentCheckout,
        current: &AppointmentCheckout,
    ) -> bool {
        if self.returning {
            if !current.can_return_points() {
                return false;
            }
        } else if current.reward_client().is_none() {
            return false;
        }
        if previous.total_cents != current.total_cents
            || previous.pricing_version != current.pricing_version
            || previous.reward_client() != current.reward_client()
        {
            self.reset_review();
            self.feedback = Some(Key::CheckoutRewardChanged);
        }
        true
    }

    fn choice(&self, cx: &App) -> Option<Choice> {
        let input = self.input.read(cx).text();
        match self.kind {
            RewardKind::Promotion => Choice::promotion(input),
            RewardKind::Points => {
                let choice = Choice::points(input)?;
                match choice {
                    Choice::Points { points }
                        if self.balance.is_some_and(|n| u64::from(points) <= n) =>
                    {
                        Some(choice)
                    }
                    _ => None,
                }
            }
        }
    }

    fn limited(&self) -> bool {
        self.retry_at
            .is_some_and(|deadline| Instant::now() < deadline)
    }

    fn reset_review(&mut self) {
        self.review = None;
        self.feedback = None;
    }
}

impl Root {
    pub(in crate::root) fn refresh_checkout_reward_balance(&mut self, cx: &mut Context<Self>) {
        let revision = self
            .svc
            .store
            .live_view_revision(sob_core::loyalty::LIVE_TOPIC)
            .unwrap_or_default();
        let Some(form) = self
            .reward_form()
            .filter(|form| !form.busy && !form.refreshing)
        else {
            return;
        };
        let Some(editor) = form.reward_editor.as_ref().filter(|editor| {
            !editor.returning
                && !editor.uncertain()
                && !editor.limited()
                && editor
                    .balance_retry_at
                    .is_none_or(|deadline| Instant::now() >= deadline)
                && editor.observed_balance != revision
        }) else {
            return;
        };
        if editor.feedback == Some(Key::CheckoutRewardRestored) {
            return;
        }
        if let Some(client) = form.receipt.reward_client() {
            self.request_checkout_reward(Request::Balance(client), cx);
        }
    }

    fn open_checkout_reward(&mut self, returning: bool, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        let client = form.receipt.reward_client();
        if !form.is_idle()
            || form.refreshing
            || if returning {
                !form.receipt.can_return_points()
            } else {
                client.is_none()
            }
        {
            return;
        }
        let input = cx.new(|cx| TextField::new("", false, cx));
        let changed = cx.observe(&input, |_, _, cx| cx.notify());
        form.pass_picker = None;
        form.reward_editor = Some(Editor {
            identity: Arc::new(()),
            generation,
            returning,
            kind: RewardKind::Promotion,
            input,
            _changed: changed,
            balance: None,
            review: None,
            observed_balance: -1,
            balance_retry_at: None,
            retry_at: None,
            feedback: None,
        });
        cx.notify();
        if !returning && let Some(client) = client {
            self.request_checkout_reward(Request::Balance(client), cx);
        }
    }

    pub(in crate::root) fn leave_checkout_reward(&mut self, cx: &mut Context<Self>) -> bool {
        let online = self.status.connectivity == Connectivity::Online;
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return false;
        };
        let Some(editor) = &mut form.reward_editor else {
            return false;
        };
        if !form.busy && !editor.uncertain() {
            if editor.review.is_some() {
                editor.reset_review();
            } else {
                form.reward_editor = None;
                // Recheck totals even if a remote change arrived while this editor was open.
                form.observed_revision = -1;
                if online {
                    self.refresh_checkout_if_changed(cx);
                }
            }
            cx.notify();
        }
        true
    }

    fn reward_form(&mut self) -> Option<&mut ReceiptForm> {
        match self.checkout_review_mut()? {
            CheckoutReview::Receipt(form) if form.reward_editor.is_some() => Some(form),
            _ => None,
        }
    }

    fn preview_checkout_reward(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.reward_form() else {
            return;
        };
        let Some(editor) = form.reward_editor.as_mut().filter(|editor| {
            !form.busy && !editor.uncertain() && editor.review.is_none() && !editor.limited()
        }) else {
            return;
        };
        if editor.returning {
            if let Some(review) = ReturnPoints::reviewed(editor.input.read(cx).text()) {
                editor.review = Some(ReviewedReward {
                    command: Arc::new(Review::Return(review)),
                    uncertain: false,
                });
                cx.notify();
            }
        } else if let Some(choice) = editor.choice(cx) {
            self.request_checkout_reward(Request::Quote(choice), cx);
        }
    }

    fn request_checkout_reward(&mut self, request: Request, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        let session = self.svc.session.clone();
        let balance_revision = self
            .svc
            .store
            .live_view_revision(sob_core::loyalty::LIVE_TOPIC)
            .unwrap_or_default();
        let Some(form) = self
            .reward_form()
            .filter(|form| !form.busy && !form.refreshing)
        else {
            return;
        };
        let Some(editor) = form
            .reward_editor
            .as_mut()
            .filter(|editor| !editor.limited())
        else {
            return;
        };
        if generation.as_ref() != Some(&editor.generation) {
            editor.reset_review();
            editor.feedback = Some(Key::CheckoutRewardRestored);
            cx.notify();
            return;
        }
        let writing = matches!(request, Request::Write);
        let refreshing_balance = matches!(request, Request::Balance(_));
        let review = editor.review.as_ref().map(|review| review.command.clone());
        if writing && review.is_none() {
            return;
        }
        let generation = editor.generation.clone();
        let identity = editor.identity.clone();
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        if !refreshing_balance {
            editor.feedback = None;
        }
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match request {
                        Request::Balance(client) => transport
                            .loyalty_statement(client, 1)
                            .map(|value| {
                                Response::Balance(
                                    value.policy.enabled.then_some(value.available_points),
                                )
                            })
                            .map_err(RewardError::from),
                        Request::Quote(choice) => {
                            let quote = transport.quote_checkout_reward(&receipt, &choice)?;
                            Ok(Response::Quote(choice, quote))
                        }
                        Request::Write => {
                            let result = match review
                                .as_deref()
                                .expect("a submission has a frozen review")
                            {
                                Review::Apply { application, .. } => transport
                                    .apply_checkout_reward(&receipt, application, &generation),
                                Review::Return(input) => {
                                    transport.return_checkout_points(&receipt, input, &generation)
                                }
                            };
                            result.map(|receipt| Response::Receipt(Box::new(receipt)))
                        }
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(form) = root
                    .reward_form()
                    .filter(|form| Arc::ptr_eq(&form.receipt, &previous))
                else {
                    return;
                };
                let Some(editor) = form
                    .reward_editor
                    .as_mut()
                    .filter(|editor| Arc::ptr_eq(&editor.identity, &identity))
                else {
                    return;
                };
                form.busy = false;
                match result {
                    Ok(Response::Balance(balance)) => {
                        editor.observed_balance = balance_revision;
                        editor.balance_retry_at = None;
                        editor.balance = balance;
                        if editor.feedback == Some(Key::CheckoutRewardBalanceFailed) {
                            editor.feedback = None;
                        }
                        if editor.kind == RewardKind::Points && editor.choice(cx).is_none() {
                            if editor.review.is_some() {
                                editor.reset_review();
                                editor.feedback = Some(Key::CheckoutRewardChanged);
                            }
                            if !balance.is_some_and(|points| points > 0) {
                                editor.kind = RewardKind::Promotion;
                                editor.input.update(cx, |field, cx| field.clear(cx));
                            }
                        }
                    }
                    Ok(Response::Quote(choice, quote)) => {
                        if editor.choice(cx).as_ref() != Some(&choice) {
                            editor.feedback = Some(Key::CheckoutRewardChanged);
                        } else if let Some(review) =
                            Application::reviewed(choice, &quote, form.receipt.total_cents)
                        {
                            editor.review = Some(ReviewedReward {
                                command: Arc::new(Review::Apply {
                                    application: review,
                                    quote,
                                }),
                                uncertain: false,
                            });
                        } else {
                            editor.feedback = Some(Key::CheckoutRewardChanged);
                        }
                    }
                    Ok(Response::Receipt(receipt)) => {
                        form.reward_editor = None;
                        form.selected = None;
                        form.error = None;
                        form.observed_revision = revision;
                        form.amount.update(cx, |field, cx| {
                            field.set_text(&amount_entry(receipt.collectible_cents()), cx)
                        });
                        form.gift_code.update(cx, |field, cx| field.clear(cx));
                        form.replace_receipt(*receipt, cx);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(error) if refreshing_balance => {
                        match error {
                            RewardError::Transport(
                                TransportError::Forbidden(_) | TransportError::Unauthorized,
                            ) => {
                                editor.observed_balance = balance_revision;
                                editor.balance = None;
                                if editor.kind == RewardKind::Points {
                                    editor.reset_review();
                                    editor.kind = RewardKind::Promotion;
                                    editor.input.update(cx, |field, cx| field.clear(cx));
                                }
                            }
                            RewardError::Transport(TransportError::RateLimited(delay)) => {
                                editor.balance_retry_at = Instant::now()
                                    .checked_add(delay.unwrap_or(Duration::from_secs(10)));
                            }
                            _ => {
                                editor.balance_retry_at =
                                    Instant::now().checked_add(Duration::from_secs(10))
                            }
                        }
                        if editor.feedback.is_none() {
                            editor.feedback = Some(Key::CheckoutRewardBalanceFailed);
                        }
                    }
                    Err(error) => {
                        let mut uncertain = false;
                        let feedback = match error {
                            RewardError::Conflict => Key::CheckoutRewardChanged,
                            RewardError::Timing => Key::CheckoutRewardTimingMismatch,
                            RewardError::Transport(TransportError::ReplicaGenerationChanged) => {
                                Key::CheckoutRewardRestored
                            }
                            RewardError::Transport(TransportError::RateLimited(delay)) => {
                                editor.retry_at = Instant::now()
                                    .checked_add(delay.unwrap_or(Duration::from_secs(10)));
                                uncertain = writing;
                                Key::CheckoutRewardRetryLater
                            }
                            RewardError::Transport(
                                TransportError::Server(_) | TransportError::Offline(_),
                            ) if writing => {
                                uncertain = true;
                                Key::CheckoutRewardUnconfirmed
                            }
                            _ => Key::CheckoutRewardUnavailable,
                        };
                        // Once a write was unconfirmed, a subsequent permission or validation
                        // failure cannot prove whether the previous attempt committed.
                        if editor.uncertain()
                            && !matches!(
                                feedback,
                                Key::CheckoutRewardChanged | Key::CheckoutRewardRestored
                            )
                        {
                            uncertain = true;
                        }
                        if let Some(review) = &mut editor.review {
                            review.uncertain = uncertain;
                        }
                        if !uncertain {
                            editor.reset_review();
                        }
                        editor.feedback = Some(feedback);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn reward_button(
        &self,
        id: &'static str,
        key: Key,
        kind: Kind,
        action: impl Fn(&mut Root, &mut Context<Root>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.checkout_keyboard_button(
            id,
            self.t(key),
            kind,
            cx.listener(move |root, _, _, cx| action(root, cx)),
        )
    }

    fn checkout_reward_timing(&self, condition: &AppointmentTiming) -> String {
        let hours =
            i18n::promotion_timing_label(self.locale, &condition.timing, &condition.time_zone);
        if let Some(last_minute) = condition.timing.last_minute_hours {
            format!(
                "{hours} · {}",
                i18n::fill(
                    self.t(Key::CheckoutRewardLastMinute),
                    &[("hours", &last_minute.to_string())]
                )
            )
        } else {
            hours
        }
    }

    pub(super) fn render_checkout_reward(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let receipt = &form.receipt;
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && form.is_idle() && !form.refreshing;
        if let Some(reward) = &receipt.reward {
            let name = if reward.kind == RewardKind::Points {
                self.t(Key::CheckoutRewardPoints)
            } else {
                &reward.name
            };
            return div()
                .flex()
                .flex_col()
                .gap_2()
                .child(format!(
                    "{name} · {}",
                    self.amount_label(i64::from(reward.discount_cents), &receipt.currency)
                ))
                .when_some(reward.code.as_ref(), |view, code| view.child(code.clone()))
                .when_some(reward.appointment_timing.as_ref(), |view, timing| {
                    view.child(self.checkout_reward_timing(timing))
                        .child(self.t(Key::CheckoutRewardReschedule))
                })
                .when(reward.points_used > 0, |view| {
                    view.child(i18n::fill(
                        self.t(Key::CheckoutRewardUsed),
                        &[("points", &reward.points_used.to_string())],
                    ))
                })
                .when(reward.returned_points > 0, |view| {
                    view.child(i18n::fill(
                        self.t(Key::CheckoutRewardReturned),
                        &[("points", &reward.returned_points.to_string())],
                    ))
                })
                .when(ready && receipt.can_return_points(), |view| {
                    view.child(self.reward_button(
                        "checkout-return-points",
                        Key::CheckoutRewardReturn,
                        Kind::Ghost,
                        |root, cx| root.open_checkout_reward(true, cx),
                        cx,
                    ))
                });
        }
        div().when(ready && receipt.reward_client().is_some(), |view| {
            view.child(self.reward_button(
                "checkout-use-reward",
                Key::CheckoutRewardTitle,
                Kind::Ghost,
                |root, cx| root.open_checkout_reward(false, cx),
                cx,
            ))
        })
    }

    pub(super) fn render_reward_editor(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let Some(editor) = &form.reward_editor else {
            return div();
        };
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !form.busy && !form.refreshing;
        let title = if editor.returning {
            Key::CheckoutRewardReturn
        } else {
            Key::CheckoutRewardTitle
        };
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(title))
            .when(!online, |view| view.child(self.t(Key::CheckoutOffline)))
            .when(form.busy, |view| view.child(self.t(Key::CheckoutLoading)))
            .when_some(editor.feedback, |view, key| {
                view.child(div().text_color(theme::conflict_fg()).child(self.t(key)))
            });
        if let Some(review) = &editor.review {
            let quote = match review.command.as_ref() {
                Review::Apply { application, quote } => Some((application.choice(), quote)),
                Review::Return(_) => None,
            };
            return body
                .when_some(quote, |view, (choice, quote)| {
                    let name = if quote.kind == RewardKind::Points {
                        self.t(Key::CheckoutRewardPoints)
                    } else {
                        &quote.name
                    };
                    let reviewed = match choice {
                        Choice::Points { points } => i18n::fill(
                            self.t(Key::CheckoutRewardUsed),
                            &[("points", &points.to_string())],
                        ),
                        Choice::Promotion { code } => code.clone(),
                    };
                    view.child(name.to_owned())
                        .child(reviewed)
                        .child(i18n::fill(
                            self.t(Key::CheckoutRewardQuote),
                            &[
                                (
                                    "discount",
                                    &self.amount_label(
                                        i64::from(quote.discount_cents),
                                        &form.receipt.currency,
                                    ),
                                ),
                                (
                                    "total",
                                    &self.amount_label(
                                        i64::from(quote.new_total_cents),
                                        &form.receipt.currency,
                                    ),
                                ),
                            ],
                        ))
                        .when_some(quote.appointment_timing.as_ref(), |view, timing| {
                            view.child(self.checkout_reward_timing(timing))
                                .child(self.t(Key::CheckoutRewardReschedule))
                        })
                })
                .when(editor.returning, |view| {
                    view.child(self.t(Key::CheckoutRewardConfirmReturn))
                        .child(editor.input.read(cx).text().to_owned())
                })
                .when(ready, |view| {
                    view.child(self.reward_button(
                        "checkout-confirm-reward",
                        if editor.uncertain() {
                            Key::CheckoutRewardRetry
                        } else if editor.returning {
                            Key::CheckoutRewardReturn
                        } else {
                            Key::CheckoutRewardApply
                        },
                        Kind::Primary,
                        |root, cx| root.request_checkout_reward(Request::Write, cx),
                        cx,
                    ))
                })
                .when(!form.busy && !editor.uncertain(), |view| {
                    view.child(self.reward_button(
                        "checkout-reward-back",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| {
                            root.leave_checkout_reward(cx);
                        },
                        cx,
                    ))
                });
        }
        let field = if editor.returning {
            Key::LoyaltyReason
        } else if editor.kind == RewardKind::Points {
            Key::CheckoutRewardPoints
        } else {
            Key::CheckoutRewardCode
        };
        let valid = if editor.returning {
            ReturnPoints::reviewed(editor.input.read(cx).text()).is_some()
        } else {
            editor.choice(cx).is_some()
        };
        body.when(!editor.returning, |view| {
            view.when_some(editor.balance, |view, balance| {
                view.child(i18n::fill(
                    self.t(Key::CheckoutRewardBalance),
                    &[("points", &balance.to_string())],
                ))
            })
            .when(
                ready && editor.balance.is_some_and(|balance| balance > 0),
                |view| {
                    let next = if editor.kind == RewardKind::Points {
                        RewardKind::Promotion
                    } else {
                        RewardKind::Points
                    };
                    view.child(self.reward_button(
                        "checkout-reward-kind",
                        if next == RewardKind::Points {
                            Key::CheckoutRewardUsePoints
                        } else {
                            Key::CheckoutRewardUseCode
                        },
                        Kind::Ghost,
                        move |root, cx| {
                            if let Some(editor) = root
                                .reward_form()
                                .and_then(|form| form.reward_editor.as_mut())
                            {
                                editor.kind = next;
                                editor.feedback = None;
                                editor.input.update(cx, |field, cx| field.clear(cx));
                                cx.notify();
                            }
                        },
                        cx,
                    ))
                },
            )
        })
        .child(self.label(field))
        .child(editor.input.clone())
        .when(ready && valid, |view| {
            view.child(self.reward_button(
                "checkout-review-reward",
                Key::CheckoutRewardReview,
                Kind::Primary,
                Root::preview_checkout_reward,
                cx,
            ))
        })
        .when(!form.busy, |view| {
            view.child(self.reward_button(
                "checkout-reward-close",
                Key::Back,
                Kind::Ghost,
                |root, cx| {
                    root.leave_checkout_reward(cx);
                },
                cx,
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn an_unconfirmed_return_keeps_its_review_and_cannot_be_dismissed(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.status.connectivity = Connectivity::Online;
                let receipt = serde_json::from_value(json!({
                    "id": Uuid::now_v7(), "currency": "EUR", "status": "paid",
                    "totalCents": 0, "discountCents": 100, "paidCents": 0, "balanceCents": 0,
                    "payments": [], "canRefund": true, "canReturnPoints": true, "fulfilledAt": "2026-11-21T10:00:00Z",
                    "reward": { "kind": "points", "name": "Points", "pointsUsed": 100,
                      "returnedPoints": 0, "discountCents": 100, "state": "applied" }
                }))
                .unwrap();
                root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt, 0, cx));
                root.open_checkout_reward(true, cx);
                let editor = root.reward_form().unwrap().reward_editor.as_mut().unwrap();
                editor.input.update(cx, |field, cx| {
                    field.set_text("Reviewed synthetic return", cx)
                });
                root.preview_checkout_reward(cx);
                let editor = root.reward_form().unwrap().reward_editor.as_mut().unwrap();
                let review = editor.review.as_mut().unwrap();
                review.uncertain = true;
                let command = review.command.clone();
                root.dismiss_overlay(cx);
                let form = root.reward_form().unwrap();
                assert!(!form.is_idle());
                assert!(Arc::ptr_eq(
                    &form.reward_editor
                        .as_ref()
                        .unwrap()
                        .review
                        .as_ref()
                        .unwrap()
                        .command,
                    &command
                ));
                assert!(form.request.is_none());
            })
            .unwrap();
    }
}
