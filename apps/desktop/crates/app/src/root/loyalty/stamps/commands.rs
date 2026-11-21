use super::*;
use sob_core::loyalty::stamps::{Action, Change, Command, Issue};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Operation {
    Issue,
    Edit,
    IssueReward,
    Redeem,
    Void,
}

impl Operation {
    pub(super) fn label(self) -> Key {
        match self {
            Self::Issue => Key::StampIssue,
            Self::Edit => Key::StampEdit,
            Self::IssueReward => Key::StampIssueReward,
            Self::Redeem => Key::StampRedeem,
            Self::Void => Key::StampCancelCard,
        }
    }

    pub(super) fn can_apply(self, card: &Card) -> bool {
        match self {
            Self::Issue => false,
            Self::Edit => {
                card.reward_issued_at.is_none()
                    && matches!(
                        card.state,
                        State::Active | State::Queued | State::Completed | State::Expired
                    )
            }
            Self::IssueReward => card.state == State::Completed && !card.needs_review,
            Self::Redeem => card.state == State::Issued && !card.needs_review,
            Self::Void => !matches!(card.state, State::Void | State::Redeemed),
        }
    }
}

pub(super) struct Form {
    operation: Operation,
    client: Uuid,
    card: Option<Card>,
    generation: String,
    program_version: u32,
    name: String,
    goal: u32,
    stamps: Entity<TextField>,
    expiry: Entity<TextField>,
    reason: Entity<TextField>,
    original_day: String,
    command: Option<Command>,
    uncertain: bool,
}

fn expiry_date(value: DateTime<Utc>, tz: Tz) -> String {
    (value - chrono::Duration::milliseconds(1))
        .with_timezone(&tz)
        .format("%Y-%m-%d")
        .to_string()
}

fn end_of_day(value: &str, tz: Tz) -> Option<DateTime<Utc>> {
    let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    let midnight = day.succ_opt()?.and_hms_opt(0, 0, 0)?;
    // Choose the earlier boundary if midnight occurs twice.
    tz.from_local_datetime(&midnight)
        .earliest()
        .map(|value| value.with_timezone(&Utc))
}

impl Form {
    fn show_count(&self) -> bool {
        matches!(self.operation, Operation::Issue | Operation::Edit)
    }

    fn show_reason(&self) -> bool {
        matches!(self.operation, Operation::Edit | Operation::Void)
    }

    fn prepare(&self, tz: Tz, cx: &App) -> Option<Command> {
        let generation = self.generation.clone();
        let idempotency_key = Uuid::now_v7();
        let stamps = if self.show_count() {
            let raw = self.stamps.read(cx).text().trim();
            if !raw.bytes().all(|digit| digit.is_ascii_digit()) {
                return None;
            }
            raw.parse::<u32>()
                .ok()
                .filter(|count| *count <= self.goal)?
        } else {
            0
        };
        let expiry = self.expiry.read(cx).text().trim();
        let expires_at = if expiry.is_empty() {
            None
        } else if expiry == self.original_day {
            self.card.as_ref().and_then(|card| card.stamp_expires_at)
        } else {
            Some(end_of_day(expiry, tz)?)
        };
        let reason = self.reason.read(cx).text().trim();
        if self.show_reason() && !(8..=300).contains(&reason.encode_utf16().count()) {
            return None;
        }
        let Some(card) = &self.card else {
            return Some(Command::Issue(Issue {
                generation,
                idempotency_key,
                client_id: self.client,
                program_version: self.program_version,
                initial_stamps: stamps,
                expires_at,
            }));
        };
        let action = match self.operation {
            Operation::Issue => return None,
            Operation::Edit => Action::Edit {
                stamps,
                expires_at,
                reason: reason.to_owned(),
            },
            Operation::IssueReward => Action::IssueReward,
            Operation::Redeem => Action::Redeem,
            Operation::Void => Action::Void {
                reason: reason.to_owned(),
            },
        };
        Some(Command::Change(
            card.id,
            Change {
                generation,
                idempotency_key,
                version: card.version,
                action,
            },
        ))
    }

    fn valid_source(&self, list: &Cards) -> bool {
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
            let mut field = TextField::new("AAAA-MM-DD / YYYY-MM-DD", false, cx);
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
            card,
            original_day,
            command: None,
            uncertain: false,
        });
        desk.error = None;
        desk.stamps.saved = false;
        cx.notify();
    }

    pub(super) fn cancel_stamp_operation(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(desk) = self.loyalty_desk() else {
            return false;
        };
        if desk.saving || desk.stamps.form.as_ref().is_some_and(|form| form.uncertain) {
            return true;
        }
        let Some(form) = desk.stamps.form.as_mut() else {
            return false;
        };
        if form.command.take().is_none() {
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

    fn acknowledge_stamp_operation(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.request.is_none())
        else {
            return;
        };
        if desk.stamps.form.as_ref().is_some_and(|form| form.uncertain) {
            desk.stamps.form = None;
            desk.error = None;
            self.load_stamp_cards(false, cx);
            cx.notify();
        }
    }

    fn confirm_stamp_operation(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.status.connectivity == Connectivity::Online && self.directory_enabled()
        }) else {
            return;
        };
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
        desk.saving = true;
        desk.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.change_stamp_card(&command) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session)
                    || root.svc.current_session().is_none()
                    || !root.directory_enabled()
                {
                    return;
                }
                let Some(desk) = root
                    .loyalty_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                desk.saving = false;
                match result {
                    Ok(_) => {
                        desk.stamps.form = None;
                        desk.stamps.saved = true;
                        desk.stamps.cards = None;
                        root.load_stamp_cards(false, cx);
                    }
                    Err(error) => {
                        desk.delay_retry(&error);
                        let unknown = matches!(
                            error,
                            TransportError::Offline(_) | TransportError::Server(_)
                        );
                        if let Some(form) = &mut desk.stamps.form {
                            form.uncertain |= unknown;
                            if !form.uncertain {
                                form.command = None;
                            }
                        }
                        desk.error = Some(if unknown {
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
            .child(self.label(form.operation.label()))
            .child(form.name.clone());
        if form.command.is_some() {
            if form.show_count() {
                body = body.child(format!(
                    "{} · {}",
                    self.t(Key::StampCount),
                    form.stamps.read(cx).text()
                ));
                if !form.expiry.read(cx).text().trim().is_empty() {
                    body = body.child(
                        self.t(Key::StampExpiry)
                            .replace("{date}", form.expiry.read(cx).text()),
                    );
                }
            }
            if form.show_reason() {
                body = body.child(form.reason.read(cx).text().to_owned());
            }
            body = body.when(ready_to_write, |body| {
                body.child(self.loyalty_button(
                    "stamp-confirm-action",
                    if form.uncertain {
                        Key::MarketingRetry
                    } else {
                        Key::MarketingConfirm
                    },
                    Kind::Primary,
                    Root::confirm_stamp_operation,
                    cx,
                ))
            });
        } else {
            body = body
                .when(form.show_count(), |body| {
                    body.child(self.label(Key::StampCount))
                        .child(form.stamps.clone())
                        .child(self.label(Key::StampExpiryInput))
                        .child(form.expiry.clone())
                })
                .when(form.show_reason(), |body| {
                    body.child(self.label(Key::LoyaltyReason))
                        .child(form.reason.clone())
                })
                .when(ready_to_write, |body| {
                    body.child(self.loyalty_button(
                        "stamp-review-action",
                        Key::StampReviewAction,
                        Kind::Primary,
                        Root::review_stamp_operation,
                        cx,
                    ))
                });
        }
        body.when(!valid && desk.stamps.cards.is_some(), |body| {
            body.child(self.t(Key::StampStale))
        })
        .when(!desk.saving, |body| {
            if form.uncertain {
                body.child(self.loyalty_button(
                    "stamp-acknowledge",
                    Key::StampReconcile,
                    Kind::Ghost,
                    Root::acknowledge_stamp_operation,
                    cx,
                ))
            } else {
                body.child(self.loyalty_button(
                    "stamp-cancel-action",
                    Key::Back,
                    Kind::Ghost,
                    |root, cx| {
                        root.cancel_stamp_operation(cx);
                    },
                    cx,
                ))
            }
        })
    }
}
