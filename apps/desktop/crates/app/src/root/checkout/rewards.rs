use super::*;
use sob_core::loyalty::checkout::{
    Application, AppointmentTiming, Choice, Quote, ReturnPoints, RewardError, RewardKind,
};

enum Review {
    Apply(Application),
    Return(ReturnPoints),
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
    quote: Option<Quote>,
    review: Option<Arc<Review>>,
    uncertain: bool,
    retry_at: Option<Instant>,
    feedback: Option<Key>,
}

impl Editor {
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
        self.quote = None;
        self.review = None;
        self.feedback = None;
    }
}

impl Root {
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
            || form.pass_picker.is_some()
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
        form.reward_editor = Some(Editor {
            identity: Arc::new(()),
            generation,
            returning,
            kind: RewardKind::Promotion,
            input,
            _changed: changed,
            balance: None,
            quote: None,
            review: None,
            uncertain: false,
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
        if !form.busy && !editor.uncertain {
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
            !form.busy && !editor.uncertain && editor.review.is_none() && !editor.limited()
        }) else {
            return;
        };
        if editor.returning {
            if let Some(review) = ReturnPoints::reviewed(editor.input.read(cx).text()) {
                editor.review = Some(Arc::new(Review::Return(review)));
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
        let Some(form) = self.reward_form().filter(|form| !form.busy) else {
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
            editor.uncertain = false;
            editor.reset_review();
            editor.feedback = Some(Key::CheckoutRewardRestored);
            cx.notify();
            return;
        }
        let writing = matches!(request, Request::Write);
        let review = editor.review.clone();
        if writing && review.is_none() {
            return;
        }
        let generation = editor.generation.clone();
        let identity = editor.identity.clone();
        let previous = form.receipt.clone();
        let receipt = previous.clone();
        form.busy = true;
        editor.feedback = None;
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
                                Review::Apply(application) => transport.apply_checkout_reward(
                                    &receipt,
                                    application,
                                    &generation,
                                ),
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
                    Ok(Response::Balance(balance)) => editor.balance = balance,
                    Ok(Response::Quote(choice, quote)) => {
                        if let Some(review) =
                            Application::reviewed(choice, &quote, form.receipt.total_cents)
                        {
                            editor.quote = Some(quote);
                            editor.review = Some(Arc::new(Review::Apply(review)));
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
                        if editor.uncertain
                            && !matches!(
                                feedback,
                                Key::CheckoutRewardChanged | Key::CheckoutRewardRestored
                            )
                        {
                            uncertain = true;
                        }
                        editor.uncertain = uncertain;
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
        let minutes = |value: u16| format!("{:02}:{:02}", value / 60, value % 60);
        let days = condition
            .timing
            .weekdays
            .iter()
            .filter_map(|&day| {
                let weekdays = [
                    chrono::Weekday::Mon,
                    chrono::Weekday::Tue,
                    chrono::Weekday::Wed,
                    chrono::Weekday::Thu,
                    chrono::Weekday::Fri,
                    chrono::Weekday::Sat,
                    chrono::Weekday::Sun,
                ];
                weekdays
                    .get(usize::from(day).checked_sub(1)?)
                    .map(|&day| i18n::weekday_short(self.locale, day))
            })
            .collect::<Vec<_>>()
            .join(", ");
        let hours = format!(
            "{days} · {}–{} · {}",
            minutes(condition.timing.start_minute),
            minutes(condition.timing.end_minute),
            condition.time_zone
        );
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
        let ready = online && form.is_idle() && !form.refreshing && form.pass_picker.is_none();
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
        let ready = online && !form.busy;
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
        if editor.review.is_some() {
            return body
                .when_some(editor.quote.as_ref(), |view, quote| {
                    let name = if quote.kind == RewardKind::Points {
                        self.t(Key::CheckoutRewardPoints)
                    } else {
                        &quote.name
                    };
                    view.child(name.to_owned())
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
                        })
                })
                .when(editor.returning, |view| {
                    view.child(self.t(Key::CheckoutRewardConfirmReturn))
                        .child(editor.input.read(cx).text().to_owned())
                })
                .when(ready, |view| {
                    view.child(self.reward_button(
                        "checkout-confirm-reward",
                        if editor.uncertain {
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
                .when(!form.busy && !editor.uncertain, |view| {
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
                    "payments": [], "canRefund": true, "fulfilledAt": "2026-11-21T10:00:00Z",
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
                let review = editor.review.clone().unwrap();
                editor.uncertain = true;
                root.dismiss_overlay(cx);
                let form = root.reward_form().unwrap();
                assert!(!form.is_idle());
                assert!(Arc::ptr_eq(
                    form.reward_editor
                        .as_ref()
                        .unwrap()
                        .review
                        .as_ref()
                        .unwrap(),
                    &review
                ));
                assert!(form.request.is_none());
            })
            .unwrap();
    }
}
