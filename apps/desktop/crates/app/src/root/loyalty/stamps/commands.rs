use super::*;
use sob_core::loyalty::stamps::{Command, Draft, Operation, Reward, expiry_date};
use std::sync::Arc;

pub(super) fn operation_label(operation: Operation) -> Key {
    match operation {
        Operation::Issue => Key::StampIssue,
        Operation::Edit => Key::StampEdit,
        Operation::IssueReward => Key::StampIssueReward,
        Operation::Redeem => Key::StampRedeem,
        Operation::Void => Key::StampCancelCard,
    }
}

#[derive(Clone)]
pub(super) struct Form {
    operation: Operation,
    pub(super) client: Uuid,
    card: Option<Card>,
    generation: String,
    program_version: u32,
    name: String,
    goal: u32,
    stamps: Entity<TextField>,
    expiry: Entity<TextField>,
    reason: Entity<TextField>,
    reward: Reward,
    command: Option<Command>,
    pub(super) uncertain: bool,
}

impl Form {
    fn prepare(&self, tz: Tz, cx: &App) -> Option<Command> {
        Draft {
            operation: self.operation,
            client: self.client,
            card: self.card.as_ref(),
            generation: &self.generation,
            program_version: self.program_version,
            goal: self.goal,
            stamps: self.stamps.read(cx).text(),
            expiry: self.expiry.read(cx).text(),
            reason: self.reason.read(cx).text(),
        }
        .prepare(tz)
    }

    pub(super) fn must_reconcile(&self, cards: Option<&Cards>) -> bool {
        self.uncertain && !cards.is_some_and(|cards| cards.generation != self.generation)
    }

    pub(super) fn valid_source(&self, list: &Cards) -> bool {
        list.can_edit
            && list.generation == self.generation
            && (self.uncertain
                || match &self.card {
                    Some(card) => list.cards.iter().any(|record| {
                        record.id == card.id
                            && record.version == card.version
                            && self.operation.can_apply(record)
                    }),
                    None => list.program_version == self.program_version && can_issue(list),
                })
    }
}

pub(super) fn can_issue(list: &Cards) -> bool {
    list.program.enabled
        && !list
            .cards
            .iter()
            .any(|card| matches!(card.state, State::Active | State::Queued))
}

impl Root {
    pub(super) fn select_stamp_operation(
        &mut self,
        operation: Operation,
        id: Option<Uuid>,
        cx: &mut Context<Self>,
    ) {
        if self.pending_stamp().is_some() {
            return;
        }
        let tz = self.tz;
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.request.is_none() && desk.stamps.form.is_none())
        else {
            return;
        };
        let Some(&(client, _)) = desk.selected.as_ref() else {
            return;
        };
        let Some(list) = desk.stamps.cards.as_ref().filter(|list| list.can_edit) else {
            return;
        };
        let card = match id {
            Some(id) => {
                let Some(card) = list
                    .cards
                    .iter()
                    .find(|card| card.id == id && operation.can_apply(card))
                else {
                    return;
                };
                Some(card.clone())
            }
            None if operation == Operation::Issue && can_issue(list) => None,
            None => return,
        };
        let program = card.as_ref().map_or(&list.program, |card| &card.program);
        let count = card
            .as_ref()
            .map_or(program.welcome_stamps, |card| card.stamps);
        let original_day = card
            .as_ref()
            .and_then(|card| card.stamp_expires_at)
            .map(|expiry| expiry_date(expiry, tz))
            .unwrap_or_default();
        let stamps = cx.new(|cx| {
            let mut field = TextField::new("", false, cx);
            field.set_text(&count.to_string(), cx);
            field
        });
        let expiry = cx.new(|cx| {
            let mut field = TextField::new("", false, cx);
            field.set_text(&original_day, cx);
            field
        });
        desk.stamps.form = Some(Form {
            operation,
            client,
            generation: list.generation.clone(),
            program_version: list.program_version,
            name: program.name.clone(),
            goal: program.goal,
            stamps,
            expiry,
            reason: cx.new(|cx| TextField::new("", false, cx)),
            reward: program.reward.clone(),
            card,
            command: None,
            uncertain: false,
        });
        desk.error = None;
        desk.stamps.saved_generation = None;
        cx.notify();
    }

    pub(super) fn cancel_stamp_operation(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(desk) = self.loyalty_desk() else {
            return false;
        };
        if desk.saving
            || desk
                .stamps
                .form
                .as_ref()
                .is_some_and(|form| form.must_reconcile(desk.stamps.cards.as_ref()))
        {
            return true;
        }
        let Some(form) = desk.stamps.form.as_mut() else {
            return false;
        };
        if form.command.take().is_none() || form.uncertain {
            desk.stamps.form = None;
        }
        desk.error = None;
        cx.notify();
        true
    }

    fn review_stamp_operation(&mut self, cx: &mut Context<Self>) {
        let tz = self.tz;
        let Some(desk) = self.loyalty_desk() else {
            return;
        };
        let (Some(form), Some(source)) = (desk.stamps.form.as_mut(), desk.stamps.cards.as_ref())
        else {
            return;
        };
        if !form.valid_source(source) || desk.saving || form.command.is_some() {
            return;
        }
        form.command = form.prepare(tz, cx);
        desk.error = form.command.is_none().then_some(Key::StampInvalid);
        cx.notify();
    }

    pub(super) fn confirm_stamp_operation(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.status.connectivity == Connectivity::Online && self.directory_enabled()
        }) else {
            return;
        };
        if self.pending_stamp().is_some() {
            return;
        }
        let session = self.svc.session.clone();
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.request.is_none() && !desk.rate_limited())
        else {
            return;
        };
        let (Some(form), Some(list)) = (desk.stamps.form.as_ref(), desk.stamps.cards.as_ref())
        else {
            return;
        };
        let Some(command) = form.command.clone().filter(|_| form.valid_source(list)) else {
            return;
        };
        let identity = desk.identity.clone();
        let generation = form.generation.clone();
        let pending = PendingStamp {
            session: session.clone(),
            form: form.clone(),
            resolving: true,
        };
        desk.saving = true;
        desk.error = None;
        self.pending_stamp = Some(pending);
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.change_stamp_card(&command) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let pending = root.pending_stamp.take();
                let unknown = matches!(
                    result,
                    Err(TransportError::Offline(_) | TransportError::Server(_))
                );
                if !root.directory_enabled()
                    || !root
                        .loyalty_desk()
                        .is_some_and(|desk| Arc::ptr_eq(&identity, &desk.identity))
                {
                    if let Some(mut pending) = pending
                        .filter(|pending| result.is_err() && (pending.form.uncertain || unknown))
                    {
                        pending.form.uncertain = true;
                        pending.resolving = false;
                        root.pending_stamp = Some(pending);
                    }
                    cx.notify();
                    return;
                }
                let Some(desk) = root.loyalty_desk() else {
                    return;
                };
                desk.saving = false;
                match result {
                    Ok(_) => {
                        desk.stamps.form = None;
                        desk.stamps.saved_generation = Some(generation);
                        desk.stamps.cards = None;
                        root.load_stamp_cards(false, cx);
                    }
                    Err(error) => {
                        desk.delay_retry(&error);
                        let unresolved = desk.stamps.form.as_mut().is_some_and(|form| {
                            form.uncertain |= unknown;
                            if !form.uncertain {
                                form.command = None;
                            }
                            form.uncertain
                        });
                        desk.error = Some(if unresolved {
                            Key::StampUnconfirmed
                        } else {
                            Key::StampRejected
                        });
                        root.load_stamp_cards(true, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_stamp_command(
        &self,
        form: &Form,
        desk: &Desk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let valid = desk
            .stamps
            .cards
            .as_ref()
            .is_some_and(|list| form.valid_source(list));
        let ready_to_write = ready && valid && desk.request.is_none();
        let mut body = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(operation_label(form.operation)))
            .child(form.name.clone())
            .child(self.render_stamp_reward(&form.reward));
        if form.command.is_some() {
            if form.operation.show_count() {
                body = body.child(format!(
                    "{} · {}",
                    self.t(Key::StampCount),
                    form.stamps.read(cx).text()
                ));
                let expiry = form.expiry.read(cx).text().trim();
                body = body.child(if !expiry.is_empty() {
                    self.t(Key::StampExpiry).replace("{date}", expiry)
                } else {
                    self.t(if form.operation == Operation::Issue {
                        Key::StampDefaultExpiry
                    } else {
                        Key::StampNoExpiry
                    })
                    .to_owned()
                });
            }
            if form.operation.show_reason() {
                body = body.child(form.reason.read(cx).text().to_owned());
            }
            body = body.when(ready_to_write, |body| {
                body.child(
                    self.loyalty_button(
                        "stamp-confirm-action",
                        if form.uncertain {
                            Key::MarketingRetry
                        } else {
                            Key::MarketingConfirm
                        },
                        Kind::Primary,
                        Root::confirm_stamp_operation,
                        cx,
                    )
                    .debug_selector(|| "stamp-confirm-action".to_owned()),
                )
            });
        } else {
            body = body
                .when(form.operation.show_count(), |body| {
                    body.child(self.label(Key::StampCount))
                        .child(form.stamps.clone())
                        .child(self.label(Key::StampExpiryInput))
                        .child(form.expiry.clone())
                        .child(self.t(if form.operation == Operation::Issue {
                            Key::StampDefaultExpiry
                        } else {
                            Key::StampNoExpiry
                        }))
                })
                .when(form.operation.show_reason(), |body| {
                    body.child(self.label(Key::LoyaltyReason))
                        .child(form.reason.clone())
                })
                .when(ready_to_write, |body| {
                    body.child(
                        self.loyalty_button(
                            "stamp-review-action",
                            Key::StampReviewAction,
                            Kind::Primary,
                            Root::review_stamp_operation,
                            cx,
                        )
                        .debug_selector(|| "stamp-review-action".to_owned()),
                    )
                });
        }
        body.when(!valid && desk.stamps.cards.is_some(), |body| {
            body.child(self.t(Key::StampStale))
        })
        .when(
            !desk.saving && !form.must_reconcile(desk.stamps.cards.as_ref()),
            |body| {
                body.child(
                    self.loyalty_button(
                        "stamp-cancel-action",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| {
                            root.cancel_stamp_operation(cx);
                        },
                        cx,
                    )
                    .debug_selector(|| "stamp-cancel-action".to_owned()),
                )
            },
        )
    }
}
